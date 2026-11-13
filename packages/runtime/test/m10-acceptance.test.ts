/**
 * M10 验收测试（总工程师独立编写）：差分 TUI（ADR-020）。
 *
 * 可自动断言的部分（**纯函数 + 假 tty**）：
 *  - **显示列宽**：全角/emoji 占 2 列、组合字符占 0 列、ANSI 不占列；截断不切半个宽字符；
 *  - **行级差分**：相同帧**一个字节都不写**；中间某行变化**只重绘该区段**（其余行的文本不得再出现）；
 *    宽度变化 → 全量重绘；每帧都被 `ESC[?2026h … ESC[?2026l` 包裹；
 *  - **布局**：帧恰好 `rows` 行、视图下对齐、状态条含 mode/cwd/会话 id、输入行带 `›` 前缀、可滚动；
 *  - **按键解码**：UTF-8 跨分片、方向键、退格、Ctrl+C/D；行编辑按**字符**（宽字符不被切半）；
 *  - **语义配色**：工具结果按成败上 ok/err 色、横幅压成 muted、正文保持默认前景；`NO_COLOR` 全关；
 *  - **应用层（假 tty 驱动真实 `runSessionRepl`）**：alt screen 进入并**必定还原**；
 *    回车输入经既有 REPL 真实落 `user/message`；后续帧若只改输入行，**不会重画横幅**（证明差分生效）。
 *
 * 不可自动断言的部分（诚实标注）：**好不好看**只能由用户肉眼验收——本测试只保证"结构、行为、
 * 还原、不闪（差分）"这些可证伪的性质。
 */
import { EventEmitter } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { createStubProvider } from "../src/llm/index.js";
import { createSessionStore } from "../src/persist/index.js";
import {
	ansi,
	appendText,
	applyEdit,
	compose,
	createKeyDecoder,
	createScreen,
	createTheme,
	type EditState,
	formatLine,
	isTuiSupported,
	type KeyEvent,
	planDiff,
	renderFrame,
	runTuiSession,
	truncateToWidth,
	visibleWidth,
	wrapToWidth,
} from "../src/tui/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const plain = createTheme({ disabled: true });
const colored = createTheme({ colorTerm: "truecolor" });
const index = createTheme({ colorTerm: "" });

const SYNC_BEGIN = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";

describe("M10 显示列宽（全角 / emoji / 组合字符 / ANSI）", () => {
	it("按显示列而非字符串长度计宽，并忽略 ANSI", () => {
		expect(visibleWidth("abc")).toBe(3);
		expect(visibleWidth("中文")).toBe(4); // 全角 2 列
		expect(visibleWidth("a中b")).toBe(4);
		expect(visibleWidth("\u001b[31mred\u001b[0m")).toBe(3); // ANSI 不占列
		expect(visibleWidth("e\u0301")).toBe(1); // 组合字符占 0 列
		expect(visibleWidth("🚀")).toBe(2); // emoji 占 2 列
	});

	it("截断不把宽字符切一半，并补重置码", () => {
		expect(truncateToWidth("中文字", 5)).toBe("中文\u001b[0m"); // 5 列放不下第 3 个全角字
		expect(truncateToWidth("abc", 5)).toBe("abc");
		expect(truncateToWidth("中", 1)).toBe("\u001b[0m");
	});

	it("硬换行按列宽切分，且每行自闭合", () => {
		const lines = wrapToWidth("中文中文", 4);
		expect(lines).toEqual(["中文\u001b[0m", "中文\u001b[0m"]);
		expect(wrapToWidth("a\nb", 10)).toEqual(["a\u001b[0m", "b\u001b[0m"]);
	});
});

describe("M10 行级差分重绘（ADR-020 的核心）", () => {
	it("两帧完全相同 -> 一个字节都不写", () => {
		const frame = ["a", "b", "c"];
		const diff = planDiff(frame, frame, false);
		expect(diff.kind).toBe("none");
		expect(renderFrame(diff, frame)).toBe("");
	});

	it("中间某行变化 -> 只重绘该区段（未变化的行不得再出现）", () => {
		const previous = ["banner", "line-2", "line-3", "input"];
		const next = ["banner", "line-2-changed", "line-3", "input"];
		const diff = planDiff(previous, next, false);
		expect(diff).toMatchObject({ kind: "partial", from: 1, to: 1 });
		const text = renderFrame(diff, next);
		expect(text.startsWith(SYNC_BEGIN)).toBe(true);
		expect(text.endsWith(SYNC_END)).toBe(true);
		expect(text).toContain("line-2-changed");
		expect(text).not.toContain("banner"); // 未变化行没有被重画（这就是"不闪"的机制）
		expect(text).not.toContain("input");
		expect(text).toContain("\u001b[2A"); // 光标从末行（row 3）上移 2 行到变更区段（row 1）
	});

	it("新增行 -> 向下续写；删除行 -> 清掉尾行并把光标收回末行", () => {
		const grown = planDiff(["a", "b"], ["a", "b", "c"], false);
		expect(grown).toMatchObject({ kind: "partial", from: 2, to: 2 });
		expect(renderFrame(grown, ["a", "b", "c"])).toContain("c");

		const shrunk = planDiff(["a", "b", "c"], ["a", "b"], false);
		expect(shrunk).toMatchObject({ kind: "partial", from: 2, to: 2 });
		const text = renderFrame(shrunk, ["a", "b"]);
		expect(text).toContain("\u001b[2K"); // 清掉多余行
		expect(text).toContain("\u001b[1A"); // 光标回到末行（不变量）
	});

	it("宽度变化 -> 全量重绘（换行位置全变，差分无意义）", () => {
		const diff = planDiff(["a", "b"], ["x", "y"], true);
		expect(diff.kind).toBe("full");
		expect(renderFrame(diff, ["x", "y"])).toContain(ansi.clearScreen);
	});
});

describe("M10 布局与配色（纯函数，可逐行断言）", () => {
	const baseState = {
		status: { mode: "build", cwd: "D:\\repo", model: "m", sessionId: "ses_1" },
		transcript: ["line-1", "line-2"],
		input: "hi",
		caret: 2,
		scrollOffset: 0,
	};

	it("帧恰好 rows 行；视图下对齐（顶部补空行）；输入行带前缀", () => {
		const frame = compose(baseState, 40, 8, plain);
		expect(frame).toHaveLength(8);
		expect(frame[0]).toContain("aster");
		expect(frame[0]).toContain("build");
		expect(frame[0]).toContain("ses_1");
		expect(frame[7]).toBe("› hi");
		expect(frame[6]).toBe("line-2"); // 贴底
		expect(frame[5]).toBe("line-1");
		expect(frame[2]).toBe(""); // 顶部留白
	});

	it("滚动偏移把窗口往上移；滚动到底则贴底", () => {
		const many = Array.from({ length: 12 }, (_, i) => `L${i}`);
		const scrolled = compose({ ...baseState, transcript: many, scrollOffset: 3 }, 40, 6, plain);
		expect(scrolled[5]).toBe("› hi");
		expect(scrolled[4]).toBe("L8"); // 12 - 3 = 9(不含)，末行是 L8
		expect(scrolled[2]).toBe("L6");
	});

	it("宽字符按列截断（不会因全角而溢出布局）", () => {
		const frame = compose({ ...baseState, transcript: ["中文中文中文中文"] }, 10, 6, plain);
		expect(visibleWidth(frame[4] as string)).toBeLessThanOrEqual(10);
	});

	it("语义配色：横幅压 muted、正文保持默认、**事实行不走文本嗅探**（ADR-023）；NO_COLOR 时全关", () => {
		// ADR-023 收紧职责：会话事实（tool_call / tool_result / mode …）改由 `describeEvent`
		// 按**事件**上色（见 `m10b-acceptance`），`formatLine` 不再嗅探它们 —— 本文件只钉"不再嗅探"。
		expect(formatLine("  → tool_call: read", colored)).toBe("  → tool_call: read");
		expect(formatLine("  ← tool_result: bash ok", colored)).toBe("  ← tool_result: bash ok");
		expect(formatLine("session: ses_1", colored)).toContain("\u001b[38;2;138;145;155m"); // 横幅 → muted
		expect(formatLine("  普通正文", colored)).toBe("  普通正文"); // 正文不上色
		expect(formatLine("  普通正文", plain)).toBe("  普通正文");
		expect(formatLine("session: ses_1", plain)).toBe("session: ses_1"); // NO_COLOR：完全不上色

		// 256 色终端退到色卡索引
		expect(index.paint("accent", "x")).toBe("\u001b[38;5;111mx\u001b[0m");
		expect(createTheme({ noColor: true }).colored).toBe(false);
		expect(plain.paint("accent", "x")).toBe("x");
	});

	it("会话行拼接：半行累积、完整行换行（流式输出不会串行）", () => {
		expect(appendText([""], "abc")).toEqual(["abc"]);
		expect(appendText(["abc"], "def")).toEqual(["abcdef"]);
		expect(appendText(["abc"], "def\nghi")).toEqual(["abcdef", "ghi"]);
		expect(appendText(["abc"], "\n")).toEqual(["abc", ""]);
	});
});

describe("M10 按键解码与行编辑", () => {
	function decodeAll(chunks: readonly (string | Buffer)[]): KeyEvent[] {
		const decoder = createKeyDecoder();
		return chunks.flatMap((chunk) => decoder.push(chunk));
	}

	it("方向键 / 退格 / 控制键；未知 ESC 序列被整体吞掉（不漏垃圾字符）", () => {
		expect(decodeAll(["\u001b[A", "\u001b[B", "\u001b[C", "\u001b[D"])).toEqual([
			{ kind: "up" },
			{ kind: "down" },
			{ kind: "right" },
			{ kind: "left" },
		]);
		expect(decodeAll(["\u001b[5~", "\u001b[6~"])).toEqual([
			{ kind: "page-up" },
			{ kind: "page-down" },
		]);
		expect(decodeAll(["\u007f"])).toEqual([{ kind: "backspace" }]);
		expect(decodeAll(["\u0003"])).toEqual([{ kind: "interrupt" }]);
		expect(decodeAll(["\u0004"])).toEqual([{ kind: "eof" }]);
		expect(decodeAll(["\u001b[1;5A", "x"])).toEqual([
			{ kind: "unknown" },
			{ kind: "text", text: "x" },
		]);
	});

	it("UTF-8 跨分片：中文被切成两半也不会漏字或错位", () => {
		const bytes = Buffer.from("中文", "utf8");
		const decoder = createKeyDecoder();
		expect(decoder.push(bytes.subarray(0, 4))).toEqual([{ kind: "text", text: "中" }]);
		expect(decoder.pending()).toBe(1); // 剩下"文"的第 1 个字节
		expect(decoder.push(bytes.subarray(4))).toEqual([{ kind: "text", text: "文" }]);
		expect(decoder.pending()).toBe(0);
		// ESC 序列跨分片同理
		const decoder2 = createKeyDecoder();
		expect(decoder2.push("\u001b")).toEqual([]);
		expect(decoder2.push("[A")).toEqual([{ kind: "up" }]);
	});

	it("编辑按字符（宽字符不被切半）：插字 / 退格 / 左右 / 删字 / 清行", () => {
		let state: EditState = { text: "中文", caret: 2 };
		state = applyEdit(state, { kind: "backspace" });
		expect(state).toEqual({ text: "中", caret: 1 });
		state = applyEdit(state, { kind: "text", text: "x" });
		expect(state).toEqual({ text: "中x", caret: 2 });
		state = applyEdit(state, { kind: "left" });
		expect(applyEdit(state, { kind: "delete" })).toEqual({ text: "中", caret: 1 });
		expect(applyEdit(state, { kind: "home" })).toEqual({ text: "中x", caret: 0 });
		expect(applyEdit(state, { kind: "end" })).toEqual({ text: "中x", caret: 2 });
		expect(applyEdit(state, { kind: "clear-line" })).toEqual({ text: "", caret: 0 });
		expect(applyEdit({ text: "", caret: 0 }, { kind: "backspace" })).toEqual({
			text: "",
			caret: 0,
		});
	});
});

describe("M10 合帧调度（16ms）与屏幕", () => {
	it("多次 requestRender 合并成一帧；flush 立即画；无变化不写字节", () => {
		const written: string[] = [];
		const screen = createScreen({
			sink: { write: (text) => written.push(text) },
			theme: plain,
			size: () => ({ columns: 40, rows: 6 }),
			intervalMs: 0,
			initial: {
				status: { mode: "plan", cwd: "D:\\r", sessionId: "ses" },
				transcript: ["a"],
				input: "",
				caret: 0,
				scrollOffset: 0,
			},
		});
		screen.flush();
		expect(written).toHaveLength(1);
		const first = written[0] as string;
		expect(first).toContain("a");

		// 无变化 -> 一个字节都不写
		screen.flush();
		expect(written).toHaveLength(1);

		// 只改输入行 -> 第二次输出不得包含横幅/会话行
		screen.update({ input: "h", caret: 1 });
		screen.flush();
		expect(written).toHaveLength(2);
		const second = written[1] as string;
		expect(second).toContain("› h");
		expect(second).not.toContain("aster");
		expect(second).not.toContain("ses");
	});
});

/** 假 tty：只实现 TUI 真正用到的那几件（`write` / 尺寸 / `on("resize")`）。 */
class FakeStdout extends EventEmitter {
	columns = 60;
	rows = 12;
	readonly chunks: string[] = [];
	write(text: string): void {
		this.chunks.push(text);
	}
	get text(): string {
		return this.chunks.join("");
	}
}

class FakeStdin extends EventEmitter {
	rawModeCalls: boolean[] = [];
	setRawMode(mode: boolean): void {
		this.rawModeCalls.push(mode);
	}
	/** 模拟用户按键（直接投喂字节）。 */
	type(text: string): void {
		this.emit("data", Buffer.from(text, "utf8"));
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
		await delay(5);
	}
}

describe("M10 应用层：假 tty 驱动真实 REPL（alt screen 还原 + 差分 + 真实落事件）", () => {
	it("回车输入真实落 user/message；退出时离开 alt screen 并恢复 raw mode；重绘不含横幅", async () => {
		const home = newTemp("aster-m10-home-");
		const cwd = newTemp("aster-m10-cwd-");
		const stdout = new FakeStdout();
		const stdin = new FakeStdin();
		const lines: string[] = [];

		const session = runTuiSession({
			home,
			cwd,
			mode: "plan",
			input: stdin as never,
			sink: stdout as never,
			keys: stdin as never,
			theme: plain,
			intervalMs: 0,
			provider: createStubProvider([
				{ content: "STUB-REPLY", toolCalls: [], stopReason: "end_turn" },
			]),
			model: "stub-model",
			output: { write: (text) => lines.push(text) },
		});

		// 首屏已经画出来（含 alt screen 进入）
		await waitFor(() => stdout.text.includes("› "));
		expect(stdout.text).toContain("\u001b[?1049h");
		expect(stdin.rawModeCalls).toContain(true);

		// 用户输入一行并回车（走原有 REPL 路径：parse -> runTurn）
		const beforeSubmit = stdout.chunks.length;
		stdin.type("hi\r");
		await waitFor(() => stdout.text.includes("STUB-REPLY"));

		// 差分生效：回车那次渲染之后的片段里**不应**再出现状态条（未变化的部分没被重画）
		const delta = stdout.chunks.slice(beforeSubmit).join("");
		expect(delta).toContain("STUB-REPLY");
		expect(delta).not.toContain("aster ·"); // 状态条在这批增量里没有被重画

		// Ctrl+D -> EOF -> readline 关闭 -> REPL 收尾（落 session/end）
		stdin.type("\u0004");
		const result = await session;
		expect(result.eventCount).toBeGreaterThan(0);

		// alt screen 必定还原 + raw mode 已关
		expect(stdout.text).toContain("\u001b[?1049l");
		expect(stdin.rawModeCalls.at(-1)).toBe(false);

		// 会话事实源里真的有一条 user/message
		const store = createSessionStore({ home });
		const metas = await store.list();
		await store.dispose();
		const events = readFileSync(join(home, "sessions", `${metas[0]?.sessionId}.jsonl`), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as SessionEvent);
		expect(
			events.some((event) => event.type === "user/message" && event.payload.content === "hi"),
		).toBe(true);
	});

	it("Ctrl+C 合成 SIGINT：沿用 REPL 语义（二次退出），并仍然还原 alt screen", async () => {
		const stdout = new FakeStdout();
		const stdin = new FakeStdin();
		const session = runTuiSession({
			home: newTemp("aster-m10-cc-home-"),
			cwd: newTemp("aster-m10-cc-cwd-"),
			input: stdin as never,
			sink: stdout as never,
			keys: stdin as never,
			theme: plain,
			intervalMs: 0,
			provider: createStubProvider([{ content: "unused", toolCalls: [], stopReason: "end_turn" }]),
			model: "stub-model",
			output: { write: () => undefined },
		});
		await waitFor(() => stdout.text.includes("› "));
		// 等到横幅写完（= REPL 已经走到注册 SIGINT 那一步），避免测试在早期竞态
		await waitFor(() => stdout.text.includes("llm provider"));
		await delay(30);
		stdin.type("\u0003"); // 第一次：REPL 打印 (exit) 并关闭 readline
		const result = await session;
		expect(result.sessionId).toBeTruthy();
		expect(stdout.text).toContain("(exit)");
		expect(stdout.text).toContain("\u001b[?1049l");
	});

	it("非 TTY 回落开关存在：`isTuiSupported()` 是布尔判定，CLI 参数可解析", () => {
		expect(typeof isTuiSupported()).toBe("boolean");
		expect(parseArgs(["--tui", "--no-color"])).toMatchObject({ tui: true, noColor: true });
	});
});
