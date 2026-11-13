/**
 * M10b-4 验收测试（应用层；总工程师独立编写，与 `m10b4-acceptance.test.ts` 同批拆开以守 600 行门禁）。
 *
 * 覆盖（全部是**假 tty**（`FakeStdout` / `FakeStdin`）驱动**真实 `runSessionRepl`**）：
 *  - **富文本 + 折叠**：流式正文的 markdown 按行画出来；工具结果**默认折叠**成一行；`Ctrl+O` 全展开后
 *    逐行 `│ …` 出现（read 载荷 JSON 里的文件名可见）；**折叠不改事实源**（JSONL 里没有 expanded / fenced）；
 *  - **回合内指示**：忙碌时状态条出现 `(local)` 标记的本地测量，时钟前进 ⇒ 帧与秒数跟着走；
 *    `turn/end` 后**该字段消失**且**空闲不空转**（收尾后 200ms 内不再写字节）；
 *  - **resize**：列宽变化 → 全量重绘（`ESC[2J` + `ESC[H`），状态条与输入行按新尺寸重画；
 *  - **IME 定位前提**：硬件光标可见（`?25h`）+ 全角按 2 显示列算光标列（`ESC[4C`）；
 *  - **审批流**：提问按**多行**渲染、提问期间输入行照常作答（`a` = always），判定语义与 M6 一致
 *    （`permission/decision` allow + 越界写**真的写出**）。
 *
 * 说明（如实标注）：本机**无 pty**，真 CLI 冒烟只能证明"端到端没被改坏"；
 * 下面是 TUI 交互层唯一可自动断言的手段。
 */
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent, ToolCallId, ToolCallRef } from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import type { LlmProvider } from "../src/llm/types.js";
import type { ToolRuntime } from "../src/loop/index.js";
import { createPermissionSystem } from "../src/permission/index.js";
import { selectShellProvider } from "../src/shell/index.js";
import { createDefaultToolset, createToolRegistry } from "../src/tools/index.js";
import { createTheme, runTuiSession } from "../src/tui/index.js";
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

/** 主题：TUI 用**无色**主题跑（断言不依赖配色；配色那一层另有 ADR-020 的测试钉住）。 */
const plain = createTheme({ disabled: true });

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

function buildTools(): ToolRuntime {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() }))
		registry.register(tool);
	return { ctx, registry };
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

/** 会"慢一拍"的 provider：给回合留出可观察的忙碌窗口（spinner 测试用）。 */
function slowProvider(delayMs: number, text: string): LlmProvider {
	return {
		id: "slow-stub",
		async *stream() {
			await delay(delayMs);
			yield { kind: "text-delta", text };
			yield {
				kind: "done",
				message: { content: text, toolCalls: [], stopReason: "end_turn" },
			};
		},
	};
}

describe("M10b-4 应用层：假 tty 驱动真实 REPL", () => {
	it("正文 markdown 走富文本；工具结果折叠 + `Ctrl+O` 全展开", async () => {
		const home = newTemp("aster-m10b4b-home-");
		const cwd = newTemp("aster-m10b4b-cwd-");
		const target = join(cwd, "sample.txt");
		writeFileSync(target, "line1\nline2\nline3\nline4\nline5\nline6\n", "utf8");
		const stdout = new FakeStdout();
		stdout.rows = 40; // 视口放大，保证展开的内容落在屏上（本用例要断言"画出来了"）
		stdout.columns = 160; // 展开的是 JSON 载荷，路径行要放得下才看得到文件名
		const stdin = new FakeStdin();
		const markdown = "# 标题\n```ts\nconst x = 1;\n```\n- a\n";

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
				{
					content: "",
					toolCalls: [
						{
							callId: "call_read" as ToolCallId,
							toolName: "read",
							input: { path: target, offset: 0, limit: 5 },
						},
					],
					stopReason: "tool_call",
				},
				// 正文按**分片**流式到达（富文本按"已收全行"逐行渲染，与分片无关）
				{ chunks: ["# 标题\n```ts\n", "const x = 1;\n", "```\n- a\n"], content: markdown },
			]),
			model: "stub-model",
			tools: buildTools(),
			permission: createPermissionSystem(),
			output: { write: () => undefined },
		});

		await waitFor(() => stdout.text.includes("› "));
		stdin.type("go\r");
		// 回合 1：工具结果默认**折叠**成一行（带隐藏行数与耗时——都是**已记录/可测**的事实）
		await waitFor(() => stdout.text.includes("折叠"));
		expect(stdout.text).toContain("  ← tool_result: read ok");
		expect(stdout.text).toContain("· 折叠");
		await waitFor(() => stdout.text.includes("• a"));

		// 富文本：标题 / 代码框 / 列表都**按行**画出来了（`#` 与围栏标记不会被当正文吐出来）
		expect(stdout.text).toContain("标题");
		expect(stdout.text).toContain("┌─ ts");
		expect(stdout.text).toContain("│ const x = 1;");
		expect(stdout.text).toContain("└─");
		expect(stdout.text).toContain("  • a");

		// `Ctrl+O`：全部展开 ⇒ 该条的隐藏内容（read 的载荷 JSON）逐行 `│ …` 出现
		stdin.type("\u000f");
		await waitFor(() => stdout.text.includes("展开"));
		expect(stdout.text).toContain("│ ");
		expect(stdout.text).toContain("sample.txt");

		// 退出：收尾前画完最后一帧 + 严格还原（括号粘贴 / 鼠标上报 / alt screen 成对关闭）
		stdin.type("\u0004");
		await session;
		expect(stdout.text).toContain("\u001b[?1049l");
		expect(stdout.text).toContain("\u001b[?2004l");
		expect(stdout.text).toContain("\u001b[?1000l");
		// 折叠**没有**改变事实源：JSONL 里既没有 expanded / fenced 之类的字段
		const raw = readSession(home)
			.map((event) => JSON.stringify(event))
			.join("\n");
		expect(raw).not.toContain("expanded");
		expect(raw).not.toContain("fenced");
	});

	it("回合内指示：忙碌时状态条显示本地测量、`turn/end` 后消失且**空闲不空转**", async () => {
		const home = newTemp("aster-m10b4b-spin-home-");
		const cwd = newTemp("aster-m10b4b-spin-cwd-");
		const stdout = new FakeStdout();
		const stdin = new FakeStdin();
		let clock = 1000; // 注入的本地时钟（ADR-026：耗时是**本地测量**）

		const session = runTuiSession({
			home,
			cwd,
			mode: "plan",
			input: stdin as never,
			sink: stdout as never,
			keys: stdin as never,
			theme: plain,
			intervalMs: 0,
			now: () => clock,
			provider: slowProvider(250, "late"),
			model: "slow-model",
			tools: buildTools(),
			permission: createPermissionSystem(),
			output: { write: () => undefined },
		});

		await waitFor(() => stdout.text.includes("› "));
		expect(stdout.text).toContain("\u001b[?25h"); // 硬件光标可见（IME 候选框跟它走）
		stdin.type("go\r");
		// 忙碌窗口内：状态条出现 `(local)` 标记的耗时（数字来自本机时钟，**不是**事件字段）
		await waitFor(() => stdout.text.includes("(local)"));
		expect(stdout.text).toContain("◐ 0.0s (local)");
		// 时钟前进 ⇒ 帧与秒数都跟着走（帧数由节拍推动，不由内容驱动）
		clock = 1240;
		await waitFor(() => stdout.text.includes("◑ 0.2s (local)"));

		await waitFor(() => stdout.text.includes("[assistant stopped: end_turn"));
		await delay(60); // 让收尾那一帧画完
		const settled = stdout.text.length;
		// 状态条的最新一次重绘**不含** `(local)`（忙碌事实已清账）
		const lastStatus = [...stdout.chunks].reverse().find((chunk) => chunk.includes("aster"));
		expect(lastStatus).toBeDefined();
		expect(lastStatus).not.toContain("(local)");
		// 空闲不空转：节拍已停 ⇒ 200ms 内一个字节都不再写
		await delay(200);
		expect(stdout.text.length).toBe(settled);

		stdin.type("\u0004");
		await session;
	});

	it("resize：尺寸变了就全量重绘（宽度变化走 `planDiff` 的 full 分支）", async () => {
		const home = newTemp("aster-m10b4b-resize-home-");
		const cwd = newTemp("aster-m10b4b-resize-cwd-");
		const stdout = new FakeStdout();
		stdout.rows = 12;
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
		});

		await waitFor(() => stdout.text.includes("› "));
		const before = stdout.text.length;
		stdout.columns = 40;
		stdout.emit("resize");
		await delay(30);
		const delta = stdout.text.slice(before);
		expect(delta).toContain("\u001b[2J\u001b[H"); // 全量重绘（清屏 + 回原点）
		expect(delta).toContain("› "); // 输入行照旧画出来
		expect(delta).toContain("aster"); // 状态条也在这一帧里

		stdin.type("\u0004");
		await session;
	});

	it("IME 定位前提：硬件光标可见 + 全角按 **2** 显示列算光标列（不做 preedit 渲染）", async () => {
		const home = newTemp("aster-m10b4b-ime-home-");
		const cwd = newTemp("aster-m10b4b-ime-cwd-");
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
		});

		await waitFor(() => stdout.text.includes("› "));
		const before = stdout.text.length;
		stdin.type("中"); // 一个全角字符
		await delay(30);
		const delta = stdout.text.slice(before);
		expect(delta).toContain("› 中");
		// 光标列 = 前缀 2 + 全角 2 ⇒ 4：候选框会跟着这个位置走（光标停在**正确的行列**）
		expect(delta).toContain("\u001b[4C");
		expect(stdout.text).toContain("\u001b[?25h");

		stdin.type("\u0004");
		await session;
	});

	it("审批流在 TUI 里的完整交互：提问**按多行**渲染，提问期间输入行照常作答", async () => {
		const home = newTemp("aster-m10b4b-ask-home-");
		const cwd = newTemp("aster-m10b4b-ask-cwd-");
		const elsewhere = newTemp("aster-m10b4b-ask-outside-");
		const outside = join(elsewhere, "out.txt");
		const stdout = new FakeStdout();
		stdout.rows = 20; // 提问有 5 行，视口要装得下
		const stdin = new FakeStdin();
		const writeCall: ToolCallRef = {
			callId: "c1" as ToolCallId,
			toolName: "write",
			input: { path: outside, content: "tui\n" },
		};

		const session = runTuiSession({
			home,
			cwd,
			// build 下**越界写**才触发 `ask`（与 M6 的语义完全一致，本层未改判定）
			mode: "build",
			input: stdin as never,
			sink: stdout as never,
			keys: stdin as never,
			theme: plain,
			intervalMs: 0,
			provider: createStubProvider([
				{ content: "", toolCalls: [writeCall], stopReason: "tool_call" },
				{ content: "done-1", stopReason: "end_turn" },
			]),
			model: "stub-model",
			tools: buildTools(),
			permission: createPermissionSystem(),
			output: { write: () => undefined },
		});

		await waitFor(() => stdout.text.includes("› "));
		stdin.type("write outside the workspace\r");
		// 提问是**多行**文本：走文本通道按 `\n` 切行（首行空行 + 头部 + reason + input + 选项行）
		await waitFor(() => stdout.text.includes("allow? [y] once"));
		expect(stdout.text).toContain("[approval required] write");
		expect(stdout.text).toContain("reason:");
		expect(stdout.text).toContain("input :");

		// 提问期间输入行照常可用：键入答案并回车（同一条 stdin，`Enter` 推一行即答案）
		stdin.type("a\r");
		await waitFor(() => stdout.text.includes("done-1"));

		// 事实：判定经 trace 出口落 `permission/decision`（allow，来自用户批准）⇒ 恰好**一次**提问
		// （提问文本会被差分重绘多次写进 `stdout`，故"提问次数"只能由事实源来数，不能靠数文本）
		const decisions = readSession(home).filter((event) => event.type === "permission/decision");
		expect(decisions).toHaveLength(1);
		if (decisions[0]?.type === "permission/decision") {
			expect(decisions[0].payload.decision).toBe("allow");
			expect(decisions[0].payload.reason).toContain("approved by user");
		}
		// 越界写真的执行了（用户批准后放行）
		expect(readFileSync(outside, "utf8")).toBe("tui\n");

		stdin.type("\u0004");
		await session;
		expect(stdout.text).toContain("\u001b[?1049l");
	});
});
