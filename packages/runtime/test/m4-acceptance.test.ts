/**
 * M4 验收测试（总工程师独立编写）：权限治理与默认双模式。
 *
 *  - 判据 #10：**plan 模式下写操作必被拒**；切到 `build` 后**同请求通过**。
 *  - 判据 #2：写越权 → `permission_denied` + **可读错误** + `permission/decision` 事件 + `retryable=false`。
 *  - ADR-006 不变量 3：**guard 只能否决、不能放行**（单调）。
 *  - ADR-007：`ask` 在无审批通道时 **fail-closed → deny**。
 *  - ADR-013：模式 → 权限是**默认配置**；切换后约束立即生效（每请求对账）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
	AgentMode,
	EventDraft,
	EventType,
	PermissionDecisionPayload,
	ToolCallId,
	ToolCallRef,
} from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionRepl } from "../src/cli/repl.js";
import { createContextBuilder } from "../src/context/index.js";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import { runTurn } from "../src/loop/index.js";
import {
	createPermissionHook,
	createPermissionSystem,
	isInsideRoot,
} from "../src/permission/index.js";
import type { EventLog } from "../src/session/index.js";
import { createEventLog } from "../src/session/index.js";
import { selectShellProvider } from "../src/shell/index.js";
import { createDefaultToolset, createToolRegistry } from "../src/tools/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];

function newWorkdir(): string {
	const dir = makeTempDir("aster-m4-");
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function callId(id: string): ToolCallId {
	return id as ToolCallId;
}

function appenderFor(log: EventLog) {
	return async <T extends EventType>(draft: EventDraft<T>) => log.append(draft);
}

function toolCallStep(name: string, input: unknown, id: string) {
	return {
		content: "",
		toolCalls: [{ callId: callId(id), toolName: name, input }] as ToolCallRef[],
		stopReason: "tool_call" as const,
	};
}

/**
 * 装配「真实 4 原语工具 + 权限钩子」的运行环境。
 * `record` 缺省把判定落 `permission/decision` 事件（可审计）；同时收集到 `sink`。
 */
function makeRuntime(log: EventLog, sink?: PermissionDecisionPayload[]) {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() })) {
		registry.register(tool);
	}
	const system = createPermissionSystem();
	const hook = createPermissionHook({
		system,
		record: (payload) => {
			sink?.push(payload);
			// EventLog.append 是**同步**的（返回事件）；persist 的 handle.append 才是 async
			log.append({ type: "permission/decision", payload });
		},
	});
	return { system, tools: { ctx, registry, beforeHooks: [hook] } };
}

async function runScripted(p: {
	log: EventLog;
	script: readonly { content: string; toolCalls?: ToolCallRef[]; stopReason: string }[];
	mode: AgentMode;
	cwd: string;
	tools: ReturnType<typeof makeRuntime>["tools"];
}) {
	return runTurn({
		log: p.log,
		append: appenderFor(p.log),
		// biome-ignore lint/suspicious/noExplicitAny: 测试内桩 provider 的脚本形状与 StubScript 一致
		provider: createStubProvider(p.script as any),
		model: "stub-model",
		mode: p.mode,
		cwd: p.cwd,
		tools: p.tools,
	});
}

function firstToolResult(log: EventLog) {
	const event = log.events.find((candidate) => candidate.type === "tool/result");
	return event?.type === "tool/result" ? event.payload : undefined;
}

describe("M4 判据 #10：plan 写操作必被拒；build 通过", () => {
	it("同一请求：plan 被拒且文件不变；build 通过且文件被改", async () => {
		const cwd = newWorkdir();
		const note = join(cwd, "note.txt");
		writeFileSync(note, "alpha\n", "utf8");
		const edit = { path: "note.txt", oldText: "alpha", newText: "beta" };

		// ---- plan 模式：写操作必被拒 ----
		const planLog = createEventLog({ sessionId: "ses_m4_plan" as never });
		const planDecisions: PermissionDecisionPayload[] = [];
		const plan = makeRuntime(planLog, planDecisions);
		await runScripted({
			log: planLog,
			script: [toolCallStep("edit", edit, "c1"), { content: "denied", stopReason: "end_turn" }],
			mode: "plan",
			cwd,
			tools: plan.tools,
		});

		const denied = firstToolResult(planLog);
		expect(denied?.ok).toBe(false);
		expect(denied?.error?.code).toBe("permission_denied");
		expect(denied?.error?.retryable).toBe(false);
		expect(denied?.error?.message ?? "").toContain("PLAN mode");
		expect(denied?.error?.message ?? "").toContain("Do not retry");
		expect(readFileSync(note, "utf8")).toBe("alpha\n"); // 文件未被改动

		// 判定作为**事实**落盘（可审计）
		const decision = planLog.events.find((event) => event.type === "permission/decision");
		expect(decision?.type).toBe("permission/decision");
		expect(planDecisions[0]?.decision).toBe("deny");

		// ---- 切到 build：同一请求通过 ----
		const buildLog = createEventLog({ sessionId: "ses_m4_build" as never });
		const buildDecisions: PermissionDecisionPayload[] = [];
		const build = makeRuntime(buildLog, buildDecisions);
		await runScripted({
			log: buildLog,
			script: [toolCallStep("edit", edit, "c2"), { content: "done", stopReason: "end_turn" }],
			mode: "build",
			cwd,
			tools: build.tools,
		});

		const allowed = firstToolResult(buildLog);
		expect(allowed?.ok).toBe(true);
		expect(readFileSync(note, "utf8")).toBe("beta\n");
		expect(buildDecisions[0]?.decision).toBe("allow");
	});
});

describe("M4 判据 #2：越权写被拒（可读错误 + 事件）", () => {
	it("plan 模式下写 workspace 之外 → permission_denied，可读错误，retryable=false", async () => {
		const cwd = newWorkdir();
		const log = createEventLog({ sessionId: "ses_m4_deny" as never });
		const runtime = makeRuntime(log);
		const outside = join(cwd, "..", "should-not-be-written.txt");

		await runScripted({
			log,
			script: [
				toolCallStep("write", { path: outside, content: "nope" }, "c1"),
				{ content: "understood, not writing", stopReason: "end_turn" },
			],
			mode: "plan",
			cwd,
			tools: runtime.tools,
		});

		const denied = firstToolResult(log);
		expect(denied?.ok).toBe(false);
		expect(denied?.error?.code).toBe("permission_denied");
		expect(denied?.error?.retryable).toBe(false);
		expect(denied?.error?.message ?? "").not.toContain("at Object."); // 是给人看的话，不是堆栈

		const decision = log.events.find((event) => event.type === "permission/decision");
		expect(decision?.type).toBe("permission/decision");
		if (decision?.type === "permission/decision") {
			expect(decision.payload.decision).toBe("deny");
			expect(decision.payload.reason.length).toBeGreaterThan(0);
		}
	});

	it("build 模式下写 workspace 之外 → ask，无审批通道时 fail-closed 拒绝", async () => {
		const cwd = newWorkdir();
		const log = createEventLog({ sessionId: "ses_m4_ask" as never });
		const runtime = makeRuntime(log);

		await runScripted({
			log,
			script: [
				toolCallStep("write", { path: join(cwd, "..", "outside.txt"), content: "x" }, "c1"),
				{ content: "ok", stopReason: "end_turn" },
			],
			mode: "build",
			cwd,
			tools: runtime.tools,
		});

		const denied = firstToolResult(log);
		expect(denied?.ok).toBe(false);
		expect(denied?.error?.code).toBe("permission_denied");
		expect(denied?.error?.message ?? "").toContain("fail-closed");
	});
});

describe("M4 ADR-006：单调 guard 只能否决、不能放行", () => {
	it("guard 可把 allow 降级为 deny；但 guard 通过**无法**把 deny 翻成 allow", async () => {
		const cwd = newWorkdir();

		// (a) build + 写 workspace 内 = 规则 allow；guard 否决 → deny
		const logA = createEventLog({ sessionId: "ses_guard_a" as never });
		const decisionsA: PermissionDecisionPayload[] = [];
		const runtimeA = makeRuntime(logA, decisionsA);
		runtimeA.system.addGuard("no-writes-at-all", (request) => request.metadata.readOnly);

		await runScripted({
			log: logA,
			script: [
				toolCallStep("write", { path: join(cwd, "b.txt"), content: "y" }, "c1"),
				{ content: "ok", stopReason: "end_turn" },
			],
			mode: "build",
			cwd,
			tools: runtimeA.tools,
		});
		const resultA = firstToolResult(logA);
		expect(resultA?.ok).toBe(false);
		expect(resultA?.error?.code).toBe("permission_denied");
		expect(decisionsA[0]?.deniedBy).toBe("no-writes-at-all");

		// (b) plan + edit = 规则 deny；guard 恒真也无法放行
		const logB = createEventLog({ sessionId: "ses_guard_b" as never });
		const decisionsB: PermissionDecisionPayload[] = [];
		const runtimeB = makeRuntime(logB, decisionsB);
		runtimeB.system.addGuard("always-true", () => true);
		writeFileSync(join(cwd, "note.txt"), "alpha", "utf8");

		await runScripted({
			log: logB,
			script: [
				toolCallStep("edit", { path: join(cwd, "note.txt"), oldText: "a", newText: "b" }, "c1"),
				{ content: "ok", stopReason: "end_turn" },
			],
			mode: "plan",
			cwd,
			tools: runtimeB.tools,
		});
		expect(firstToolResult(logB)?.ok).toBe(false);
		expect(decisionsB[0]?.decision).toBe("deny");
	});
});

describe("M4 ADR-013：模式对账必须**送达模型**（CLI 级）", () => {
	it("真实请求里含 system 段，且切换模式后 system 段随之改变", async () => {
		const home = newWorkdir();
		const provider = createStubProvider([
			{ content: "ok-1", stopReason: "end_turn" },
			{ content: "ok-2", stopReason: "end_turn" },
		]);
		const collected: string[] = [];

		await runSessionRepl({
			home,
			provider,
			model: "stub-model",
			contextBuilder: createContextBuilder(),
			tools: makeRuntime(createEventLog({ sessionId: "ses_ctx" as never })).tools,
			input: Readable.from(["first\n", "/mode build\n", "second\n", "/exit\n"]),
			output: { write: (text) => void collected.push(text) },
		});

		expect(provider.calls).toHaveLength(2);
		const first = provider.calls[0]?.messages[0];
		const second = provider.calls[1]?.messages[0];
		expect(first?.role).toBe("system");
		expect(first?.content).toContain("PLAN mode");
		expect(second?.role).toBe("system");
		expect(second?.content).toContain("BUILD mode");
		// 工具清单与身份段也在系统提示里（不是靠模型猜）
		expect(first?.content).toContain("Aster");
		expect(first?.content).toContain("read");
		// 模式切换事件已落盘
		expect(collected.join("")).toContain("mode: plan -> build");
	});
});

describe("M4 作用域判定：isInsideRoot", () => {
	it("同根/子路径为 inside；父目录与别处为 outside", () => {
		const root = join(makeTempDir("aster-m4-scope-"), "work");
		mkdirSync(root, { recursive: true });
		temps.push(root);
		expect(isInsideRoot(root, root)).toBe(true);
		expect(isInsideRoot(join(root, "a", "b.txt"), root)).toBe(true);
		expect(isInsideRoot(join(root, "..", "x.txt"), root)).toBe(false);
		expect(isInsideRoot("C:\\somewhere-else\\x.txt", root)).toBe(false);
	});
});
