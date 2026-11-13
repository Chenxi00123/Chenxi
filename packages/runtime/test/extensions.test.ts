/**
 * extensions 模块单元测试（ADR-004「扩展缝」，判据 #6 核心证据）。
 *
 * 关键主张：**不改主循环 / execute**，仅靠 `tools/execute` waterfall 中间件即可
 * 让超时、短路等策略生效；卸载（注册即 effect 的回滚）后一切恢复内置行为。
 */
import type {
	EventDraft,
	EventType,
	SessionEvent,
	SessionId,
	ToolCallContext,
	ToolCallId,
	ToolError,
	ToolResultPayload,
} from "@chenxi/schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createContext } from "../src/events/index.js";
import {
	createExampleExtensions,
	createExtensionHost,
	createExtensionTimeout,
	createShortCircuitExtension,
	type Extension,
} from "../src/extensions/index.js";
import { createStubProvider } from "../src/llm/stub.js";
import { type RunTurnParams, runTurn } from "../src/loop/index.js";
import { createEventLog, type EventLog, newSessionId } from "../src/session/index.js";
import {
	type AnyToolDefinition,
	createToolRegistry,
	executeTool,
	valueSchema,
} from "../src/tools/index.js";
import { makeTempDir } from "./helpers/tmp.js";

/** 简易 sleep。 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 造一个临时工作目录作为 cwd（保证只在 D 盘）。 */
function tempCwd(): string {
	return makeTempDir("chenxi-ext-");
}

/** 自造上下文 + 注册表。 */
function makeHarness() {
	const ctx = createContext();
	return { ctx, registry: createToolRegistry(ctx) };
}

/** 构造 ToolCallContext。 */
function toolContext(cwd: string): ToolCallContext {
	return {
		sessionId: "ses_test" as SessionId,
		callId: "call_1" as ToolCallId,
		mode: "build",
		cwd,
	};
}

function callOf(toolName: string, input: unknown) {
	return { callId: "call_1" as ToolCallId, toolName, input };
}

/** 构造一个结构合法的桩工具（output 固定为 {ok:boolean}）。 */
function stubTool(options: {
	name: string;
	readOnly?: boolean;
	execute: () => unknown;
}): AnyToolDefinition {
	return {
		metadata: {
			name: options.name,
			description: `stub tool ${options.name}`,
			readOnly: options.readOnly ?? true,
			destructive: false,
			sideEffectScope: "none",
			riskLevel: "low",
			needsApproval: false,
		},
		input: valueSchema(z.object({})),
		output: valueSchema(z.object({ ok: z.boolean() })),
		execute: options.execute,
	} as unknown as AnyToolDefinition;
}

/** 造会话（内存日志 + append）。 */
function makeSession(): { log: EventLog; append: RunTurnParams["append"] } {
	const log = createEventLog({ sessionId: newSessionId() });
	const append: RunTurnParams["append"] = async <T extends EventType>(
		draft: EventDraft<T>,
	): Promise<SessionEvent> => log.append(draft);
	return { log, append };
}

/** 取出全部 `tool/result` 载荷（类型收窄）。 */
function toolResults(log: EventLog): readonly ToolResultPayload[] {
	const out: ToolResultPayload[] = [];
	for (const event of log.events) {
		if (event.type === "tool/result") out.push(event.payload);
	}
	return out;
}

describe("判据 #1 超时中间件生效（不改主循环）", () => {
	it("runTurn 中慢工具经扩展缝被判 timeout", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(
			stubTool({
				name: "slow",
				execute: async () => {
					await sleep(300);
					return { ok: true };
				},
			}),
		);

		const host = createExtensionHost(ctx, registry);
		const dispose = await host.load(createExtensionTimeout({ timeoutMs: 50 }));

		const { log, append } = makeSession();
		const provider = createStubProvider([
			{
				content: "",
				stopReason: "tool_call",
				toolCalls: [{ callId: "call_1" as ToolCallId, toolName: "slow", input: {} }],
			},
			{ content: "done", stopReason: "end_turn" },
		]);

		await runTurn({
			log,
			append,
			provider,
			model: "stub",
			tools: { ctx, registry },
			mode: "build",
			cwd: tempCwd(),
		});

		const results = toolResults(log);
		expect(results).toHaveLength(1);
		const result = results[0];
		expect(result?.ok).toBe(false);
		expect(result?.error?.code).toBe("timeout");
		expect(result?.error?.message).toContain("slow");
		expect(result?.error?.message).toContain("timed out after 50ms");

		dispose();
	});
});

describe("判据 #2 不调 next() 短路内置行为", () => {
	it("命中工具短路且内置 execute 未被调用；其它工具不受影响", async () => {
		const { ctx, registry } = makeHarness();
		let probeRuns = 0;
		let normalRuns = 0;
		registry.register(
			stubTool({
				name: "probe",
				execute: () => {
					probeRuns += 1;
					return { ok: true };
				},
			}),
		);
		registry.register(
			stubTool({
				name: "normal",
				execute: () => {
					normalRuns += 1;
					return { ok: true };
				},
			}),
		);

		const host = createExtensionHost(ctx, registry);
		const dispose = await host.load(
			createShortCircuitExtension({ toolName: "probe", value: { injected: true } }),
		);

		const cwd = tempCwd();
		const shorted = await executeTool({
			ctx,
			registry,
			call: callOf("probe", {}),
			context: toolContext(cwd),
		});
		expect(shorted).toEqual({ ok: true, value: { injected: true } });
		expect(probeRuns).toBe(0);

		const normal = await executeTool({
			ctx,
			registry,
			call: callOf("normal", {}),
			context: toolContext(cwd),
		});
		expect(normal.ok).toBe(true);
		if (normal.ok) expect(normal.value).toEqual({ ok: true });
		expect(normalRuns).toBe(1);

		dispose();
	});
});

describe("判据 #3 两种中间件共存", () => {
	it("一个被短路、另一个超时", async () => {
		const { ctx, registry } = makeHarness();
		let probeRuns = 0;
		registry.register(
			stubTool({
				name: "probe",
				execute: () => {
					probeRuns += 1;
					return { ok: true };
				},
			}),
		);
		registry.register(
			stubTool({
				name: "slow",
				execute: async () => {
					await sleep(300);
					return { ok: true };
				},
			}),
		);

		const host = createExtensionHost(ctx, registry);
		await host.load(createExtensionTimeout({ timeoutMs: 50 }));
		await host.load(createShortCircuitExtension({ toolName: "probe", value: { injected: true } }));

		const cwd = tempCwd();
		const shorted = await executeTool({
			ctx,
			registry,
			call: callOf("probe", {}),
			context: toolContext(cwd),
		});
		expect(shorted).toEqual({ ok: true, value: { injected: true } });
		expect(probeRuns).toBe(0);

		const timed = await executeTool({
			ctx,
			registry,
			call: callOf("slow", {}),
			context: toolContext(cwd),
		});
		expect(timed.ok).toBe(false);
		if (!timed.ok) {
			const error: ToolError = timed.error;
			expect(error.code).toBe("timeout");
		}

		host.unloadAll();
	});
});

describe("判据 #4 注册即 effect / 卸载归零", () => {
	it("卸载后恢复内置行为、list 归零、重复卸载幂等", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(
			stubTool({
				name: "slow",
				execute: async () => {
					await sleep(300);
					return { ok: true };
				},
			}),
		);

		const host = createExtensionHost(ctx, registry);
		const dispose = await host.load(createExtensionTimeout({ timeoutMs: 50 }));
		expect(host.list()).toEqual(["builtin.extension-timeout"]);

		const cwd = tempCwd();
		const timed = await executeTool({
			ctx,
			registry,
			call: callOf("slow", {}),
			context: toolContext(cwd),
		});
		expect(timed.ok).toBe(false);

		dispose();
		expect(host.list()).toEqual([]);

		const restored = await executeTool({
			ctx,
			registry,
			call: callOf("slow", {}),
			context: toolContext(cwd),
		});
		expect(restored).toEqual({ ok: true, value: { ok: true } });

		dispose(); // 重复卸载幂等
		expect(host.list()).toEqual([]);
	});
});

describe("判据 #5 可读错误", () => {
	it("重复加载同一 id 抛错；未提供 registry 时 registerTool 抛错", async () => {
		const { ctx, registry } = makeHarness();
		const host = createExtensionHost(ctx, registry);
		const ext = createExtensionTimeout({ timeoutMs: 50 });
		await host.load(ext);
		await expect(host.load(ext)).rejects.toThrow(/is already loaded/);

		const bare = createExtensionHost(ctx);
		const needsRegistry: Extension = {
			id: "custom.needs-registry",
			name: "needs registry",
			activate: (api) => {
				api.registerTool(stubTool({ name: "x", execute: () => ({ ok: true }) }));
			},
		};
		await expect(bare.load(needsRegistry)).rejects.toThrow(/without a ToolRegistry/);
		expect(bare.list()).toEqual([]);

		host.unloadAll();
	});
});

describe("判据 #6 示例扩展", () => {
	it("createExampleExtensions 返回 2 个且 id 正确", () => {
		const extensions = createExampleExtensions();
		expect(extensions).toHaveLength(2);
		expect(extensions.map((extension) => extension.id)).toEqual([
			"builtin.extension-timeout",
			"builtin.extension-short-circuit",
		]);
	});
});
