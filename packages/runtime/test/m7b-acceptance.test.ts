/**
 * M7b 验收测试（总工程师独立编写）：MCP 接入的**跨模块契约**，不重复模块单测。
 *
 * 覆盖：
 *  - ADR-005 调和：桥接注册**能通过注册期校验**（CTA：input/output 都是合法 ValueSchema）；
 *  - ADR-015 命名空间：MCP 工具注册为 `mcp__<server>__<tool>`，与 4 原语隔离；
 *  - **权限组合（核心）**：MCP 工具 `sideEffectScope: "host"` -> `plan` 下被拒；`build` 下
 *    走 `ask` + M6 审批流（`a` = 本会话始终放行），且判定落 `permission/decision` 事件；
 *    服务端声明 `readOnlyHint` 的工具在 `plan` 下**仍被允许**（元数据驱动未被破坏）；
 *  - ADR-014/015 配置面：`mcp.servers` 严格校验、重名拒绝、`mcp` **整段替换**合并语义。
 */

import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentMode,
	EventDraft,
	EventType,
	PermissionDecisionPayload,
	ToolCallId,
	ToolCallRef,
} from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { configFileSchema, loadConfig } from "../src/config/index.js";
import type { Context } from "../src/events/index.js";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import { runTurn } from "../src/loop/index.js";
import { bridgeMcpServer } from "../src/mcp/index.js";
import type { PermissionSystem } from "../src/permission/index.js";
import {
	createApprovalGate,
	createPermissionHook,
	createPermissionSystem,
} from "../src/permission/index.js";
import { createEventLog } from "../src/session/index.js";
import type { ToolRegistry } from "../src/tools/index.js";
import { createToolRegistry } from "../src/tools/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = join(HERE, "helpers", "mcp-fixture-server.mjs");

const temps: string[] = [];
const disposers: (() => void)[] = [];

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dispose of disposers.splice(0)) {
		try {
			dispose();
		} catch {
			// 卸载失败不应掩盖真正的断言失败
		}
	}
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 装配「桥接的 MCP fixture 服务器」注册表。 */
async function makeBridgedRegistry() {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	const bridged = await bridgeMcpServer({
		serverName: "fixture",
		transport: { command: process.execPath, args: [FIXTURE_SERVER] },
		registry,
		ctx,
	});
	disposers.push(() => bridged.dispose());
	return { ctx, registry, bridged };
}

function toolCallStep(name: string, input: unknown, id: string) {
	return {
		content: "",
		toolCalls: [{ callId: id as ToolCallId, toolName: name, input }] as ToolCallRef[],
		stopReason: "tool_call" as const,
	};
}

function appenderFor(log: ReturnType<typeof createEventLog>) {
	return async <T extends EventType>(draft: EventDraft<T>) => log.append(draft);
}

/** 跑一个回合并取回首个 `tool/result` 与落盘的 `permission/decision`。 */
async function runTurnWithPermissions(p: {
	mode: AgentMode;
	cwd: string;
	toolName: string;
	input: unknown;
	registry: ToolRegistry;
	ctx: Context;
	permission: PermissionSystem;
	ask?: (question: string) => Promise<string>;
}) {
	const log = createEventLog({ sessionId: "ses_m7b" as never });
	const decisions: PermissionDecisionPayload[] = [];
	const gate = p.ask === undefined ? undefined : createApprovalGate({ ask: p.ask });
	const hook = createPermissionHook({
		system: p.permission,
		...(gate === undefined ? {} : { approve: gate.approve }),
		record: (payload) => {
			decisions.push(payload);
			log.append({ type: "permission/decision", payload });
		},
	});

	const result = await runTurn({
		log,
		append: appenderFor(log),
		provider: createStubProvider([
			toolCallStep(p.toolName, p.input, "c1"),
			{ content: "done", stopReason: "end_turn" },
		]),
		model: "stub-model",
		mode: p.mode,
		cwd: p.cwd,
		tools: { ctx: p.ctx, registry: p.registry, beforeHooks: [hook] },
	});

	const event = log.events.find((candidate) => candidate.type === "tool/result");
	return {
		result,
		toolResult: event?.type === "tool/result" ? event.payload : undefined,
		decisions,
		gate,
	};
}

describe("M7b ADR-005 调和：桥接后的 MCP 工具能通过注册期校验", () => {
	it("注册成功即可证明 input/output 都是合法 ValueSchema（否则注册期就抛错）", async () => {
		const { registry, bridged } = await makeBridgedRegistry();

		expect(bridged.serverInfo.name).toBe("chenxi-mcp-fixture");
		expect(bridged.toolNames).toEqual(["mcp__fixture__echo", "mcp__fixture__add"]);
		expect(registry.size()).toBe(2);

		const echo = registry.get("mcp__fixture__echo");
		expect(echo).toBeDefined();
		// input 的 toJsonSchema 必须**原样**是服务端给的 schema（ADR-015）
		expect(echo?.input.toJsonSchema()).toMatchObject({
			type: "object",
			required: ["text"],
			properties: { text: { type: "string" } },
		});
		// descriptors 是模型真正看到的东西
		const descriptor = registry.descriptors().find((d) => d.function.name === "mcp__fixture__echo");
		expect(descriptor?.function.parameters).toMatchObject({ type: "object" });
	});

	it("命名空间隔离：未桥接时 4 原语名与 mcp 名互不冲突", async () => {
		const { registry } = await makeBridgedRegistry();
		expect(registry.has("read")).toBe(false);
		expect(registry.has("mcp__fixture__echo")).toBe(true);
	});
});

describe("M7b 权限组合：MCP 工具按元数据参与判定", () => {
	it("plan：服务端声明只读的 echo 被允许；未声明的 add（保守判为写）被拒", async () => {
		const { ctx, registry } = await makeBridgedRegistry();
		const cwd = newTemp("chenxi-m7b-cwd-");

		const echoRun = await runTurnWithPermissions({
			mode: "plan",
			cwd,
			toolName: "mcp__fixture__echo",
			input: { text: "hi" },
			registry,
			ctx,
			permission: createPermissionSystem(),
		});
		expect(echoRun.toolResult?.ok).toBe(true);
		expect(echoRun.decisions[0]?.decision).toBe("allow");

		const addRun = await runTurnWithPermissions({
			mode: "plan",
			cwd,
			toolName: "mcp__fixture__add",
			input: { a: 1, b: 2 },
			registry,
			ctx,
			permission: createPermissionSystem(),
		});
		expect(addRun.toolResult?.ok).toBe(false);
		expect(addRun.toolResult?.error?.code).toBe("permission_denied");
		expect(addRun.toolResult?.error?.retryable).toBe(false);
		expect(addRun.decisions[0]?.decision).toBe("deny");
	});

	it("build：host 作用域 -> ask；答 `a` 后**真的执行** MCP 调用，且规则沉淀到本会话", async () => {
		const { ctx, registry } = await makeBridgedRegistry();
		const cwd = newTemp("chenxi-m7b-cwd-");
		const questions: string[] = [];
		const ask = async (question: string) => {
			questions.push(question);
			return "a";
		};

		const first = await runTurnWithPermissions({
			mode: "build",
			cwd,
			toolName: "mcp__fixture__add",
			input: { a: 2, b: 3 },
			registry,
			ctx,
			permission: createPermissionSystem(),
			ask,
		});

		expect(first.toolResult?.ok).toBe(true);
		// 信封契约：output 是 CallToolResult 形状
		const output = first.toolResult?.output as { content?: { text?: string }[] };
		expect(output.content?.[0]?.text).toBe("5");
		expect(first.decisions[0]?.decision).toBe("allow");
		expect(first.decisions[0]?.reason ?? "").toContain("approved by user");
		// 审批提示里**不得**出现任何密钥形态（这里断言提示本身可读且含工具名）
		expect(questions[0]).toContain("mcp__fixture__add");
		expect(first.gate?.rules.list().map((r) => `${r.toolName}@${r.scope}`)).toEqual([
			"mcp__fixture__add@outside",
		]);
		// 「规则沉淀 -> 不再提问」的跨回合行为由 m6 验收测试覆盖（在 REPL 级），此处只验单回合
	});

	it("build 下答 `n` -> 拒绝，且 MCP 未被真正调用", async () => {
		const { ctx, registry } = await makeBridgedRegistry();
		const cwd = newTemp("chenxi-m7b-cwd-");

		const run = await runTurnWithPermissions({
			mode: "build",
			cwd,
			toolName: "mcp__fixture__add",
			input: { a: 1, b: 1 },
			registry,
			ctx,
			permission: createPermissionSystem(),
			ask: async () => "n",
		});

		expect(run.toolResult?.ok).toBe(false);
		expect(run.toolResult?.error?.code).toBe("permission_denied");
		expect(run.decisions[0]?.decision).toBe("deny");
	});
});

describe("M7b ADR-014/015 配置面：mcp.servers", () => {
	it("合法声明被接受；非法 name / 未知键 / 重名被拒", () => {
		expect(
			configFileSchema.safeParse({
				mcp: { servers: [{ name: "mem", command: "node", args: ["x.js"], env: { K: "v" } }] },
			}).success,
		).toBe(true);
		expect(
			configFileSchema.safeParse({ mcp: { servers: [{ name: "Bad Name", command: "n" }] } })
				.success,
		).toBe(false);
		expect(
			configFileSchema.safeParse({ mcp: { servers: [{ name: "m", command: "n", oops: 1 }] } })
				.success,
		).toBe(false);

		const cwd = newTemp("chenxi-m7b-dup-");
		writeFileSync(
			join(cwd, "chenxi.config.json"),
			JSON.stringify({
				mcp: {
					servers: [
						{ name: "dup", command: "a" },
						{ name: "dup", command: "b" },
					],
				},
			}),
			"utf8",
		);
		expect(() => loadConfig({ home: newTemp("h-"), cwd, env: {} })).toThrow(
			/duplicate MCP server name "dup"/,
		);
		expect(() => loadConfig({ home: newTemp("h-"), cwd, env: {} })).toThrow(
			/mcp\.servers\.1\.name/,
		);
	});

	it("`mcp` 整段替换：项目级覆盖用户级（不是把 servers 合并）", () => {
		const home = newTemp("chenxi-m7b-home-");
		const cwd = newTemp("chenxi-m7b-cwd-");
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({ mcp: { servers: [{ name: "user", command: "u" }] } }),
			"utf8",
		);
		writeFileSync(
			join(cwd, "chenxi.config.json"),
			JSON.stringify({ mcp: { servers: [{ name: "project", command: "p" }] } }),
			"utf8",
		);

		const loaded = loadConfig({ home, cwd, env: {} });
		expect(loaded.sources).toHaveLength(2);
		expect(loaded.mcpServers?.map((s) => s.name)).toEqual(["project"]);
	});

	it("未声明 / 空数组 -> `mcpServers` 不含键；声明缺失文件路径不触发 IO", () => {
		const home = newTemp("chenxi-m7b-none-home-");
		const cwd = newTemp("chenxi-m7b-none-cwd-");
		expect(loadConfig({ home, cwd, env: {} }).mcpServers).toBeUndefined();

		writeFileSync(
			join(cwd, "chenxi.config.json"),
			JSON.stringify({ mcp: { servers: [] } }),
			"utf8",
		);
		expect(loadConfig({ home, cwd, env: {} }).mcpServers).toBeUndefined();

		// 声明了不存在的可执行文件也**不应**在加载期报错（桥接失败发生在启动桥接时）
		writeFileSync(
			join(cwd, "chenxi.config.json"),
			JSON.stringify({
				mcp: { servers: [{ name: "ghost", command: "definitely-not-a-real-binary-xyz" }] },
			}),
			"utf8",
		);
		const declared = loadConfig({ home, cwd, env: {} });
		expect(declared.mcpServers?.[0]?.name).toBe("ghost");
		expect(declared.mcpServers?.[0]?.command).toBe("definitely-not-a-real-binary-xyz");
	});
});
