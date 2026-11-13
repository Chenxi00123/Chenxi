/**
 * subagent（M8a：`fresh` 派发）单元测试。
 *
 * 全部自洽：桩 provider（`createStubProvider`，**绝不联网**）+ 真 `createSessionStore` +
 * 真 `createPermissionSystem` + 临时目录。深度上限是**行为可证**的——用子会话日志里的
 * `tool/result` 载荷断言，而不是靠提示词约定。
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
	SessionEvent,
	SessionId,
	ToolCallContext,
	ToolCallId,
	ToolCallRef,
} from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/events/index.js";
import { createStubProvider, type StubScript } from "../src/llm/index.js";
import { createPermissionSystem } from "../src/permission/index.js";
import { createSessionStore } from "../src/persist/index.js";
import { createSubagentRunner, createTaskTool } from "../src/subagent/index.js";
import { createToolRegistry, executeTool } from "../src/tools/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

/** 建一个 `task` 工具调用（子代理自己发起的递归派发）。 */
function taskCall(id: string, prompt: string): ToolCallRef {
	return { callId: id as ToolCallId, toolName: "task", input: { prompt } };
}

/** 一个「发起 toolCall」的桩脚本步骤。 */
function toolCallStep(call: ToolCallRef): StubScript {
	return { content: "", toolCalls: [call], stopReason: "tool_call" };
}

/** 从独立子会话 JSONL 读回事件（JSONL 是唯一事实源）。 */
async function readEvents(home: string, sessionId: SessionId): Promise<readonly SessionEvent[]> {
	const store = createSessionStore({ home });
	const handle = await store.resume(sessionId);
	try {
		return [...handle.log.events];
	} finally {
		await store.dispose();
	}
}

/** `<home>/sessions` 下的会话文件数（用于断言「真的多了一层」）。 */
function listSessionFiles(home: string): string[] {
	const dir = join(home, "sessions");
	return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")) : [];
}

function findToolResult(events: readonly SessionEvent[]) {
	const event = events.find((candidate) => candidate.type === "tool/result");
	return event?.type === "tool/result" ? event.payload : undefined;
}

function startPayload(events: readonly SessionEvent[]) {
	const event = events.find((candidate) => candidate.type === "session/start");
	return event?.type === "session/start" ? event.payload : undefined;
}

function userMessageContent(events: readonly SessionEvent[]): string | undefined {
	const event = events.find((candidate) => candidate.type === "user/message");
	return event?.type === "user/message" ? event.payload.content : undefined;
}

describe("M8a subagent runner: fresh 派发 = 独立会话", () => {
	it("建独立子会话、继承父会话 id、落 prompt、返回 summary/steps/stopReason", async () => {
		const home = newTemp("chenxi-m8a-home-");
		const cwd = newTemp("chenxi-m8a-cwd-");
		const parentSessionId = "ses_m8a_parent" as SessionId;
		const provider = createStubProvider({ content: "subagent says hi", stopReason: "end_turn" });

		const runner = createSubagentRunner({
			home,
			cwd,
			mode: "build",
			model: "stub-model",
			provider,
			permission: createPermissionSystem(),
			parentSessionId,
			maxDepth: 2,
		});

		expect(runner.depth).toBe(0);
		expect(runner.maxDepth).toBe(2);

		const result = await runner.dispatch({ prompt: "do it" });

		expect(result.kind).toBe("fresh");
		expect(result.summary).toBe("subagent says hi"); // = 桩 provider 最终 content
		expect(result.steps).toBeGreaterThanOrEqual(1);
		expect(result.stopReason).toBe("end_turn");

		// 子会话确实落在 <home>/sessions 里
		expect(existsSync(join(home, "sessions", `${result.childSessionId}.jsonl`))).toBe(true);

		const events = await readEvents(home, result.childSessionId);
		// session/start.parentSessionId === 传进去的父 id
		expect(startPayload(events)?.parentSessionId).toBe(parentSessionId);
		// prompt 落成子会话的 user/message
		expect(userMessageContent(events)).toBe("do it");
		// 子代理产生了 assistant/message
		expect(events.some((event) => event.type === "assistant/message")).toBe(true);
		// 收尾：session/end（成功 = exit）
		const end = events.find((event) => event.type === "session/end");
		expect(end?.type === "session/end" ? end.payload.reason : undefined).toBe("exit");
	});
});

describe("M8a 结构性防递归：靠 task 工具是否存在", () => {
	it("maxDepth=1：子会话**不**注册 task；子代理调用 task 得到错误结果", async () => {
		const home = newTemp("chenxi-m8a-d1-");
		const cwd = newTemp("chenxi-m8a-d1-cwd-");
		const provider = createStubProvider([
			toolCallStep(taskCall("call_task_1", "inner")),
			{ content: "no task tool here", stopReason: "end_turn" },
		]);

		const runner = createSubagentRunner({
			home,
			cwd,
			mode: "build",
			model: "stub-model",
			provider,
			permission: createPermissionSystem(),
			parentSessionId: "ses_m8a_p1" as SessionId,
			maxDepth: 1,
		});
		expect(runner.maxDepth).toBe(1);

		const result = await runner.dispatch({ prompt: "do it" });

		// 子代理的失败体现在最终文本里
		expect(result.summary).toBe("no task tool here");
		expect(result.stopReason).toBe("end_turn");
		expect(result.steps).toBe(2);

		const events = await readEvents(home, result.childSessionId);
		const failure = findToolResult(events);
		expect(failure?.toolName).toBe("task");
		expect(failure?.ok).toBe(false);
		expect(failure?.error?.code).toBe("unknown_tool");

		// 没有第二层子会话产生
		expect(listSessionFiles(home)).toHaveLength(1);
	});

	it("maxDepth=2：子会话注册 task，调用**成功**并真的再派发一层（子子会话出现）", async () => {
		const home = newTemp("chenxi-m8a-d2-");
		const cwd = newTemp("chenxi-m8a-d2-cwd-");
		const provider = createStubProvider([
			toolCallStep(taskCall("call_task_1", "inner work")),
			{ content: "grandchild says", stopReason: "end_turn" },
			{ content: "child done", stopReason: "end_turn" },
		]);

		const runner = createSubagentRunner({
			home,
			cwd,
			mode: "build",
			model: "stub-model",
			provider,
			permission: createPermissionSystem(),
			parentSessionId: "ses_m8a_p2" as SessionId,
			maxDepth: 2,
		});
		expect(runner.maxDepth).toBe(2);

		const result = await runner.dispatch({ prompt: "outer" });
		expect(result.summary).toBe("child done");
		expect(result.steps).toBe(2);

		const childEvents = await readEvents(home, result.childSessionId);
		const dispatched = findToolResult(childEvents);
		expect(dispatched?.ok).toBe(true);
		const output = dispatched?.output as
			| { childSessionId: string; kind: string; summary: string; steps: number; stopReason: string }
			| undefined;
		expect(output?.kind).toBe("fresh");
		expect(output?.summary).toBe("grandchild says");
		expect(output?.stopReason).toBe("end_turn");
		expect(output?.steps).toBe(1);

		const grandchildId = output?.childSessionId as SessionId;
		expect(existsSync(join(home, "sessions", `${grandchildId}.jsonl`))).toBe(true);

		const grandchildEvents = await readEvents(home, grandchildId);
		expect(startPayload(grandchildEvents)?.parentSessionId).toBe(result.childSessionId);
		expect(userMessageContent(grandchildEvents)).toBe("inner work");

		// 两层独立会话都在
		expect(listSessionFiles(home)).toHaveLength(2);
	});
});

describe("M8a 模式继承（当次调用）", () => {
	it("dispatch 的 `mode` 覆盖 runner 缺省模式，并写进子会话 session/start", async () => {
		const home = newTemp("chenxi-m8a-mode-");
		const cwd = newTemp("chenxi-m8a-mode-cwd-");
		const provider = createStubProvider({ content: "ok", stopReason: "end_turn" });

		const runner = createSubagentRunner({
			home,
			cwd,
			mode: "plan",
			model: "stub-model",
			provider,
			permission: createPermissionSystem(),
			parentSessionId: "ses_m8a_p3" as SessionId,
		});

		const result = await runner.dispatch({ prompt: "do it", mode: "build" });
		const events = await readEvents(home, result.childSessionId);
		const start = events.find((event) => event.type === "session/start");
		expect(start?.type === "session/start" ? start.payload.mode : undefined).toBe("build");
	});
});

describe("M8a `task` 工具接线（execute 两参）", () => {
	it("走完整工具流水线时，父会话 id 取**当次调用**的 context.sessionId", async () => {
		const home = newTemp("chenxi-m8a-tool-");
		const cwd = newTemp("chenxi-m8a-tool-cwd-");
		const provider = createStubProvider({ content: "done", stopReason: "end_turn" });
		const runner = createSubagentRunner({
			home,
			cwd,
			mode: "build",
			model: "stub-model",
			provider,
			permission: createPermissionSystem(),
		});

		const ctx = createContext();
		const registry = createToolRegistry(ctx);
		registry.register(createTaskTool(runner));

		const context: ToolCallContext = {
			sessionId: "ses_caller_ctx",
			callId: "call_task_x" as ToolCallId,
			mode: "build",
			cwd,
		};
		const result = await executeTool({
			ctx,
			registry,
			call: { callId: context.callId, toolName: "task", input: { prompt: "do it" } },
			context,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const output = result.value as { childSessionId: string; summary: string };
		expect(output.summary).toBe("done");

		const events = await readEvents(home, output.childSessionId as SessionId);
		expect(startPayload(events)?.parentSessionId).toBe("ses_caller_ctx");
	});
});
