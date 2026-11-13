/**
 * M6 验收测试（总工程师独立编写）：可安装日用版的关键行为。
 *
 * 与模块单测**不重复**，只从 CLI / 端到端层面核验：
 *  - `ask` 可交互审批：`once` / `always`（沉淀为本会话规则）/ `reject`，解析失败 fail-closed；
 *  - `--resume latest`：直接续上最近更新的会话；
 *  - SIGINT 优雅中断：一次中止当前回合（落 `turn/end{error}`），二次退出（落 `session/end{interrupted}`）；
 *  - `--doctor`：自检输出与退出码，**绝不打印密钥值**；
 *  - `read` 输出上限（字节截断 + `truncatedReason`）。
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
	AgentMode,
	PermissionRequest,
	PermissionVerdict,
	SessionEvent,
	SessionId,
	ToolCallContext,
	ToolCallId,
	ToolCallRef,
} from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";
import { parseArgs } from "../src/cli/main.js";
import { runSessionRepl } from "../src/cli/repl.js";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import type { LlmProvider } from "../src/llm/types.js";
import {
	createApprovalGate,
	createPermissionSystem,
	parseApprovalAnswer,
} from "../src/permission/index.js";
import { selectShellProvider } from "../src/shell/index.js";
import {
	createDefaultToolset,
	createReadTool,
	createToolRegistry,
	createWriteTool,
	executeTool,
} from "../src/tools/index.js";
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

function collector() {
	const chunks: string[] = [];
	return {
		output: { write: (text: string) => void chunks.push(text) },
		text: () => chunks.join(""),
	};
}

/** 可控输入流：由测试按需 `push` 一行，避免「答案行先于提问到达」的竞态。 */
function controlledInput() {
	const stream = new Readable({ read() {} });
	return { stream, push: (line: string) => void stream.push(line) };
}

/** 轮询等待某个条件成立（用于确定性断言异步交互的顺序）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("waitFor: condition not met within timeout");
}

function readEvents(home: string, sessionId: SessionId): SessionEvent[] {
	return readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

/** 装配「真实 4 原语工具」的运行环境（不含权限钩子，由 REPL 自行接线）。 */
function makeTools() {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() }))
		registry.register(tool);
	return { ctx, registry };
}

function toolContext(cwd: string, mode: AgentMode = "build"): ToolCallContext {
	return { sessionId: "ses_m6", callId: "call_m6" as ToolCallId, mode, cwd };
}

function writeCall(path: string, id: string): ToolCallRef {
	return { callId: id as ToolCallId, toolName: "write", input: { path, content: "m6\n" } };
}

const ASK_VERDICT: PermissionVerdict = {
	decision: "ask",
	reason: "writing outside the workspace requires approval",
};

function writeRequest(path: string, cwd: string): PermissionRequest {
	return {
		metadata: createWriteTool().metadata,
		resolvedInput: { path },
		mode: "build",
		cwd,
	};
}

describe("M6 审批流：once / always / reject（含会话内规则沉淀）", () => {
	it("y=仅本次放行；a=沉淀为同工具同作用域规则（后续不再提问）；n=拒绝", async () => {
		const cwd = newTemp("chenxi-m6-approve-");
		const outside = join(newTemp("chenxi-m6-elsewhere-"), "outside.txt");
		const inside = join(cwd, "inside.txt");

		const questions: string[] = [];
		const answers = ["y", "a", "n"];
		const gate = createApprovalGate({
			ask: async (question) => {
				questions.push(question);
				return answers.shift() ?? "n";
			},
		});

		const outsideReq = writeRequest(outside, cwd);
		const insideReq = writeRequest(inside, cwd);

		// 1) `y` -> 仅本次放行，**不沉淀**任何规则
		expect(await gate.approve(outsideReq, ASK_VERDICT)).toBe(true);
		expect(gate.rules.list()).toHaveLength(0);

		// 2) `a` -> 沉淀为会话内规则（作用域按 scope.ts 判定，与判定层同一套）
		expect(await gate.approve(outsideReq, ASK_VERDICT)).toBe(true);
		expect(gate.rules.list().map((rule) => `${rule.toolName}@${rule.scope}`)).toEqual([
			"write@outside",
		]);

		// 同工具 + 同作用域：**不再提问**，直接放行
		const askedBefore = questions.length;
		expect(await gate.approve(outsideReq, ASK_VERDICT)).toBe(true);
		expect(questions.length).toBe(askedBefore);

		// 3) 作用域不同（workspace）-> 规则不泛化，仍需提问；`n` -> 拒绝
		expect(await gate.approve(insideReq, ASK_VERDICT)).toBe(false);

		// 4) 无法识别/空答案 -> fail-closed 拒绝
		expect(parseApprovalAnswer("y")).toBe("once");
		expect(parseApprovalAnswer("A")).toBe("always");
		expect(parseApprovalAnswer("???")).toBe("reject");
		expect(parseApprovalAnswer("")).toBe("reject");
	});
});

describe("M6 CLI 集成：审批答案取自同一 stdin 的下一行", () => {
	it("build 下越权写 -> 现场提问 -> `a` 作答放行；下一回合同键不再提问", async () => {
		const home = newTemp("chenxi-m6-home-");
		const cwd = newTemp("chenxi-m6-cwd-");
		const elsewhere = newTemp("chenxi-m6-outside-");
		const outside = join(elsewhere, "out.txt");

		const provider = createStubProvider([
			{ content: "", toolCalls: [writeCall(outside, "c1")], stopReason: "tool_call" },
			{ content: "done-1", stopReason: "end_turn" },
			{ content: "", toolCalls: [writeCall(outside, "c2")], stopReason: "tool_call" },
			{ content: "done-2", stopReason: "end_turn" },
		]);
		const collected = collector();
		const input = controlledInput();

		const run = runSessionRepl({
			home,
			cwd,
			provider,
			model: "stub-model",
			mode: "build",
			permission: createPermissionSystem(),
			tools: makeTools(),
			input: input.stream,
			output: collected.output,
		});

		input.push("write outside the workspace\n");
		await waitFor(() => collected.text().includes("allow? [y] once"));
		input.push("a\n");
		await waitFor(() => collected.text().includes("done-1"));

		// 第二回合：同工具同作用域已沉淀规则 -> 不应再出现审批提问
		input.push("write outside again\n");
		await waitFor(() => collected.text().includes("done-2"));

		// `/approvals` 应能看到已沉淀的会话内规则
		input.push("/approvals\n");
		await waitFor(() => collected.text().includes("write@outside"));

		input.push("/exit\n");
		const { sessionId } = await run;

		expect(collected.text().match(/allow\? \[y\] once/g) ?? []).toHaveLength(1);
		const decisions = readEvents(home, sessionId).filter(
			(event) => event.type === "permission/decision",
		);
		expect(decisions.length).toBe(2);
		for (const decision of decisions) {
			if (decision.type === "permission/decision") {
				expect(decision.payload.decision).toBe("allow");
				expect(decision.payload.reason).toContain("approved by user");
			}
		}
	});
});

describe("M6 --resume latest", () => {
	it("续上最近更新的会话：同一 sessionId，且历史可见", async () => {
		const home = newTemp("chenxi-m6-resume-");
		const first = await runSessionRepl({
			home,
			provider: createStubProvider([{ content: "hi", stopReason: "end_turn" }]),
			model: "stub-model",
			input: Readable.from(["hello\n", "/exit\n"]),
			output: collector().output,
		});

		const collected = collector();
		const second = await runSessionRepl({
			home,
			resume: "latest",
			provider: createStubProvider([{ content: "again", stopReason: "end_turn" }]),
			model: "stub-model",
			input: Readable.from(["/exit\n"]),
			output: collected.output,
		});

		expect(second.sessionId).toBe(first.sessionId);
		expect(collected.text()).toContain("resumed with");
		expect(collected.text()).toContain("history(");
		expect(collected.text()).toContain("hello");
	});
});

describe("M6 SIGINT 优雅中断", () => {
	it("一次中止当前回合（turn/end 为 error）；二次退出并落 session/end{interrupted}", async () => {
		const home = newTemp("chenxi-m6-sigint-");
		const cwd = newTemp("chenxi-m6-sigint-cwd-");

		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});

		/** 迟迟不产出的 provider：只在收到 abort 时抛错，用于确定性触发「回合被中断」。 */
		const provider: LlmProvider = {
			id: "slow",
			async *stream(request) {
				markStarted();
				await new Promise<void>((_resolve, reject) => {
					const signal = request.signal;
					if (signal === undefined) return;
					signal.addEventListener("abort", () => reject(new Error("aborted by user")), {
						once: true,
					});
				});
				yield {
					kind: "done",
					message: { content: "never", toolCalls: [], stopReason: "end_turn" },
				};
			},
		};

		const collected = collector();
		const input = controlledInput();
		const run = runSessionRepl({
			home,
			cwd,
			provider,
			model: "slow-model",
			input: input.stream,
			output: collected.output,
		});

		input.push("hello\n");
		await started;

		process.emit("SIGINT"); // 第一次：中止当前回合
		await waitFor(() => collected.text().includes("turn aborted"));

		process.emit("SIGINT"); // 第二次：退出
		const { sessionId } = await run;

		const events = readEvents(home, sessionId);
		const turnEnd = events.find((event) => event.type === "turn/end");
		expect(turnEnd?.type).toBe("turn/end");
		if (turnEnd?.type === "turn/end") expect(turnEnd.payload.stopReason).toBe("error");

		const sessionEnd = events.find((event) => event.type === "session/end");
		expect(sessionEnd?.type).toBe("session/end");
		if (sessionEnd?.type === "session/end") expect(sessionEnd.payload.reason).toBe("interrupted");

		expect(collected.text()).toContain("interrupting current turn");
		expect(collected.text()).toContain("(exit)");
	});
});

describe("M6 --doctor 环境自检", () => {
	it("关键项全通过 -> 退出码 0；且端点只报 set/unset，绝不打印密钥值", async () => {
		const home = newTemp("chenxi-m6-doctor-");
		const collected = collector();
		const code = await runDoctor({
			home,
			output: collected.output,
			env: {
				CHENXI_BASE_URL: "https://example.invalid/v1",
				CHENXI_API_KEY: "sk-super-secret-value",
				CHENXI_MODEL: "some-model",
			},
			nodeVersion: "22.23.2",
			platform: "win32",
		});

		expect(code).toBe(0);
		expect(collected.text()).toContain("node:sqlite");
		expect(collected.text()).toContain("home-writable");
		expect(collected.text()).toContain("CHENXI_API_KEY=set");
		expect(collected.text()).not.toContain("sk-super-secret-value");
		expect(collected.text()).toContain("OK: all critical checks passed.");
	});

	it("Node 版本过低 -> 退出码 1", async () => {
		const collected = collector();
		const code = await runDoctor({
			home: newTemp("chenxi-m6-doctor-old-"),
			output: collected.output,
			env: {},
			nodeVersion: "20.10.0",
			platform: "win32",
		});

		expect(code).toBe(1);
		expect(collected.text()).toContain("✖ node");
		expect(collected.text()).toContain("FAILED");
	});

	it("parseArgs 接受 `--doctor` 与 `--resume latest`", () => {
		expect(parseArgs(["--doctor"]).doctor).toBe(true);
		expect(parseArgs(["--resume", "latest"]).resume).toBe("latest");
	});
});

describe("M6 read 输出上限", () => {
	it("字节超限 -> 截断且 truncatedReason=bytes（content 不超过上限）", async () => {
		const ctx = createContext();
		const registry = createToolRegistry(ctx);
		registry.register(createReadTool());
		const cwd = newTemp("chenxi-m6-read-bytes-");
		writeFileSync(join(cwd, "big.txt"), "x".repeat(200_000), "utf8");

		const result = await executeTool({
			ctx,
			registry,
			call: { callId: "c1" as ToolCallId, toolName: "read", input: { path: "big.txt" } },
			context: toolContext(cwd),
		});
		if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);

		const value = result.value as { content: string; truncated: boolean; truncatedReason?: string };
		expect(value.truncated).toBe(true);
		expect(value.truncatedReason).toBe("bytes");
		expect(Buffer.byteLength(value.content, "utf8")).toBeLessThanOrEqual(65_536);
	});

	it("行窗口截断 -> truncatedReason=window", async () => {
		const ctx = createContext();
		const registry = createToolRegistry(ctx);
		registry.register(createReadTool());
		const cwd = newTemp("chenxi-m6-read-window-");
		writeFileSync(
			join(cwd, "lines.txt"),
			Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"),
			"utf8",
		);

		const result = await executeTool({
			ctx,
			registry,
			call: {
				callId: "c1" as ToolCallId,
				toolName: "read",
				input: { path: "lines.txt", offset: 2, limit: 3 },
			},
			context: toolContext(cwd),
		});
		if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);

		const value = result.value as {
			content: string;
			truncated: boolean;
			truncatedReason?: string;
		};
		expect(value.content).toBe("line 2\nline 3\nline 4");
		expect(value.truncated).toBe(true);
		expect(value.truncatedReason).toBe("window");
	});
});
