#!/usr/bin/env node
/**
 * 测试夹具：**零依赖** stdio MCP 服务端（JSON-RPC 2.0，按行分隔）。
 *
 * 结构参考 spike `08` 的 `spike-stdio-server.mjs`，但**不引入 `@modelcontextprotocol/sdk`**
 * （ADR-015 已定案：不引 SDK），改为手写最小 JSON-RPC 分发。提供两个工具：
 *  - `echo`：带 `readOnlyHint: true` 注解；
 *  - `add`：**不带任何注解**（用于验证「缺失按保守值」）。
 *
 * 另提供两条错误路径供测试：
 *  - 未知工具名 -> 返回 `isError` 的**结果**（不是 JSON-RPC error）；
 *  - 未知 method -> 返回真正的 JSON-RPC error（code -32601 / "Method not found"）。
 *    命令行参数 `--error-on-tools-list` 会让 `tools/list` 也走这条错误路径，
 *    使客户端能在**仅用公开 API** 的情况下触发 JSON-RPC error 分支。
 */
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-11-25";

const ECHO_INPUT_SCHEMA = {
	type: "object",
	properties: { text: { type: "string" } },
	required: ["text"],
	additionalProperties: false,
};

const ADD_INPUT_SCHEMA = {
	type: "object",
	properties: { a: { type: "number" }, b: { type: "number" } },
	required: ["a", "b"],
	additionalProperties: false,
};

const TOOLS = [
	{
		name: "echo",
		description: "Echo back the given text.",
		inputSchema: ECHO_INPUT_SCHEMA,
		annotations: { readOnlyHint: true },
	},
	{
		name: "add",
		description: "Add two numbers.",
		inputSchema: ADD_INPUT_SCHEMA,
	},
];

/** 提示词 / 资源（ADR-035）——只读面，用于 `--mcp-prompts` / `--mcp-resources` 测试。 */
const PROMPTS = [
	{
		name: "greet",
		description: "Greet someone by name.",
		arguments: [{ name: "who", description: "Who to greet", required: true }],
	},
];

const RESOURCES = [
	{
		uri: "file:///fixture/readme.txt",
		name: "readme",
		description: "Fixture readme",
		mimeType: "text/plain",
	},
];

/** argv 开关：让 tools/list 返回 JSON-RPC error（供客户端错误分支测试）。 */
const errorOnToolsList = process.argv.slice(2).includes("--error-on-tools-list");
/** argv 开关：不声明 prompts 能力（供"能力缺失要说清楚"的分支测试）。 */
const noPromptsCapability = process.argv.slice(2).includes("--no-prompts-capability");

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(id, text, isError) {
	send({
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text }], ...(isError === true ? { isError: true } : {}) },
	});
}

const reader = createInterface({ input: process.stdin, terminal: false });
reader.on("line", (line) => {
	if (line.trim() === "") return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return; // 非 JSON 行忽略
	}
	const id = message.id;
	const params = message.params ?? {};

	switch (message.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {
						tools: {},
						...(noPromptsCapability ? {} : { prompts: {} }),
						resources: {},
					},
					serverInfo: { name: "chenxi-mcp-fixture", version: "1.0.0" },
				},
			});
			break;
		case "notifications/initialized":
			break; // 通知：无 id，不回
		case "prompts/list":
			send({ jsonrpc: "2.0", id, result: { prompts: PROMPTS } });
			break;
		case "prompts/get": {
			const who = params.arguments?.who ?? "world";
			send({
				jsonrpc: "2.0",
				id,
				result: {
					description: "Greet someone by name.",
					messages: [{ role: "user", content: { type: "text", text: `Hello ${String(who)}` } }],
				},
			});
			break;
		}
		case "resources/list":
			send({ jsonrpc: "2.0", id, result: { resources: RESOURCES } });
			break;
		case "resources/read":
			send({
				jsonrpc: "2.0",
				id,
				result: {
					contents: [
						{ uri: String(params.uri ?? ""), mimeType: "text/plain", text: "fixture resource body" },
					],
				},
			});
			break;
		case "tools/list":
			if (errorOnToolsList) {
				send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			} else {
				send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
			}
			break;
		case "tools/call": {
			const name = params.name;
			const args = params.arguments ?? {};
			if (name === "echo") {
				textResult(id, `echo:${String(args.text ?? "")}`);
			} else if (name === "add") {
				textResult(id, String(Number(args.a ?? 0) + Number(args.b ?? 0)));
			} else {
				// 未知工具：结果（isError），不是 JSON-RPC error
				textResult(id, `unknown tool: ${String(name)}`, true);
			}
			break;
		}
		default:
			// 未知 method：真正的 JSON-RPC error（通知无 id 时静默）
			if (id !== undefined) {
				send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			}
	}
});
