/**
 * MCP 工具桥（ADR-015）。
 *
 * 把一个 stdio MCP 服务端暴露的工具，适配为 Chenxi 的工具契约后注册进 `ToolRegistry`：
 *  - 命名空间：一律 `mcp__<serverName>__<toolName>`；**与已有工具重名即注册失败**
 *    （由 `registry.register` 抛 `ToolRegistrationError`，不做改名兜底）；
 *  - 权限映射（ADR-006：元数据是判定唯一事实源）：`sideEffectScope: "host"`、
 *    `riskLevel: "medium"`、`needsApproval: true`；`readOnly` / `destructive` 取服务端注解，
 *    **缺失按保守值**（`readOnly=false` / `destructive=true`）；
 *  - `input` = 服务端 JSON Schema 适配器；`output` = MCP `CallToolResult` 信封；
 *  - `execute` 把 `client.callTool` 的结果**原样**作为 output 返回（信封即 output 契约）；
 *  - `dispose` 幂等：卸载全部已注册工具 + 关闭子进程。
 */
import type { ToolMetadata } from "@chenxi/schema";
import type { Context, Disposer } from "../events/index.js";
import type { AnyToolDefinition, ToolRegistry } from "../tools/registry.js";
import {
	connectMcpStdio,
	type McpClient,
	type McpPromptInfo,
	type McpResourceInfo,
	type McpToolInfo,
} from "./client.js";
import { connectMcpHttp } from "./http-client.js";
import { jsonSchemaValueSchema, mcpEnvelopeValueSchema } from "./json-schema.js";

/** 传输方式（ADR-035）：stdio 与 Streamable HTTP **互斥**。 */
export interface McpStdioTransport {
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

export interface McpHttpTransport {
	readonly url: string;
	/** 额外请求头（可能含凭据 ⇒ **不打印、不落盘**）。 */
	readonly headers?: Readonly<Record<string, string>>;
}

export type McpTransport = McpStdioTransport | McpHttpTransport;

/** 按传输方式建客户端（stdio 或 HTTP）。CLI 的 `--mcp-prompts` / `--mcp-resources` 也用它。 */
export function connectMcpServer(transport: McpTransport): Promise<McpClient> {
	return "url" in transport
		? connectMcpHttp({
				url: transport.url,
				...(transport.headers === undefined ? {} : { headers: transport.headers }),
			})
		: connectMcpStdio({
				command: transport.command,
				...(transport.args === undefined ? {} : { args: transport.args }),
				...(transport.env === undefined ? {} : { env: transport.env }),
			});
}

export interface BridgeMcpServerOptions {
	/** 配置里的名字，用于命名空间。 */
	readonly serverName: string;
	/** 传输方式（stdio 或 HTTP）。 */
	readonly transport: McpTransport;
	/** 来自 ../tools/registry.js。 */
	readonly registry: ToolRegistry;
	/** 来自 ../events/index.js（绑定 effect 生命周期）。 */
	readonly ctx: Context;
}

export interface BridgedMcpServer {
	readonly serverName: string;
	readonly serverInfo: { readonly name: string; readonly version: string };
	/** 已注册的全名（mcp__<server>__<tool>）。 */
	readonly toolNames: readonly string[];
	/** 直接调用该服务端的工具（供内部扩展使用，如记忆适配器）。 */
	readonly callTool: (name: string, args: unknown) => Promise<unknown>;
	/** 提示词 / 资源（ADR-035）：只读透传，**不注册成工具**。 */
	readonly listPrompts: () => Promise<readonly McpPromptInfo[]>;
	readonly getPrompt: (name: string, args?: Readonly<Record<string, string>>) => Promise<unknown>;
	readonly listResources: () => Promise<readonly McpResourceInfo[]>;
	readonly readResource: (uri: string) => Promise<unknown>;
	/** 卸载所有工具 + 关闭子进程（幂等）。 */
	readonly dispose: Disposer;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** 由服务端注解推导工具元数据（缺失按保守值）。 */
function buildMetadata(fullName: string, tool: McpToolInfo, serverName: string): ToolMetadata {
	const annotations = asRecord(tool.annotations) ?? {};
	const description =
		typeof tool.description === "string" && tool.description.trim() !== ""
			? tool.description
			: `MCP tool ${tool.name} from ${serverName}`;
	return {
		name: fullName,
		description,
		readOnly: annotations.readOnlyHint === true,
		// 缺失按保守值：无法证明安全 -> 视为破坏性
		destructive: annotations.destructiveHint !== false,
		sideEffectScope: "host",
		riskLevel: "medium",
		needsApproval: true,
	};
}

/** 把一个 MCP 工具适配为 Chenxi 工具定义。 */
function toDefinition(
	fullName: string,
	tool: McpToolInfo,
	serverName: string,
	client: McpClient,
): AnyToolDefinition {
	return {
		metadata: buildMetadata(fullName, tool, serverName),
		input: jsonSchemaValueSchema(tool.inputSchema),
		output: mcpEnvelopeValueSchema(),
		async execute(raw: unknown): Promise<unknown> {
			return client.callTool(tool.name, raw);
		},
	};
}

/** 桥一个 MCP 服务端（stdio 或 HTTP）：连接 -> 列出工具 -> 全部注册。 */
export async function bridgeMcpServer(options: BridgeMcpServerOptions): Promise<BridgedMcpServer> {
	const client = await connectMcpServer(options.transport);

	let tools: readonly McpToolInfo[];
	try {
		tools = await client.listTools();
	} catch (error) {
		await client.close();
		throw error;
	}

	const registered: Disposer[] = [];
	const toolNames: string[] = [];
	try {
		for (const tool of tools) {
			const fullName = `mcp__${options.serverName}__${tool.name}`;
			// 冲突时 register 抛 ToolRegistrationError（不静默改名）
			registered.push(
				options.registry.register(toDefinition(fullName, tool, options.serverName, client)),
			);
			toolNames.push(fullName);
		}
	} catch (error) {
		for (const disposer of registered) disposer();
		await client.close();
		throw error;
	}

	// 绑定 effect 生命周期：作用域回滚时自动关闭子进程
	const closeEffect = options.ctx.effect(() => () => {
		void client.close();
	});

	let disposed = false;
	const dispose = (): void => {
		if (disposed) return; // 幂等
		disposed = true;
		for (const disposer of registered) disposer();
		closeEffect();
	};

	return {
		serverName: options.serverName,
		serverInfo: { name: client.serverInfo.name, version: client.serverInfo.version },
		toolNames,
		callTool: (name, args) => client.callTool(name, args),
		listPrompts: () => client.listPrompts(),
		getPrompt: (name, args) => client.getPrompt(name, args),
		listResources: () => client.listResources(),
		readResource: (uri) => client.readResource(uri),
		dispose,
	};
}
