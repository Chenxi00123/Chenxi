/**
 * M10b 验收测试（总工程师独立编写）：TUI 结构化驱动的第一步（ADR-023）——
 * **消掉文本启发式**（`06 §3` 的 M10b 第 1 项）。
 *
 * 可自动断言的部分：
 *  - **事实行不再靠前缀嗅探**：`formatLine` 对 tool_call / tool_result 一行都不上色（改由事件决定）；
 *  - **事件 → 行**：`describeEvent` 的工具成败分色（ok / err）、`assistantContent: false` 让
 *    流式前端不吃正文（正文走文本通道）、`turnEnd: false` 让有收尾文本行的前端不重复；
 *  - **行模型（`createTranscript`）**：文本通道保持"末元素是流式半行"的不变量；事件进来自动更新
 *    **mode / 会话 id**（状态条事实**不回读横幅**）；
 *  - **应用层（假 tty 驱动真实 REPL）**：用户那一行由 `user/message` **事件**出现（**恰好一次**，
 *    不再"回显 + 事件"两遍）；工具轨迹由事件出现且**没有文本版本**（`trace:false` 生效）；
 *    `/mode build` 的 `mode: plan -> build` **恰好一行**（来自事件）；状态条出现真实会话 id；
 *    `onEvent` 仍被转发给继承的订阅者（`--tui --serve` 不能因结构化渲染而漏发 SSE）。
 */
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent, ToolCallId } from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import type { ToolRuntime } from "../src/loop/index.js";
import { createPermissionSystem } from "../src/permission/index.js";
import { selectShellProvider } from "../src/shell/index.js";
import { createDefaultToolset, createToolRegistry } from "../src/tools/index.js";
import {
	createTheme,
	createTranscript,
	describeEvent,
	formatLine,
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
const colored = createTheme({ colorTerm: "truecolor" });
/** 语义色的 SGR 片段（truecolor 下）。 */
const TOOL = "\u001b[38;2;187;154;247m"; // tool（柔和紫）
const OK = "\u001b[38;2;158;206;106m"; // ok（柔和绿）
const ERR = "\u001b[38;2;247;118;142m"; // err（柔和玫红）

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

/** 造一条事件（纯函数断言用）。 */
function ev(type: string, payload: unknown, seq = 0, sessionId = "ses_x"): SessionEvent {
	return { seq, id: `evt_${seq}`, sessionId, type, at: "at", payload } as SessionEvent;
}

function buildTools(): ToolRuntime {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() }))
		registry.register(tool);
	return { ctx, registry };
}

/** 「先 read 一个文件、再收尾」的桩脚本（真实工具闭环保留）。 */
function readScript(path: string) {
	return [
		{
			content: "",
			toolCalls: [
				{
					callId: "call_read" as ToolCallId,
					toolName: "read",
					input: { path, offset: 0, limit: 5 },
				},
			],
			stopReason: "tool_call" as const,
		},
		{ content: "DONE", toolCalls: [], stopReason: "end_turn" as const },
	];
}

class FakeStdout extends EventEmitter {
	columns = 70;
	rows = 14;
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
	type(text: string): void {
		this.emit("data", Buffer.from(text, "utf8"));
	}
}

/** 统计某个片段出现的次数（用来钉"同一事实不出现两遍"）。 */
function count(text: string, fragment: string): number {
	let total = 0;
	let index = text.indexOf(fragment);
	while (index !== -1) {
		total += 1;
		index = text.indexOf(fragment, index + fragment.length);
	}
	return total;
}

describe("M10b-1 事实行不再靠前缀嗅探（ADR-023）", () => {
	it("`formatLine` 不再给会话事实上色（改由 `describeEvent` 按事件决定）", () => {
		// 曾经被嗅探的三类事实行，现在一律按"非事实行"处理：不上色
		expect(formatLine("  → tool_call: read", colored)).toBe("  → tool_call: read");
		expect(formatLine("  ← tool_result: bash ok", colored)).toBe("  ← tool_result: bash ok");
		expect(formatLine("  ~ memory: injected 2 record(s)", colored)).toBe(
			"  ~ memory: injected 2 record(s)",
		);
		expect(formatLine("  mode: plan -> build", colored)).toBe("  mode: plan -> build");
		expect(formatLine("  + user/message#3", colored)).toBe("  + user/message#3");

		// 没有事件的那类行仍由 `formatLine` 上色（这是它剩下的全部职责）
		expect(formatLine("session: ses_1", colored)).toContain("\u001b[38;2;138;145;155m"); // 横幅 muted
		expect(formatLine("  [assistant stopped: end_turn, steps=1]", colored)).toContain(
			"\u001b[38;2;138;145;155m",
		);
		expect(formatLine("  [model error] boom", colored)).toContain(ERR);
		expect(formatLine("  ! memory unavailable: x", colored)).toContain("\u001b[38;2;224;175;104m");
	});
});

describe("M10b-1 事件 → 行（呈现策略是**前端差异**，不是事实差异）", () => {
	it("工具成败分色（来自事件，不靠解析文本里的 `error(`）", () => {
		expect(
			describeEvent(
				ev("tool/result", { callId: "c", toolName: "read", ok: true, durationMs: 3 }),
				colored,
			)[0],
		).toContain(OK);
		expect(
			describeEvent(
				ev("tool/result", {
					callId: "c",
					toolName: "write",
					ok: false,
					error: { code: "permission_denied", message: "nope", retryable: false },
					durationMs: 3,
				}),
				colored,
			)[0],
		).toContain(ERR);
		// tool_call 轨迹：由 `assistant/message` 的 toolCalls 渲染（`[1]` 是因为默认还会渲染正文）
		const message = ev("assistant/message", {
			content: "x",
			toolCalls: [{ callId: "c", toolName: "read", input: { path: "p" } }],
		});
		expect(describeEvent(message, colored)[1]).toContain(TOOL);
		expect(describeEvent(message, colored, { assistantContent: false })[0]).toContain(TOOL);
	});

	it("`assistantContent: false` 让流式前端不吃正文（但**仍**渲染 tool_call 轨迹）", () => {
		const message = ev("assistant/message", {
			content: "正文由文本通道呈现",
			toolCalls: [{ callId: "c", toolName: "read", input: { path: "p" } }],
		});
		expect(describeEvent(message, plain)).toEqual([
			"正文由文本通道呈现",
			'  → tool_call: read {"path":"p"}',
		]);
		expect(describeEvent(message, plain, { assistantContent: false })).toEqual([
			'  → tool_call: read {"path":"p"}',
		]);
		// 纯正文回合（无 toolCall）在流式前端里**什么都不渲染**（正文不重复出现）
		expect(
			describeEvent(ev("assistant/message", { content: "hi" }), plain, { assistantContent: false }),
		).toEqual([]);
	});

	it("`turnEnd: false` 让「另有收尾文本行」的前端不重复渲染回合收尾", () => {
		const turnEnd = ev("turn/end", { turnId: "t", stopReason: "end_turn" });
		expect(describeEvent(turnEnd, plain)).toEqual(["  [turn stopped: end_turn]"]);
		expect(describeEvent(turnEnd, plain, { turnEnd: false })).toEqual([]);
	});
});

describe("M10b-1 行模型（createTranscript：文本通道 + 事件合流）", () => {
	it("文本通道保持「末元素是流式半行」的不变量；事件进来自动更新 mode / 会话 id", () => {
		const ready: string[] = [];
		const transcript = createTranscript({
			theme: plain,
			mode: "plan",
			onChange: () => ready.push("changed"),
		});

		// 文本通道：横幅 + 流式半行
		transcript.output.write("session: ses_a\nformat v1 | mode plan | cwd /x\n");
		expect(transcript.lines).toEqual(["session: ses_a", "format v1 | mode plan | cwd /x", ""]);
		transcript.output.write("streaming…");
		expect(transcript.lines.at(-1)).toBe("streaming…"); // 未收全的半行原地更新

		// 会话 id 来自事件（**不回读** `session:` 横幅）：先给一条别的会话 id
		transcript.renderEvent(ev("turn/start", { turnId: "t", index: 0 }, 3, "ses_real"));
		expect(transcript.sessionId).toBe("ses_real");

		// mode 来自 `mode/changed` 事件（不是 `  mode: …` 文本行）
		transcript.renderEvent(
			ev("mode/changed", { from: "plan", to: "build", reason: "u" }, 4, "ses_real"),
		);
		expect(transcript.mode).toBe("build");
		expect(ready.length).toBeGreaterThan(0);
	});

	it("`setSessionId` 结构化通道（`onSessionReady`）也能喂 state", () => {
		const transcript = createTranscript({ theme: plain, mode: "plan", onChange: () => undefined });
		expect(transcript.sessionId).toBe("…");
		transcript.setSessionId("ses_from_repl");
		expect(transcript.sessionId).toBe("ses_from_repl");
	});
});

describe("M10b-1 应用层：假 tty 驱动真实 REPL（结构化事件渲染）", () => {
	it("用户行由事件出现**恰好一次**；工具轨迹来自事件且无文本版本；mode 只出现一行", async () => {
		const home = newTemp("aster-m10b-home-");
		const cwd = newTemp("aster-m10b-cwd-");
		const target = join(cwd, "sample.txt");
		writeFileSync(target, "line1\nline2\nline3\nline4\nline5\nline6\n", "utf8");
		const stdout = new FakeStdout();
		const stdin = new FakeStdin();
		const forwarded: string[] = []; // 继承来的 onEvent（模拟 `--serve` 的 SSE 生产者）

		const session = runTuiSession({
			home,
			cwd,
			mode: "plan",
			input: stdin as never,
			sink: stdout as never,
			keys: stdin as never,
			theme: plain,
			intervalMs: 0,
			provider: createStubProvider(readScript(target)),
			model: "stub-model",
			tools: buildTools(),
			permission: createPermissionSystem(),
			output: { write: () => undefined }, // runTuiSession 会用自己的行模型覆盖它
			onEvent: (event) => forwarded.push(event.type),
		});

		await waitFor(() => stdout.text.includes("› "));
		// 状态条的会话 id 来自 `onSessionReady`（结构化通道，不是横幅回读）
		await waitFor(() => /ses_[a-z0-9]+/.test(stdout.text));

		stdin.type("go\r");
		// 工具闭环跑完：assistant 正文（文本通道）+ 工具轨迹（事件）
		await waitFor(() => stdout.text.includes("DONE"));

		// ① `trace:false`：**没有**文本版的事实行（`+ user/message#` / `← tool_result:`）
		expect(stdout.text).not.toContain("+ user/message#");
		// ② 工具轨迹来自事件，且**没有**被重复（文本版与事件版同形，故必须恰好一次）
		expect(stdout.text).toContain("  → tool_call: read");
		expect(count(stdout.text, "  → tool_call: read")).toBe(1);
		expect(stdout.text).toContain("  ← tool_result: read ok");
		expect(count(stdout.text, "  ← tool_result: read ok")).toBe(1);
		// ③ 用户那一行由**事件**出现：打字时输入行画过一次，事件再画一次 ⇒ 恰好 2
		//    （若还是「回显 + 事件」两遍，这里会是 3 —— ADR-023 明确避免）
		expect(count(stdout.text, "› go")).toBe(2);

		// ④ `/mode build` 的 `mode: plan -> build` 来自事件，**恰好一行**（文本版已被抑制）
		stdin.type("/mode build\r");
		await waitFor(() => stdout.text.includes("mode: plan -> build"));
		expect(count(stdout.text, "  mode: plan -> build")).toBe(1);
		// 状态条随之更新（**来自事件**，不是从提示行回读）
		expect(stdout.text).toContain("· build ·");

		// ⑤ 结构化渲染**没有**吃掉继承的订阅者（`--tui --serve` 仍要发 SSE）
		expect(forwarded).toContain("user/message");
		expect(forwarded).toContain("assistant/message");
		expect(forwarded).toContain("mode/changed");

		stdin.type("\u0004"); // Ctrl+D -> EOF -> REPL 收尾
		await session;
		expect(stdout.text).toContain("\u001b[?1049l"); // alt screen 仍严格还原
		expect(stdin.rawModeCalls.at(-1)).toBe(false);
	});
});
