/**
 * M10b-3 验收测试（总工程师独立编写）：多行编辑器（ADR-025）。
 *
 * 覆盖：
 *  - **几何（纯函数 `editor.ts`）**：逻辑行/光标行、显示列（全角 2 列）、点击列→字符、
 *    垂直移动（跨行保字符偏移、边界返回 `undefined`）、输入区窗口**跟随光标**；
 *  - **解码（纯函数 `input.ts`）**：`Ctrl+J` / `Alt+Enter` / CSI-u / modifyOtherKeys → `newline`；
 *    括号粘贴 `ESC[200~ … ESC[201~` 整段为一个 `paste`（**跨分片**也是**一个**事件）；
 *    Home/End 变**行首/行尾**；`Ctrl+U` 清空**整份草稿**；
 *  - **帧与差分（纯函数）**：多行草稿下帧**仍恰好 `rows` 行**、输入区占 N 行、视图相应收缩；
 *    `caretPosition` 落在正确的行/列；`renderFrame` 能把光标停在**非末行**；
 *    `renderCaretMove` 处理"帧不变但光标动"（M10 的潜在缺陷）；
 *  - **应用层（假 tty 驱动真实 REPL）**：粘贴多行 → 草稿**不被提交**，按 Enter 后**只落一条**
 *    `user/message`（内容含换行），且转录区按**多行**渲染；括号粘贴/鼠标上报**成对关闭**。
 */
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyEdit,
	caretPosition,
	charIndexAtColumn,
	compose,
	createKeyDecoder,
	createScreen,
	createTheme,
	layoutEditor,
	lineStarts,
	MAX_INPUT_ROWS,
	moveVertical,
	planDiff,
	renderCaretMove,
	renderFrame,
	runTuiSession,
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
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
		await delay(5);
	}
}

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
	setRawMode(): void {}
	type(text: string): void {
		this.emit("data", Buffer.from(text, "utf8"));
	}
}

/** 读该 home 下**唯一**会话的 JSONL。 */
function readSession(home: string): SessionEvent[] {
	const dir = join(home, "sessions");
	const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
	if (file === undefined) throw new Error("no session file");
	return readFileSync(join(dir, file), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

describe("M10b-3 编辑器几何（纯函数）", () => {
	it("逻辑行 / 光标行 / 显示列（全角按 2 列）", () => {
		expect(layoutEditor("hi", 2, { maxRows: 8 })).toMatchObject({
			lines: ["hi"],
			row: 0,
			column: 2,
			total: 1,
		});
		// caret 5 = 第 2 行（"中x"）内偏移 2 → 显示列 = '中'(2) + 'x'(1) = 3
		const multi = layoutEditor("ab\n中x\nc", 5, { maxRows: 8 });
		expect(multi.lines).toEqual(["ab", "中x", "c"]);
		expect(multi.row).toBe(1);
		expect(multi.column).toBe(3);
		expect(multi.total).toBe(3);
		expect(lineStarts(["ab", "中x", "c"])).toEqual([0, 3, 6]);
	});

	it("点击列 → 字符下标（落在字符边界上，绝不把全角切一半）", () => {
		expect(charIndexAtColumn("abcd", 0)).toBe(0);
		expect(charIndexAtColumn("abcd", 2)).toBe(2);
		expect(charIndexAtColumn("abcd", 99)).toBe(4); // 越界 → 行尾
		expect(charIndexAtColumn("中文", 1)).toBe(0); // 第一个全角字的左半 → 归到它的**左边界**
		expect(charIndexAtColumn("中文", 2)).toBe(1); // 第一个全角字之后
		expect(charIndexAtColumn("中文", 3)).toBe(1); // 第二个字的左半 → 仍在边界（不切半个字）
		expect(charIndexAtColumn("中文", 4)).toBe(2); // 第二个全角字之后
		expect(charIndexAtColumn("中文", 99)).toBe(2);
	});

	it("垂直移动：跨行保字符偏移；到草稿边界返回 undefined（调用方据此翻历史）", () => {
		const text = "abcd\nxy\nz"; // 行首：[0, 5, 8]
		expect(moveVertical(text, 2, 1)).toBe(7); // 行内偏移 2 → 下一行行首 5 + min(2, len 2)
		expect(moveVertical(text, 3, 1)).toBe(7); // 偏移 3 被夹到下一行长度 2
		expect(moveVertical(text, 5, 1)).toBe(8); // 从 "xy" 行首下到 "z" 行首（偏移 0）
		expect(moveVertical(text, 8, 1)).toBeUndefined(); // 已在最后一行
		expect(moveVertical(text, 1, -1)).toBeUndefined(); // 已在第一行
		expect(moveVertical("only", 2, 1)).toBeUndefined(); // 单行草稿 ⇒ 交给历史
	});

	it("输入区窗口**跟随光标**（草稿超过上限时上滚，光标仍可见）", () => {
		const text = Array.from({ length: MAX_INPUT_ROWS + 4 }, (_, index) => `L${index}`).join("\n");
		const tail = layoutEditor(text, text.length, { maxRows: MAX_INPUT_ROWS });
		expect(tail.lines).toHaveLength(MAX_INPUT_ROWS);
		expect(tail.row).toBe(MAX_INPUT_ROWS - 1);
		expect(tail.lines.at(-1)).toBe(`L${MAX_INPUT_ROWS + 3}`);

		const head = layoutEditor(text, 0, { maxRows: MAX_INPUT_ROWS });
		expect(head.firstVisible).toBe(0);
		expect(head.row).toBe(0);
	});
});

describe("M10b-3 解码（纯函数）：换行键与括号粘贴", () => {
	function decodeAll(chunks: readonly (string | Buffer)[]) {
		const decoder = createKeyDecoder();
		return chunks.flatMap((chunk) => decoder.push(chunk));
	}

	it("Ctrl+J / Alt+Enter / CSI-u / modifyOtherKeys → newline；Enter 仍是 enter", () => {
		expect(decodeAll(["\n"])).toEqual([{ kind: "newline" }]); // Ctrl+J
		expect(decodeAll(["\u001b\r"])).toEqual([{ kind: "newline" }]); // Alt+Enter
		expect(decodeAll(["\u001b[13;2u"])).toEqual([{ kind: "newline" }]); // Shift+Enter（CSI-u）
		expect(decodeAll(["\u001b[27;2;13~"])).toEqual([{ kind: "newline" }]); // modifyOtherKeys
		expect(decodeAll(["\r"])).toEqual([{ kind: "enter" }]);
	});

	it("括号粘贴：整段是**一个** paste 事件（含换行）；跨分片仍是**一个**", () => {
		expect(decodeAll([`${PASTE_START}a\nb\nc${PASTE_END}`])).toEqual([
			{ kind: "paste", text: "a\nb\nc" },
		]);

		const decoder = createKeyDecoder();
		expect(decoder.push(`${PASTE_START}a\nb`)).toEqual([]); // 未到终止标记：先攒着
		expect(decoder.push(`\nc${PASTE_END}`)).toEqual([{ kind: "paste", text: "a\nb\nc" }]);
		expect(decoder.pending()).toBe(0);
		expect(decoder.push("\r")).toEqual([{ kind: "enter" }]); // 粘贴后照常解析
	});

	it("多行草稿：Home/End 是**行首/行尾**；Ctrl+U 清空**整份草稿**", () => {
		const state = { text: "ab\n中x\nc", caret: 5 }; // 行首 [0,3,6]；caret 5 = 第 2 行（"中x"）的**行尾**
		expect(applyEdit(state, { kind: "home" })).toEqual({ text: state.text, caret: 3 });
		expect(applyEdit(state, { kind: "end" })).toEqual({ text: state.text, caret: 5 });
		expect(applyEdit({ ...state, caret: 4 }, { kind: "end" })).toEqual({
			text: state.text,
			caret: 5,
		});
		expect(applyEdit(state, { kind: "clear-line" })).toEqual({ text: "", caret: 0 });
		// 换行插入按**字符**（宽字符不被切半）
		expect(applyEdit({ text: "中", caret: 1 }, { kind: "text", text: "\nx" })).toEqual({
			text: "中\nx",
			caret: 3,
		});
	});
});

describe("M10b-3 帧与差分（纯函数）", () => {
	const baseState = {
		status: { mode: "plan", cwd: "D:\\r", sessionId: "ses_1" },
		transcript: ["t1", "t2", "t3", "t4"],
		input: "a\nb\nc",
		caret: 2, // 第 2 行（"b"）的行首
		scrollOffset: 0,
	};

	it("多行草稿：帧**仍恰好 rows 行**、输入区占 3 行、续行同宽缩进；视图相应收缩", () => {
		const frame = compose(baseState, 40, 10, plain);
		expect(frame).toHaveLength(10);
		expect(frame[2]).toBe(""); // 视图被压到 5 行（10 - 状态条2 - 输入3）→ 顶部补 1 行空
		expect(frame[3]).toBe("t1");
		expect(frame[6]).toBe("t4");
		expect(frame[7]).toBe("› a");
		expect(frame[8]).toBe("  b"); // 续行与前缀同宽（2 列）
		expect(frame[9]).toBe("  c");
	});

	it("caretPosition：行 = 输入区内光标所在行；列 = 前缀 + 显示列", () => {
		expect(caretPosition(baseState, 40, 10)).toEqual({ row: 8, column: 2 }); // 第 2 行行首
		expect(caretPosition({ ...baseState, input: "中", caret: 1 }, 40, 10)).toEqual({
			row: 9,
			column: 4, // 前缀 2 + 全角 2
		});
	});

	it("renderFrame：光标可以停在**非末行**", () => {
		const previous = ["s", "---", "t4", "› a", "  b", "  c"];
		const next = ["s", "---", "t4", "› a", "  b", "  cX"];
		const diff = planDiff(previous, next, false);
		const text = renderFrame(diff, next, { caretRow: 4, caretCol: 5, previousCaretRow: 5 });
		expect(text).toContain("\u001b[1A"); // 末行 → 光标行（上移 1）
		expect(text.endsWith("\u001b[5C\u001b[?2026l")).toBe(true);
	});

	it("renderCaretMove：帧没变但光标动了 → 只挪光标（M10 的潜在缺陷）", () => {
		expect(renderCaretMove({ row: 3, column: 2 }, { row: 3, column: 2 })).toBe("");
		expect(renderCaretMove({ row: 9, column: 2 }, { row: 9, column: 4 })).toBe(
			"\u001b[?2026h\r\u001b[4C\u001b[?2026l",
		);
		expect(renderCaretMove({ row: 9, column: 2 }, { row: 8, column: 2 })).toBe(
			"\u001b[?2026h\r\u001b[1A\u001b[2C\u001b[?2026l",
		);
		expect(renderCaretMove({ row: 8, column: 2 }, { row: 9, column: 2 })).toContain("\u001b[1B");
	});

	it("`createScreen`：只移动光标 → 输出**只有**光标序列（不重画任何内容）", () => {
		const written: string[] = [];
		const screen = createScreen({
			sink: { write: (text) => written.push(text) },
			theme: plain,
			size: () => ({ columns: 40, rows: 8 }),
			intervalMs: 0,
			initial: {
				status: { mode: "plan", cwd: "D:\\r", sessionId: "ses" },
				transcript: ["a"],
				input: "hello",
				caret: 5,
				scrollOffset: 0,
			},
		});
		screen.flush();
		expect(written).toHaveLength(1);
		screen.update({ caret: 2 }); // 只把光标从行尾挪到中间
		screen.flush();
		expect(written).toHaveLength(2);
		const delta = written[1] as string;
		expect(delta).toContain("\r\u001b[4C"); // 列 = 前缀 2 + 光标列 2
		expect(delta).not.toContain("hello"); // 没有重画内容
	});
});

describe("M10b-3 应用层：假 tty 驱动真实 REPL（粘贴多行 → 一条消息）", () => {
	it("粘贴多行不被提交；Enter 后**只落一条** user/message（含换行）并按多行渲染", async () => {
		const home = newTemp("chenxi-m10b3-home-");
		const cwd = newTemp("chenxi-m10b3-cwd-");
		const stdout = new FakeStdout();
		const stdin = new FakeStdin();

		const session = runTuiSession({
			home,
			cwd,
			mode: "plan",
			input: stdin as never,
			sink: stdout as never,
			keys: stdin as never,
			theme: plain,
			intervalMs: 0,
			output: { write: () => undefined },
			// 刻意**不给 provider**：只记录 —— 便于断言"恰好一条 user/message"
		});

		await waitFor(() => stdout.text.includes("› "));
		expect(stdout.text).toContain("\u001b[?2004h"); // 括号粘贴已开启

		// ① 粘贴三行草稿：呈多行草稿（首行前缀 + 续行同宽缩进），**尚未提交**
		stdin.type(`${PASTE_START}line1\nline2\nline3${PASTE_END}`);
		await delay(50);
		expect(stdout.text).toContain("› line1");
		expect(stdout.text).toContain("  line2");
		expect(readSession(home).some((event) => event.type === "user/message")).toBe(false);

		// ② Ctrl+J（换行键）再补一行
		stdin.type("\n");
		stdin.type("line4");
		await delay(50);
		expect(stdout.text).toContain("  line4");

		// ③ Enter：整份草稿作为**一条**消息提交（转录区按多行渲染）
		stdin.type("\r");
		await waitFor(() => stdout.text.includes("  line3"));
		expect(stdout.text).toContain("› line1");
		expect(stdout.text).toContain("  line4");

		// ④ 退出并严格还原（括号粘贴 / 鼠标上报都要**关掉**）
		stdin.type("\u0004");
		await session;
		expect(stdout.text).toContain("\u001b[?2004l");
		expect(stdout.text).toContain("\u001b[?1000l\u001b[?1006l");
		expect(stdout.text).toContain("\u001b[?1049l");

		// ⑤ 事实源：**恰好一条** user/message，内容含换行（没被 readline 拆成多条）
		const users = readSession(home).filter((event) => event.type === "user/message");
		expect(users).toHaveLength(1);
		expect((users[0]?.payload as { content: string }).content).toBe("line1\nline2\nline3\nline4");
	});
});
