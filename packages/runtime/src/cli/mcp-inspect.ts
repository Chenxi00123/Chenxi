/**
 * MCP 只读面查看命令（ADR-035）：`--mcp-prompts <server>` / `--mcp-resources <server>`。
 *
 * 纪律：
 *  - **不进 REPL**（与 `--list` / `--doctor` 同类），打印结果并退出；
 *  - **先看服务端声明的能力**，没声明就明确说"不支持"，而不是硬调一次再报 JSON-RPC error；
 *  - 凭据（`headers` / `env`）**绝不打印**。
 */

import { loadConfig } from "../config/index.js";
import type { McpPromptInfo, McpResourceInfo } from "../mcp/index.js";
import { connectMcpServer, type McpTransport } from "../mcp/index.js";
import type { Output } from "./repl.js";

export interface McpInspectOptions {
	readonly home?: string;
	readonly config?: string;
	/** 配置里声明的服务器名。 */
	readonly server: string;
	readonly kind: "prompts" | "resources";
	readonly output: Output;
}

/** 由配置声明构造传输方式（与 bootstrap 同一规则）。 */
function transportOf(declaration: {
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}): McpTransport {
	if (declaration.url !== undefined) {
		return {
			url: declaration.url,
			...(declaration.headers === undefined ? {} : { headers: declaration.headers }),
		};
	}
	if (declaration.command === undefined) {
		throw new Error("mcp server declaration has neither url nor command");
	}
	return {
		command: declaration.command,
		...(declaration.args === undefined ? {} : { args: declaration.args }),
		...(declaration.env === undefined ? {} : { env: declaration.env }),
	};
}

function writePrompts(output: Output, server: string, prompts: readonly McpPromptInfo[]): void {
	output.write(`mcp: ${server} — ${prompts.length} prompt(s)\n`);
	for (const prompt of prompts) {
		const description = prompt.description === undefined ? "" : ` — ${prompt.description}`;
		output.write(`  ${prompt.name}${description}\n`);
	}
}

function writeResources(
	output: Output,
	server: string,
	resources: readonly McpResourceInfo[],
): void {
	output.write(`mcp: ${server} — ${resources.length} resource(s)\n`);
	for (const resource of resources) {
		const label = resource.name === undefined ? "" : ` (${resource.name})`;
		const mime = resource.mimeType === undefined ? "" : ` [${resource.mimeType}]`;
		output.write(`  ${resource.uri}${label}${mime}\n`);
	}
}

/** 执行 `--mcp-prompts` / `--mcp-resources`。 */
export async function runMcpInspectCommand(options: McpInspectOptions): Promise<void> {
	const loaded = loadConfig({
		...(options.home === undefined ? {} : { home: options.home }),
		...(options.config === undefined ? {} : { explicitPath: options.config }),
	});
	const declared = loaded.mcpServers ?? [];
	const declaration = declared.find((server) => server.name === options.server);
	if (declaration === undefined) {
		throw new Error(
			`mcp server "${options.server}" is not declared; declared: ` +
				(declared.length === 0 ? "(none)" : declared.map((server) => server.name).join(", ")),
		);
	}

	const client = await connectMcpServer(transportOf(declaration));
	try {
		const capabilities = client.serverInfo.capabilities ?? {};
		if (!(options.kind in capabilities)) {
			throw new Error(
				`mcp server "${options.server}" does not declare the "${options.kind}" capability ` +
					`(declared: ${Object.keys(capabilities).join(", ") || "(none)"})`,
			);
		}
		if (options.kind === "prompts") {
			writePrompts(options.output, options.server, await client.listPrompts());
		} else {
			writeResources(options.output, options.server, await client.listResources());
		}
	} finally {
		await client.close();
	}
}
