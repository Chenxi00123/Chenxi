/**
 * mcp 模块单元测试（ADR-015）。
 *
 * 自洽：**只跑本机子进程**（`process.execPath` + 仓内零依赖 fixture），**不联网**、
 * 不新增任何依赖。客户端与工具桥的所有断言都基于仓内 fixture server 的真实 stdio 往返。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallContext, ToolCallId } from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/events/index.js";
import {
	bridgeMcpServer,
	connectMcpStdio,
	jsonSchemaValueSchema,
	type McpClient,
	type McpToolInfo,
	mcpEnvelopeValueSchema,
} from "../src/mcp/index.js";
import {
	type AnyToolDefinition,
	createToolRegistry,
	ToolRegistrationError,
	type ToolRegistry,
} from "../src/tools/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "helpers", "mcp-fixture-server.mjs");

const ECHO_SCHEMA = {
	type: "object",
	properties: { text: { type: "string" } },
	required: ["text"],
	additionalProperties: false,
};

/** 已建立资源（客户端/桥）的统一回收，避免测试失败时子进程泄漏、拖住 vitest。 */
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

interface CallToolResultShape {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly isError?: boolean;
}

function asResult(value: unknown): CallToolResultShape {
	return value as CallToolResultShape;
}

function getTool(registry: ToolRegistry, name: string): AnyToolDefinition {
	const tool = registry.get(name);
	if (tool === undefined) throw new Error(`tool ${name} is not registered`);
	return tool;
}

function findMcpTool(tools: readonly McpToolInfo[], name: string): McpToolInfo {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`mcp tool ${name} not listed`);
	return tool;
}

function toolContext(cwd: string): ToolCallContext {
	return { sessionId: "ses_mcp", callId: "call_mcp" as ToolCallId, mode: "build", cwd };
}

/** 连接 fixture 客户端，并登记回收。 */
async function connect(extraArgs: readonly string[] = []): Promise<McpClient> {
	const client = await connectMcpStdio({
		command: process.execPath,
		args: [FIXTURE, ...extraArgs],
	});
	cleanups.push(() => client.close());
	return client;
}

function makeHarness() {
	const ctx = createContext();
	return { ctx, registry: createToolRegistry(ctx) };
}

/** 桥 fixture，并登记回收。 */
async function bridge(
	registry: ToolRegistry,
	ctx: ReturnType<typeof createContext>,
	extraArgs: readonly string[] = [],
) {
	const bridged = await bridgeMcpServer({
		serverName: "fixture",
		transport: { command: process.execPath, args: [FIXTURE, ...extraArgs] },
		registry,
		ctx,
	});
	cleanups.push(() => bridged.dispose());
	return bridged;
}

/** 结构合法的桩工具（用于制造命名冲突）。 */
function stubTool(name: string): AnyToolDefinition {
	return {
		metadata: {
			name,
			description: `stub ${name}`,
			readOnly: true,
			destructive: false,
			sideEffectScope: "none",
			riskLevel: "low",
			needsApproval: false,
		},
		input: jsonSchemaValueSchema({ type: "object" }),
		output: mcpEnvelopeValueSchema(),
		execute: () => ({ content: [] }),
	};
}

describe("MCP stdio 客户端", () => {
	it("initialize 协商出 serverInfo（协议版本 2025-11-25）", async () => {
		const client = await connect();
		expect(client.serverInfo.name).toBe("aster-mcp-fixture");
		expect(client.serverInfo.version).toBe("1.0.0");
		expect(client.serverInfo.protocolVersion).toBe("2025-11-25");
	});

	it("listTools 返回 2 个工具，inputSchema / annotations 原样保留", async () => {
		const client = await connect();
		const tools = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["echo", "add"]);
		const echo = findMcpTool(tools, "echo");
		expect(echo.inputSchema).toEqual(ECHO_SCHEMA);
		expect(echo.annotations).toEqual({ readOnlyHint: true });
		expect(findMcpTool(tools, "add").annotations).toBeUndefined();
	});

	it("callTool('echo') 返回 CallToolResult 信封", async () => {
		const client = await connect();
		const result = asResult(await client.callTool("echo", { text: "hi" }));
		expect(result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
	});

	it("callTool 未知工具 -> isError 结果（不是抛出）", async () => {
		const client = await connect();
		const result = asResult(await client.callTool("nope", {}));
		expect(result.isError).toBe(true);
		expect(result.content[0]?.type).toBe("text");
	});

	it("JSON-RPC error -> reject，消息含 code 与 Method not found", async () => {
		const client = await connect(["--error-on-tools-list"]);
		await expect(client.listTools()).rejects.toThrow(/Method not found/);
		await expect(client.listTools()).rejects.toThrow(/-32601/);
	});

	it("close() 幂等：连续两次不抛错", async () => {
		const client = await connect();
		await client.close();
		await expect(client.close()).resolves.toBeUndefined();
	});

	it("close() 后请求快速失败（而非永久挂起）", async () => {
		const client = await connect();
		await client.close();
		await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/closed/);
		await expect(client.listTools()).rejects.toThrow(/closed/);
	});
});

describe("MCP 工具桥", () => {
	it("注册命名空间工具；descriptors 的 parameters 为服务端 JSON Schema", async () => {
		const { ctx, registry } = makeHarness();
		const bridged = await bridge(registry, ctx);

		expect(bridged.serverName).toBe("fixture");
		expect(bridged.serverInfo).toEqual({ name: "aster-mcp-fixture", version: "1.0.0" });
		expect(bridged.toolNames).toEqual(["mcp__fixture__echo", "mcp__fixture__add"]);
		expect(registry.get("mcp__fixture__echo")).toBeDefined();

		const descriptor = registry.descriptors().find((d) => d.function.name === "mcp__fixture__echo");
		expect(descriptor?.function.parameters).toEqual(ECHO_SCHEMA);
	});

	it("权限映射：sideEffectScope=host、needsApproval=true、注解缺失按保守值", async () => {
		const { ctx, registry } = makeHarness();
		await bridge(registry, ctx);
		const echo = getTool(registry, "mcp__fixture__echo").metadata;
		const add = getTool(registry, "mcp__fixture__add").metadata;

		expect(echo.readOnly).toBe(true); // readOnlyHint: true
		expect(echo.destructive).toBe(true); // destructiveHint 缺失 -> 保守 true
		expect(add.readOnly).toBe(false); // 无注解 -> false
		expect(add.destructive).toBe(true); // 无注解 -> 保守 true
		expect(echo.sideEffectScope).toBe("host");
		expect(add.sideEffectScope).toBe("host");
		expect(echo.needsApproval).toBe(true);
		expect(add.needsApproval).toBe(true);
		expect(echo.riskLevel).toBe("medium");
		expect(echo.description).toBe("Echo back the given text.");
		expect(add.description.trim().length).toBeGreaterThan(0);
	});

	it("execute 把服务端结果原样作为 output 返回", async () => {
		const { ctx, registry } = makeHarness();
		await bridge(registry, ctx);
		const tool = getTool(registry, "mcp__fixture__echo");
		const result = asResult(
			await tool.execute({ text: "yo" }, toolContext(makeTempDir("aster-mcp-"))),
		);
		expect(result).toEqual({ content: [{ type: "text", text: "echo:yo" }] });
	});

	it("与已有工具重名 -> ToolRegistrationError（不改名兜底）", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(stubTool("mcp__fixture__echo"));
		await expect(bridge(registry, ctx)).rejects.toThrow(ToolRegistrationError);
	});

	it("入参子集校验：add 缺 b -> ok:false 且 issue path 含 b", async () => {
		const { ctx, registry } = makeHarness();
		await bridge(registry, ctx);
		const parsed = getTool(registry, "mcp__fixture__add").input.parse({ a: 1 });
		if (parsed.ok) throw new Error("expected parse failure");
		expect(parsed.issues.some((issue) => issue.path.includes("b"))).toBe(true);
	});

	it("信封 output 校验：合法信封 ok，空对象/非法 content fail", () => {
		const envelope = mcpEnvelopeValueSchema();
		expect(envelope.parse({ content: [{ type: "text", text: "x", extra: 1 }] }).ok).toBe(true);
		expect(envelope.parse({}).ok).toBe(false);
		expect(envelope.parse({ content: [{ type: 1 }] }).ok).toBe(false);
	});

	it("dispose 幂等：卸载全部工具后 registry.get 为 undefined", async () => {
		const { ctx, registry } = makeHarness();
		const bridged = await bridge(registry, ctx);

		bridged.dispose();
		expect(registry.get("mcp__fixture__echo")).toBeUndefined();
		expect(registry.get("mcp__fixture__add")).toBeUndefined();
		expect(registry.size()).toBe(0);
		expect(() => bridged.dispose()).not.toThrow();
	});
});

describe("jsonSchemaValueSchema（ADR-015 已声明子集）", () => {
	it("toJsonSchema 原样回传；非对象回退 {type:'object'}", () => {
		const schema = { type: "object", properties: { text: { type: "string" } } };
		const value = jsonSchemaValueSchema(schema);
		expect(value.toJsonSchema()).toBe(schema);
		expect(jsonSchemaValueSchema(null).toJsonSchema()).toEqual({ type: "object" });
		expect(jsonSchemaValueSchema("nope").toJsonSchema()).toEqual({ type: "object" });
	});

	it("type 校验：object 要求非 null 且非数组", () => {
		const value = jsonSchemaValueSchema({ type: "object" });
		expect(value.parse({}).ok).toBe(true);
		expect(value.parse(null).ok).toBe(false);
		expect(value.parse([]).ok).toBe(false);
	});

	it("required 缺失 -> issue path 为缺失键名", () => {
		const value = jsonSchemaValueSchema({ type: "object", required: ["text"] });
		const parsed = value.parse({});
		if (parsed.ok) throw new Error("expected parse failure");
		expect(parsed.issues[0]?.path).toEqual(["text"]);
	});

	it("enum 校验", () => {
		const value = jsonSchemaValueSchema({ enum: ["a", "b"] });
		expect(value.parse("a").ok).toBe(true);
		expect(value.parse("c").ok).toBe(false);
	});

	it("properties 声明的类型会校验（object / integer）", () => {
		const value = jsonSchemaValueSchema({ type: "object", properties: { n: { type: "integer" } } });
		expect(value.parse({ n: 3 }).ok).toBe(true);
		expect(value.parse({ n: 3.5 }).ok).toBe(false);
	});

	it("忽略未声明关键字（oneOf 不校验）", () => {
		const value = jsonSchemaValueSchema({ oneOf: [{ type: "string" }, { type: "number" }] });
		expect(value.parse({ anything: true }).ok).toBe(true);
	});
});
