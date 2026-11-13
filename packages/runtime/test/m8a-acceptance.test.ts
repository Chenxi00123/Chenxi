/**
 * M8a 验收测试（总工程师独立编写）：子代理的**跨模块契约**（ADR-017），不重复模块单测。
 *
 * 覆盖：
 *  - **隔离是结构性的**：父会话的投影里**只有**子代理的 `summary`，看不到子代理的中间文本 /
 *    工具轨迹（那些只存在子会话自己的 JSONL 里，可审计）；
 *  - `task` 通过 **ADR-005 注册期校验**，且 metadata 与 ADR-017 逐字一致；
 *  - **权限组合**：`plan` 下 `task` 被拒（元数据驱动，不新增判定分支）、`build` 下允许，
 *    且被拒发生在**执行之前**（不产生子会话）；
 *  - **子代理内无审批通道** -> `ask` 一律 fail-closed deny（workspace 之外的写被拒）；
 *  - **模式取当次调用**：runner 缺省 mode 为 `plan`，但调用上下文是 `build` 时，子代理内的
 *    workspace 内写操作**真的成功**（证明继承的是「当前」模式，而不是「建 runner 时」的模式）。
 *
 * 说明：本测试**直接调 `executeTool`**（不跑父回合），因此桩 provider 的脚本**只描述子代理自己的
 * 两步**——父侧的 `tool/call` / `tool/result` 由测试手工构造（这正是"父日志内容"的照实模拟）。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent, ToolCallContext, ToolCallId, ToolCallRef } from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { configFileSchema, loadConfig } from "../src/config/index.js";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import { createPermissionHook, createPermissionSystem } from "../src/permission/index.js";
import { createSessionStore } from "../src/persist/index.js";
import { createEventLog, deriveMessages } from "../src/session/index.js";
import { selectShellProvider } from "../src/shell/index.js";
import { createSubagentRunner, createTaskTool } from "../src/subagent/index.js";
import { createDefaultToolset, createToolRegistry, executeTool } from "../src/tools/index.js";
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

function callId(id: string): ToolCallId {
	return id as ToolCallId;
}

function step(content: string, toolCalls: readonly { name: string; input: unknown; id: string }[]) {
	return {
		content,
		toolCalls: toolCalls.map(
			(call): ToolCallRef => ({ callId: callId(call.id), toolName: call.name, input: call.input }),
		),
		stopReason: toolCalls.length === 0 ? ("end_turn" as const) : ("tool_call" as const),
	};
}

function readSessionEvents(home: string, sessionId: string): SessionEvent[] {
	return readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

/**
 * 装配父侧运行环境：4 原语 + `task`（runner 缺省 mode 固定为 `plan`，用于验证"模式取当次调用"）。
 * 桩脚本**只描述子代理**：①中间说话 + 写 `writeTarget`；②收尾给 summary。
 */
function makeHarness(options: { home: string; cwd: string; writeTarget: string }) {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() }))
		registry.register(tool);

	const permission = createPermissionSystem();
	const provider = createStubProvider([
		step("CHILD-INTERMEDIATE-TEXT", [
			{ name: "write", input: { path: options.writeTarget, content: "x\n" }, id: "c1" },
		]),
		step("CHILD-SUMMARY", []),
	]);

	const runner = createSubagentRunner({
		home: options.home,
		cwd: options.cwd,
		mode: "plan", // 缺省 = plan；真正生效的是**当次调用**的 context.mode
		model: "stub-model",
		provider,
		permission,
	});
	const taskTool = createTaskTool(runner);
	registry.register(taskTool);

	return {
		ctx,
		registry,
		permission,
		runner,
		taskTool,
		hook: createPermissionHook({ system: permission }),
	};
}

function toolContext(cwd: string, mode: "plan" | "build", id = "p1"): ToolCallContext {
	return { sessionId: "ses_parent", callId: callId(id), mode, cwd };
}

async function runTask(
	harness: ReturnType<typeof makeHarness>,
	p: { cwd: string; mode: "plan" | "build"; prompt?: string },
) {
	return executeTool({
		ctx: harness.ctx,
		registry: harness.registry,
		call: {
			callId: callId("p1"),
			toolName: "task",
			input: { prompt: p.prompt ?? "do the subtask" },
		},
		context: toolContext(p.cwd, p.mode),
		beforeHooks: [harness.hook],
	});
}

describe("M8a `task` 工具：元数据与注册期校验（ADR-005 / ADR-017）", () => {
	it("能被注册（即 input/output 都是合法 ValueSchema），metadata 与 ADR-017 一致", () => {
		const home = newTemp("chenxi-m8a-meta-");
		const cwd = newTemp("chenxi-m8a-meta-cwd-");
		const harness = makeHarness({ home, cwd, writeTarget: join(cwd, "child.txt") });

		expect(harness.registry.get("task")).toBeDefined();
		expect(harness.taskTool.metadata).toMatchObject({
			name: "task",
			readOnly: false,
			destructive: false,
			sideEffectScope: "workspace",
			riskLevel: "medium",
			needsApproval: false,
		});
		// input 必须拒掉空 prompt（schema 真的在生效）
		expect(harness.taskTool.input.parse({ prompt: "" }).ok).toBe(false);
		expect(harness.taskTool.input.parse({ prompt: "ok" }).ok).toBe(true);
		// output 必须拒掉缺字段的结果（信封真的在生效）
		expect(harness.taskTool.output.parse({ summary: "x" }).ok).toBe(false);
	});
});

describe("M8a 隔离是结构性的：父只看到 summary", () => {
	it("父投影含子代理 summary，但不含其中间文本 / 工具轨迹；子会话 JSONL 里都在", async () => {
		const home = newTemp("chenxi-m8a-iso-home-");
		const cwd = newTemp("chenxi-m8a-iso-cwd-");
		const harness = makeHarness({ home, cwd, writeTarget: join(cwd, "child.txt") });

		const result = await runTask(harness, { cwd, mode: "build" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const output = result.value as {
			childSessionId: string;
			kind: string;
			summary: string;
			steps: number;
			stopReason: string;
		};
		expect(output.kind).toBe("fresh");
		expect(output.summary).toBe("CHILD-SUMMARY");
		expect(output.steps).toBeGreaterThan(0);
		expect(output.stopReason).toBe("end_turn");

		// ---- 子会话（独立 JSONL）：中间文本与工具轨迹都在，可审计 ----
		const childEvents = readSessionEvents(home, output.childSessionId);
		const childText = JSON.stringify(childEvents);
		expect(childText).toContain("CHILD-INTERMEDIATE-TEXT");
		expect(childText).toContain("child.txt");
		const childStart = childEvents.find((event) => event.type === "session/start");
		if (childStart?.type === "session/start") {
			expect(childStart.payload.parentSessionId).toBeDefined(); // 父子关系落在事实源里
		}
		// 子会话是**独立会话**：索引里能看到它
		const store = createSessionStore({ home });
		const metas = await store.list();
		await store.dispose();
		expect(metas.map((meta) => meta.sessionId)).toContain(output.childSessionId);

		// ---- 父会话（手工照实构造）：只有 summary，没有子代理的中间文本 ----
		const call: ToolCallRef = {
			callId: callId("p1"),
			toolName: "task",
			input: { prompt: "do the subtask" },
		};
		const parentLog = createEventLog({ sessionId: "ses_parent" as never });
		parentLog.append({ type: "user/message", payload: { content: "please delegate" } });
		parentLog.append({
			type: "assistant/message",
			payload: { content: "", toolCalls: [call], stopReason: "tool_call" },
		});
		parentLog.append({
			type: "tool/result",
			payload: { callId: call.callId, toolName: "task", ok: true, output, durationMs: 1 },
		});

		const projected = deriveMessages(parentLog.events)
			.map((message) => message.content)
			.join("\n");
		expect(projected).toContain("CHILD-SUMMARY");
		expect(projected).not.toContain("CHILD-INTERMEDIATE-TEXT");
		expect(projected).not.toContain("child.txt");
	});
});

describe("M8a 配置面：`subagents` **默认关闭** + 严格校验（ADR-009 / ADR-017）", () => {
	it("enabled 必填；未知键 / 越界 maxDepth 被拒；声明后可读到；未声明时不含键", () => {
		expect(configFileSchema.safeParse({ subagents: { enabled: true } }).success).toBe(true);
		expect(configFileSchema.safeParse({ subagents: {} }).success).toBe(false); // enabled 必填
		expect(configFileSchema.safeParse({ subagents: { enabled: true, maxDepth: 0 } }).success).toBe(
			false,
		);
		expect(configFileSchema.safeParse({ subagents: { enabled: true, maxDepth: 6 } }).success).toBe(
			false,
		);
		expect(configFileSchema.safeParse({ subagents: { enabled: true, oops: 1 } }).success).toBe(
			false,
		);

		const cwd = newTemp("chenxi-m8a-cfg-");
		writeFileSync(
			join(cwd, "chenxi.config.json"),
			JSON.stringify({ subagents: { enabled: true, maxDepth: 3 } }),
			"utf8",
		);
		expect(loadConfig({ home: newTemp("chenxi-m8a-cfg-home-"), cwd, env: {} }).subagents).toEqual({
			enabled: true,
			maxDepth: 3,
		});
		// 未声明 -> 不含键（= CLI 不会注册 `task`，默认工具集仍是**恰好 4 原语**）
		expect(
			loadConfig({
				home: newTemp("chenxi-m8a-none-home-"),
				cwd: newTemp("chenxi-m8a-none-cwd-"),
				env: {},
			}).subagents,
		).toBeUndefined();
	});
});

describe("M8a 权限组合与模式继承（ADR-017）", () => {
	it("plan 下 `task` 被拒（permission_denied），且**不产生**子会话（拒绝发生在执行前）", async () => {
		const home = newTemp("chenxi-m8a-plan-home-");
		const cwd = newTemp("chenxi-m8a-plan-cwd-");
		const harness = makeHarness({ home, cwd, writeTarget: join(cwd, "child.txt") });

		const result = await runTask(harness, { cwd, mode: "plan", prompt: "nope" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("permission_denied");

		const store = createSessionStore({ home });
		const metas = await store.list();
		await store.dispose();
		expect(metas).toEqual([]);
	});

	it("模式取**当次调用**：runner 缺省 plan，但 context.mode=build 时子代理内的写**真的成功**", async () => {
		const home = newTemp("chenxi-m8a-mode-home-");
		const cwd = newTemp("chenxi-m8a-mode-cwd-");
		const target = join(cwd, "child.txt");
		const harness = makeHarness({ home, cwd, writeTarget: target });
		expect(existsSync(target)).toBe(false);

		const result = await runTask(harness, { cwd, mode: "build" });
		expect(result.ok).toBe(true);
		expect(existsSync(target)).toBe(true); // 若继承的是缺省 plan，这里会失败
	});

	it("子代理内**没有审批通道**：workspace 之外的写被 fail-closed 拒绝，且理由可读", async () => {
		const home = newTemp("chenxi-m8a-nogate-home-");
		const cwd = newTemp("chenxi-m8a-nogate-cwd-");
		const outside = join(newTemp("chenxi-m8a-outside-"), "outside.txt");
		const harness = makeHarness({ home, cwd, writeTarget: outside });

		const result = await runTask(harness, { cwd, mode: "build" });
		expect(result.ok).toBe(true); // 子代理的回合照常结束（拿到 summary）
		expect(existsSync(outside)).toBe(false); // 但内部那次越界写**没被执行**

		if (result.ok) {
			const output = result.value as { childSessionId: string };
			const childText = JSON.stringify(readSessionEvents(home, output.childSessionId));
			expect(childText).toContain("fail-closed"); // 无审批通道 -> deny，理由写进子会话事实源
		}
	});
});
