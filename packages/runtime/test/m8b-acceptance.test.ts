/**
 * M8b 验收测试（总工程师独立编写）：子代理 `fork` 与 `background` 的**跨模块契约**（ADR-018），
 * 不重复模块单测。
 *
 * 覆盖：
 *  - **`fork` = 导入即记录**：子会话里真的落了 `subagent/context-imported`，其 payload **逐条等于**
 *    派发那一刻父会话的投影（快照语义：派发之后再往父日志追加，不会回溯改子会话历史），
 *    且它落在 `prompt`（`user/message`）**之前**；投影展开**幂等**、结果与"父历史 + prompt"逐条一致；
 *  - **`fork` 缺父会话访问权 -> 快速失败**：绝不静默降级成 `fresh`，且**不产生子会话**；
 *  - **`background` = 立刻返回句柄 + 结果落父会话**：`status:"running"` 是工具的唯一产物，
 *    之后父会话 JSONL 里**恰好一条** `subagent/result`；
 *  - **父侧投影规则**：只送达「晚于最后一条 `assistant/message`」的结果——模型一旦产生新的
 *    assistant 消息，该结果即视为已确认，**不再重复送达**（不堆积、不重复，无需状态）；
 *  - **后台写入复用父句柄**：seq 单调、JSONL 与派生索引一致（用 `resume` 重放来证明）；
 *  - **父句柄不可写时静默丢弃**：后台 flow 绝不抛出未处理异常；
 *  - **权限沿用 ADR-017**：`background` 不改变元数据语义，`plan` 下仍被拒且**不产生子会话**。
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
	SessionEvent,
	SessionLogAccess,
	ToolCallContext,
	ToolCallId,
	ToolCallRef,
} from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import { createPermissionHook, createPermissionSystem } from "../src/permission/index.js";
import type { SessionHandle } from "../src/persist/index.js";
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

function step(
	content: string,
	toolCalls: readonly { name: string; input: unknown; id: string }[] = [],
) {
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

/** 装配：4 原语 + `task`（子代理一个 step 就结束，脚本可复用于每条用例）。 */
function makeHarness(options: { home: string; cwd: string; script?: ReturnType<typeof step>[] }) {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() }))
		registry.register(tool);

	const permission = createPermissionSystem();
	const provider = createStubProvider(options.script ?? [step("CHILD-SUMMARY")]);
	const runner = createSubagentRunner({
		home: options.home,
		cwd: options.cwd,
		mode: "plan", // 缺省；实际以当次调用的 context.mode 为准
		model: "stub-model",
		provider,
		permission,
	});
	registry.register(createTaskTool(runner));
	return { ctx, registry, permission, runner, hook: createPermissionHook({ system: permission }) };
}

/** 建一个真实的父会话句柄，并把它包装成 `sessionLog`（= 主循环给工具的那份访问权）。 */
async function makeParent(options: { home: string; cwd: string }): Promise<{
	store: ReturnType<typeof createSessionStore>;
	handle: SessionHandle;
	access: SessionLogAccess;
	close(): Promise<void>;
}> {
	const store = createSessionStore({ home: options.home });
	const handle = await store.create({ cwd: options.cwd, mode: "build" });
	return {
		store,
		handle,
		access: { events: handle.log.events, append: handle.append },
		async close() {
			await handle.close();
			await store.dispose();
		},
	};
}

async function runTask(
	harness: ReturnType<typeof makeHarness>,
	options: {
		cwd: string;
		mode: "plan" | "build";
		input?: Record<string, unknown>;
		sessionLog?: SessionLogAccess;
		parentSessionId?: string;
	},
) {
	const context: ToolCallContext = {
		sessionId: options.parentSessionId ?? "ses_parent",
		callId: callId("p1"),
		mode: options.mode,
		cwd: options.cwd,
		...(options.sessionLog === undefined ? {} : { sessionLog: options.sessionLog }),
	};
	return executeTool({
		ctx: harness.ctx,
		registry: harness.registry,
		call: {
			callId: callId("p1"),
			toolName: "task",
			input: { prompt: "do the subtask", ...(options.input ?? {}) },
		},
		context,
		beforeHooks: [harness.hook],
	});
}

describe("M8b `fork`：导入即记录（ADR-018）", () => {
	it("子会话落 `subagent/context-imported`，payload 逐条 = 派发那刻的父投影，且先于 prompt", async () => {
		const home = newTemp("chenxi-m8b-fork-home-");
		const cwd = newTemp("chenxi-m8b-fork-cwd-");
		const harness = makeHarness({ home, cwd });
		const parent = await makeParent({ home, cwd });

		await parent.handle.append({ type: "user/message", payload: { content: "PARENT-Q1" } });
		await parent.handle.append({
			type: "assistant/message",
			payload: { content: "PARENT-A1", stopReason: "end_turn" },
		});
		// 派发那一刻的父投影（**快照**语义的基准）
		const expected = deriveMessages(parent.handle.log.events);

		const result = await runTask(harness, {
			cwd,
			mode: "build",
			input: { kind: "fork", prompt: "FORK-PROMPT" },
			sessionLog: parent.access,
			parentSessionId: parent.handle.sessionId,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const output = result.value as { childSessionId: string; kind: string; status: string };
		expect(output.kind).toBe("fork");
		expect(output.status).toBe("completed");

		// 派发之后再往父日志追加：**不得**回溯改子会话已记下的导入（快照语义）
		await parent.handle.append({ type: "user/message", payload: { content: "PARENT-Q2-LATER" } });

		const childEvents = readSessionEvents(home, output.childSessionId);
		const imported = childEvents.find((event) => event.type === "subagent/context-imported");
		expect(imported).toBeDefined();
		if (imported?.type !== "subagent/context-imported") return;
		expect(imported.payload.messages).toEqual(expected); // 逐条记录在案
		expect(JSON.stringify(imported.payload.messages)).not.toContain("PARENT-Q2-LATER");

		// 顺序：导入 -> prompt（user/message）
		const types = childEvents.map((event) => event.type);
		expect(types.indexOf("subagent/context-imported")).toBeLessThan(types.indexOf("user/message"));

		// 投影展开 = 父投影 + prompt + 子代理自己的最终回答，且**幂等**
		const projected = deriveMessages(childEvents);
		expect(projected).toEqual([
			...expected,
			{ role: "user", content: "FORK-PROMPT" },
			{ role: "assistant", content: "CHILD-SUMMARY" },
		]);
		expect(deriveMessages(childEvents)).toEqual(projected);

		await parent.close();
	});

	it("缺父会话访问权 -> 快速失败（可读原因），且**不产生**子会话（绝不静默降级成 fresh）", async () => {
		const home = newTemp("chenxi-m8b-forkfail-home-");
		const cwd = newTemp("chenxi-m8b-forkfail-cwd-");
		const harness = makeHarness({ home, cwd });

		// 直接派发：不给 sessionLog
		await expect(
			harness.runner.dispatch({ prompt: "x", kind: "fork", mode: "build" }),
		).rejects.toThrow(/requires parent session access/);

		// 走完整工具流水线：错误同样是**可读**的 execution_error
		const result = await runTask(harness, {
			cwd,
			mode: "build",
			input: { kind: "fork" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("execution_error");
			expect(result.error.message).toContain("requires parent session access");
		}

		const store = createSessionStore({ home });
		expect(await store.list()).toEqual([]); // 快速失败发生在**建会话之前**
		await store.dispose();
	});
});

describe("M8b `background`：立刻返回句柄 + 结果落父会话（ADR-018）", () => {
	it('工具只回 `status:"running"`；drain 后父会话**恰好一条** `subagent/result`，seq 与索引一致', async () => {
		const home = newTemp("chenxi-m8b-bg-home-");
		const cwd = newTemp("chenxi-m8b-bg-cwd-");
		const harness = makeHarness({ home, cwd, script: [step("BG-SUMMARY")] });
		const parent = await makeParent({ home, cwd });
		const parentId = parent.handle.sessionId;
		const before = parent.handle.log.length;

		const result = await runTask(harness, {
			cwd,
			mode: "build",
			input: { prompt: "long job", background: true },
			sessionLog: parent.access,
			parentSessionId: parentId,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const output = result.value as {
			childSessionId: string;
			kind: string;
			status: string;
			summary?: string;
		};
		// **立刻**返回句柄：没有 summary，只有一个 running 的句柄
		expect(output.status).toBe("running");
		expect(output.summary).toBeUndefined();

		// 子会话已建好（可审计）
		const childStore = createSessionStore({ home });
		const childMetas = await childStore.list();
		await childStore.dispose();
		expect(childMetas.map((meta) => meta.sessionId)).toContain(output.childSessionId);

		// 收尾：结果**落父会话**（且只有一条）
		await harness.runner.drain();
		const parentEvents = readSessionEvents(home, parentId);
		const results = parentEvents.filter((event) => event.type === "subagent/result");
		expect(results).toHaveLength(1);
		if (results[0]?.type !== "subagent/result") return;
		expect(results[0].payload).toMatchObject({
			childSessionId: output.childSessionId,
			kind: "fresh",
			ok: true,
			summary: "BG-SUMMARY",
		});

		// 复用父句柄 => seq 单调、JSONL 与索引一致：用 resume 重放来证明
		expect(parent.handle.log.length).toBe(before + 1);
		await parent.close();
		const store = createSessionStore({ home });
		const resumed = await store.resume(parentId); // 重放会校验 seq 单调 / id 与 seq 一致
		expect(resumed.log.events[resumed.log.length - 1]?.type).toBe("subagent/result");
		const metas = await store.list();
		expect(metas.find((meta) => meta.sessionId === parentId)?.eventCount).toBe(resumed.log.length);
		await store.dispose();
	});

	it("父句柄写不进去时**静默丢弃**：drain 正常返回，绝不抛出未处理异常", async () => {
		const home = newTemp("chenxi-m8b-bgdropped-home-");
		const cwd = newTemp("chenxi-m8b-bgdropped-cwd-");
		const harness = makeHarness({ home, cwd });

		// 模拟"父句柄已关闭 / 已封禁"：append 一律失败
		const brokenAccess: SessionLogAccess = {
			events: [],
			append: () => Promise.reject(new Error("session handle is closed")),
		};

		const result = await runTask(harness, {
			cwd,
			mode: "build",
			input: { prompt: "doomed", background: true },
			sessionLog: brokenAccess,
		});
		expect(result.ok).toBe(true);
		await expect(harness.runner.drain()).resolves.toBeUndefined();
		expect(harness.runner.inflight()).toBe(0);
	});

	it("权限沿用 ADR-017：`plan` 下 background 的 task 仍被拒，且**不产生**子会话", async () => {
		const home = newTemp("chenxi-m8b-bgplan-home-");
		const cwd = newTemp("chenxi-m8b-bgplan-cwd-");
		const harness = makeHarness({ home, cwd });
		const parent = await makeParent({ home, cwd });

		const result = await runTask(harness, {
			cwd,
			mode: "plan",
			input: { prompt: "nope", background: true },
			sessionLog: parent.access,
			parentSessionId: parent.handle.sessionId,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("permission_denied");

		const store = createSessionStore({ home });
		const metas = await store.list();
		await store.dispose();
		expect(metas.map((meta) => meta.sessionId)).toEqual([parent.handle.sessionId]);

		await parent.close();
	});
});

describe("M8b 父侧投影规则：`subagent/result` 只送达一次（ADR-018）", () => {
	function parentLog() {
		return createEventLog({ sessionId: "ses_parent" as never });
	}

	it("只投影「晚于最后一条 assistant/message」的结果：被确认后不再重复、下一条结果照常送达", () => {
		const log = parentLog();
		log.append({ type: "user/message", payload: { content: "hi" } });
		log.append({ type: "assistant/message", payload: { content: "ready" } });
		log.append({
			type: "subagent/result",
			payload: { childSessionId: "ses_c1" as never, kind: "fresh", ok: true, summary: "R1" },
		});

		const first = deriveMessages(log.events);
		expect(first).toHaveLength(3);
		expect(first[2]).toEqual({
			role: "user",
			content:
				'<subagent-result childSessionId="ses_c1" kind="fresh" status="completed">\nR1\n</subagent-result>',
		});

		// 模型产生了新的 assistant 消息 => R1 已被"确认"，不再送达
		log.append({ type: "assistant/message", payload: { content: "ok, noted" } });
		const second = deriveMessages(log.events);
		expect(JSON.stringify(second)).not.toContain("R1");
		expect(second).toHaveLength(3);

		// 新结果照常送达（且只有它送达）
		log.append({
			type: "subagent/result",
			payload: {
				childSessionId: "ses_c2" as never,
				kind: "fork",
				ok: false,
				error: "boom",
			},
		});
		const third = deriveMessages(log.events);
		expect(third).toHaveLength(4);
		expect(third[3]?.content).toContain('status="failed"');
		expect(third[3]?.content).toContain("boom");
		expect(JSON.stringify(third)).not.toContain("R1");

		// 幂等：同一序列任意次调用结果深等
		expect(deriveMessages(log.events)).toEqual(third);
	});

	it("已早于最后一条 assistant 消息的结果**不**回溯投影；未确认的多条结果各自只出现一次", () => {
		const log = parentLog();
		log.append({ type: "assistant/message", payload: { content: "a0" } });
		log.append({
			type: "subagent/result",
			payload: { childSessionId: "ses_early" as never, kind: "fresh", ok: true, summary: "EARLY" },
		});
		log.append({ type: "assistant/message", payload: { content: "a1" } });

		// EARLY 晚于 a0 但早于 a1 => 已被确认，不投影
		expect(JSON.stringify(deriveMessages(log.events))).not.toContain("EARLY");

		log.append({
			type: "subagent/result",
			payload: { childSessionId: "ses_x" as never, kind: "fresh", ok: true, summary: "X" },
		});
		log.append({
			type: "subagent/result",
			payload: { childSessionId: "ses_y" as never, kind: "fork", ok: true, summary: "Y" },
		});
		const projected = deriveMessages(log.events);
		expect(projected).toHaveLength(4); // a0, a1, X, Y
		expect(projected.filter((m) => m.content.includes("X"))).toHaveLength(1);
		expect(projected.filter((m) => m.content.includes("Y"))).toHaveLength(1);
		expect(JSON.stringify(projected)).not.toContain("EARLY");
	});
});
