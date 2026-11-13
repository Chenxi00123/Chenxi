/**
 * M10b-4 验收测试（纯函数 / 行模型 / 屏幕层；总工程师独立编写）。
 * **应用层（假 tty 驱动真实 REPL）在 `m10b4b-acceptance.test.ts`**——同批拆开以守 600 行门禁。
 *
 * 覆盖：
 *  - **富文本（纯函数 `rich-text.ts`）**：标题 / 无序 / 有序列表 / 围栏代码（等宽框三件套
 *    `┌─ <lang|code>` / `│ …` / `└─`）/ 行内代码；**未命中构造的行回落 `formatLine`**（横幅仍上色）；
 *    载荷 → 行（字符串按行、对象 JSON 缩进、`undefined` 空）；
 *  - **折叠（纯函数 `describeEvent` + `toolResultHiddenLines`）**：缺省 = **保持现行为**一行摘要；
 *    `collapse:true` 下折叠态带 `· N 行 · 折叠 · 3ms`、展开态带 `│ …`；**没藏内容就不提示可折叠**；
 *    错误态的隐藏行数 = 消息行数 − 1；
 *  - **行模型（`createTranscript`）**：`owner` 与 `lines` 等长且一一对应（`eventSeqAt`）；
 *    `toggle` / `toggleAll` **只动该条事件占用的行**且**不入事实源**；忙碌态是**结构化判据**（`turn/start` 未见 `turn/end`）；
 *  - **spinner（纯函数 + 节拍器）**：帧选择确定、忙碌才走、结束即停（空闲不空转）；
 *  - **屏幕**：状态条按**本地测量**显示 `◐ 1.3s (local)`；`transcriptIndexAt` 与 `compose` **同一套窗口算法**。
 */
import type { SessionEvent } from "@aster/schema";
import { describe, expect, it, vi } from "vitest";
import {
	busyFacts,
	compose,
	createSpinnerTicker,
	createTheme,
	createTranscript,
	describeEvent,
	INITIAL_RICH_TEXT,
	payloadLines,
	renderRichLine,
	spinnerGlyph,
	type TranscriptOptions,
	toolResultHiddenLines,
	transcriptIndexAt,
} from "../src/tui/index.js";

const plain = createTheme({ disabled: true });
const colored = createTheme({ colorTerm: "truecolor" });
const MUTED = "\u001b[38;2;138;145;155m";
const TOOL = "\u001b[38;2;187;154;247m";

function ev(type: string, payload: unknown, seq = 0, sessionId = "ses_x"): SessionEvent {
	return { seq, id: `evt_${seq}`, sessionId, type, at: "at", payload } as SessionEvent;
}

function transcriptOf(options: Omit<TranscriptOptions, "theme" | "mode"> = {}) {
	return createTranscript({
		theme: plain,
		mode: "plan",
		onChange: () => undefined,
		...options,
	});
}

describe("M10b-4 富文本（纯函数）", () => {
	it("标题 / 无序列表 / 有序列表 / 行内代码", () => {
		expect(renderRichLine("## hi", INITIAL_RICH_TEXT, plain)).toEqual({
			rendered: "hi",
			state: { fenced: false },
		});
		expect(renderRichLine("- a", INITIAL_RICH_TEXT, plain).rendered).toBe("  • a");
		expect(renderRichLine("* a", INITIAL_RICH_TEXT, plain).rendered).toBe("  • a");
		expect(renderRichLine("1. a", INITIAL_RICH_TEXT, plain).rendered).toBe("  1. a");
		// 行内代码：truecolor 下上 tool 色（plain 主题下即原样）
		expect(renderRichLine("a `b` c", INITIAL_RICH_TEXT, colored).rendered).toBe(
			`a ${TOOL}b\u001b[0m c`,
		);
		expect(renderRichLine("a `b` c", INITIAL_RICH_TEXT, plain).rendered).toBe("a b c");
	});

	it("围栏代码：`┌─ <lang|code>` / `│ …` / `└─`，且状态可回填（一行进一行出）", () => {
		const open = renderRichLine("```ts", INITIAL_RICH_TEXT, plain);
		expect(open.rendered).toBe("┌─ ts");
		expect(open.state).toEqual({ fenced: true });
		// 无语言 → `code`；围栏内不再认标题 / 列表
		expect(renderRichLine("```", INITIAL_RICH_TEXT, plain).rendered).toBe("┌─ code");
		expect(renderRichLine("# not a heading", open.state, plain).rendered).toBe("│ # not a heading");
		expect(renderRichLine("x", open.state, plain).rendered).toBe("│ x");
		const close = renderRichLine("```", open.state, plain);
		expect(close.rendered).toBe("└─");
		expect(close.state).toEqual({ fenced: false }); // 闭合后状态复位 ⇒ 后续行按普通行处理
		expect(renderRichLine("## hi", close.state, plain).rendered).toBe("hi");
	});

	it("未命中构造的行**回落 formatLine**（横幅 / 命令输出照旧上色，语义一字未改）", () => {
		expect(renderRichLine("session: ses_1", INITIAL_RICH_TEXT, colored).rendered).toContain(MUTED);
		expect(
			renderRichLine("  [assistant stopped: end_turn, steps=1]", INITIAL_RICH_TEXT, plain),
		).toEqual({ rendered: "  [assistant stopped: end_turn, steps=1]", state: { fenced: false } });
		// 普通正文保持终端默认前景（深色极简里正文最该"沉"）
		expect(renderRichLine("plain text", INITIAL_RICH_TEXT, colored).rendered).toBe("plain text");
	});

	it("载荷 → 行：字符串按行、对象 JSON 缩进、`undefined` / `null` 为空（绝不抛）", () => {
		expect(payloadLines(undefined)).toEqual([]);
		expect(payloadLines(null)).toEqual([]);
		expect(payloadLines("a\nb")).toEqual(["a", "b"]);
		expect(payloadLines({ a: 1 })).toEqual(["{", '  "a": 1', "}"]);
	});
});

describe("M10b-4 工具结果折叠（纯函数 / 视图状态）", () => {
	const result = ev(
		"tool/result",
		{ callId: "c", toolName: "read", ok: true, output: "a\nb", durationMs: 4 },
		9,
	);

	it("缺省**不变**（一行摘要）；`collapse:true` 才折叠 / 展开", () => {
		expect(describeEvent(result, plain)).toEqual(["  ← tool_result: read ok"]);
		expect(describeEvent(result, plain, { collapse: true })).toEqual([
			"  ← tool_result: read ok · 4ms · 2 行 · 折叠",
		]);
		expect(describeEvent(result, plain, { collapse: true, expanded: new Set([9]) })).toEqual([
			"  ← tool_result: read ok · 4ms · 2 行 · 展开",
			"  │ a",
			"  │ b",
		]);
	});

	it("没有藏内容就不提示「可折叠」（判据由 `toolResultHiddenLines` 单一给出）", () => {
		const bare = ev("tool/result", { callId: "c", toolName: "bash", ok: true, durationMs: 2 }, 10);
		expect(toolResultHiddenLines(bare)).toBe(0);
		expect(describeEvent(bare, plain, { collapse: true })).toEqual([
			"  ← tool_result: bash ok · 2ms",
		]);
		// 错误态：折叠头已显示消息首行 ⇒ 隐藏行数 = 消息行数 − 1
		const bad = ev(
			"tool/result",
			{
				callId: "c",
				toolName: "bash",
				ok: false,
				error: { code: "x", message: "boom\nstack", retryable: false },
				durationMs: 1,
			},
			11,
		);
		expect(toolResultHiddenLines(bad)).toBe(1);
		expect(describeEvent(bad, plain, { collapse: true })).toEqual([
			"  ← tool_result: bash error(x): boom · 1ms · 1 行 · 折叠",
		]);
		// 非 `tool/result` 事件一律 0（不可展开）
		expect(toolResultHiddenLines(ev("turn/start", { turnId: "t", index: 0 }))).toBe(0);
	});
});

describe("M10b-4 行模型：折叠是视图状态、忙碌是结构化判据", () => {
	it("`eventSeqAt` 把每一行归到渲染它的那条事件（流式半行 / 非事件行是 undefined）", () => {
		const transcript = transcriptOf({ describe: { collapse: true } });
		transcript.output.write("banner\n");
		transcript.renderEvent(
			ev(
				"tool/result",
				{ callId: "c", toolName: "read", ok: true, output: "l1\nl2\nl3", durationMs: 7 },
				5,
			),
		);
		expect(transcript.lines).toEqual([
			"banner",
			"  ← tool_result: read ok · 7ms · 3 行 · 折叠",
			"",
		]);
		expect(transcript.eventSeqAt(0)).toBeUndefined();
		expect(transcript.eventSeqAt(1)).toBe(5);
		expect(transcript.eventSeqAt(2)).toBeUndefined(); // 末元素永远是"未收全的流式半行"
	});

	it("`toggle` / `toggleAll` 只重画该条事件占用的行；**不入事实源**（无 append 通道）", () => {
		const transcript = transcriptOf({ describe: { collapse: true } });
		transcript.renderEvent(
			ev(
				"tool/result",
				{ callId: "c1", toolName: "read", ok: true, output: "l1\nl2", durationMs: 1 },
				1,
			),
		);
		transcript.renderEvent(
			ev(
				"tool/result",
				{ callId: "c2", toolName: "bash", ok: true, output: "z1", durationMs: 2 },
				2,
			),
		);
		expect(transcript.toggle(1)).toBe(true);
		expect(transcript.lines).toEqual([
			"  ← tool_result: read ok · 1ms · 2 行 · 展开",
			"  │ l1",
			"  │ l2",
			"  ← tool_result: bash ok · 2ms · 1 行 · 折叠",
			"",
		]);
		expect(transcript.eventSeqAt(2)).toBe(1); // 展开多出来的行仍属同一条事件
		expect(transcript.toggle(1)).toBe(true);
		expect(transcript.lines[0]).toBe("  ← tool_result: read ok · 1ms · 2 行 · 折叠");
		// 不可展开的：没有内容 / 不是工具结果 / 事件未知 ⇒ 一律 false（调用方据此不重绘）
		expect(transcript.toggle(999)).toBe(false);
		expect(transcript.toggleAll()).toBe(true); // 有任一未展开 ⇒ 全展开
		expect(transcript.lines.filter((line) => line.includes("展开"))).toHaveLength(2);
		expect(transcript.toggleAll()).toBe(true); // 有任一已展开 ⇒ 全收起
		expect(transcript.lines.filter((line) => line.includes("折叠"))).toHaveLength(2);
		expect(transcriptOf().toggleAll()).toBe(false); // 一条可展开的都没有
	});

	it("忙碌态 = `turn/start` 之后未见 `turn/end`（**本地时钟**记开始时刻，`session/end` 也清账）", () => {
		let clock = 500;
		const transcript = transcriptOf({ now: () => clock });
		expect(transcript.busy).toBe(false);
		expect(transcript.turnStartedAt).toBeUndefined();
		transcript.renderEvent(ev("turn/start", { turnId: "t", index: 0 }, 1));
		expect(transcript.busy).toBe(true);
		expect(transcript.turnStartedAt).toBe(500);
		clock = 740;
		expect(busyFacts(transcript.turnStartedAt, () => clock)).toEqual({
			glyph: "◑",
			elapsedMs: 240,
		});
		transcript.renderEvent(ev("turn/end", { turnId: "t", stopReason: "end_turn" }, 2));
		expect(transcript.busy).toBe(false);
		transcript.renderEvent(ev("turn/start", { turnId: "t2", index: 1 }, 3));
		transcript.renderEvent(ev("session/end", { reason: "exit" }, 4));
		expect(transcript.busy).toBe(false);
	});

	it("富文本只作用于**文本通道的已收全行**（围栏状态由行模型持有）", () => {
		const transcript = transcriptOf({ rich: true });
		transcript.output.write("# 标题\n```ts\nx = 1;\n```\n- a\n");
		expect(transcript.lines).toEqual(["标题", "┌─ ts", "│ x = 1;", "└─", "  • a", ""]);
		// 未收全的半行按原样显示（与 M10 一致：它可能还只是"半行标题"）
		transcript.output.write("# 半");
		expect(transcript.lines.at(-1)).toBe("# 半");
	});
});

describe("M10b-4 spinner（纯函数 + 节拍器）", () => {
	it("帧选择确定：按已过毫秒取 `frames[floor(elapsed/120) % n]`", () => {
		expect(spinnerGlyph(0)).toBe("◐");
		expect(spinnerGlyph(119)).toBe("◐");
		expect(spinnerGlyph(120)).toBe("◓");
		expect(spinnerGlyph(240)).toBe("◑");
		expect(spinnerGlyph(360)).toBe("◒");
		expect(spinnerGlyph(480)).toBe("◐"); // 4 帧循环
		expect(spinnerGlyph(-5)).toBe("◐"); // 负值夹到 0，绝不抛
		expect(spinnerGlyph(0, [])).toBe("");
	});

	it("`busyFacts`：回合未开始 → undefined；开始后 = 本地时钟的差", () => {
		expect(busyFacts(undefined, () => 1234)).toBeUndefined();
		expect(busyFacts(1000, () => 1240)).toEqual({ glyph: "◑", elapsedMs: 240 });
		expect(busyFacts(1000, () => 900)).toEqual({ glyph: "◐", elapsedMs: 0 }); // 时钟回绕也不出负数
	});

	it("`createSpinnerTicker`：忙碌才走、结束即停（空闲不空转）", () => {
		vi.useFakeTimers();
		try {
			let busy = false;
			let ticks = 0;
			const ticker = createSpinnerTicker({
				busy: () => busy,
				onTick: () => {
					ticks += 1;
				},
			});
			ticker.sync(); // 空闲：不起节拍
			vi.advanceTimersByTime(600);
			expect(ticks).toBe(0);
			busy = true;
			ticker.sync();
			vi.advanceTimersByTime(360);
			expect(ticks).toBe(3);
			busy = false;
			ticker.sync(); // 回合结束 ⇒ 停
			vi.advanceTimersByTime(600);
			expect(ticks).toBe(3);
			ticker.stop();
			busy = true;
			ticker.sync();
			busy = false;
			ticker.sync();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("M10b-4 屏幕：状态条忙碌指示与「屏幕行 → 转录行」", () => {
	it("状态条按**本地测量**显示 `◐ 1.3s (local)`（空闲时这个字段不出现）", () => {
		const base = {
			status: { mode: "plan", cwd: "D:\\r", sessionId: "ses_1" },
			transcript: [] as string[],
			input: "",
			caret: 0,
			scrollOffset: 0,
		};
		const idle = compose(base, 80, 8, plain);
		expect(idle[0]).not.toContain("(local)");
		const busy = compose(
			{ ...base, status: { ...base.status, busy: { glyph: "◑", elapsedMs: 1240 } } },
			80,
			8,
			plain,
		);
		expect(busy[0]).toContain("◑ 1.2s (local)");
		expect(busy[0]).toContain("· plan ·"); // 忙碌事实接在既有事实之后，不改动其余部分
	});

	it("`transcriptIndexAt` 与 `compose` 共用同一套窗口算法（顶部补空行 / 输入区都不命中）", () => {
		const state = {
			status: { mode: "plan", cwd: "D:\\r", sessionId: "ses_1" },
			transcript: ["A", "B", "C", "D"],
			input: "",
			caret: 0,
			scrollOffset: 0,
		};
		const frame = compose(state, 20, 8, plain);
		expect(frame[2]).toBe(""); // 视图只有 4 行 ⇒ 顶部补 1 行
		expect(frame[3]).toBe("A");
		expect(frame[6]).toBe("D");
		expect(transcriptIndexAt(state, 8, 3)).toBe(0);
		expect(transcriptIndexAt(state, 8, 6)).toBe(3);
		expect(transcriptIndexAt(state, 8, 2)).toBeUndefined(); // 补空行
		expect(transcriptIndexAt(state, 8, 7)).toBeUndefined(); // 输入区
		// 上滚 2 行后：可见的是 A / B（顶部补 3 行空）
		const scrolled = { ...state, scrollOffset: 2 };
		expect(compose(scrolled, 20, 8, plain)[5]).toBe("A");
		expect(transcriptIndexAt(scrolled, 8, 5)).toBe(0);
		expect(transcriptIndexAt(scrolled, 8, 6)).toBe(1);
	});
});
