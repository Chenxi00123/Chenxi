/**
 * M18a 验收测试（总工程师独立编写）：**MCP 剩余面**（ADR-035）——提示词 / 资源 / Streamable HTTP。
 *
 * 覆盖：
 *  - stdio 客户端：`prompts/list` / `prompts/get` / `resources/list` / `resources/read`（真进程夹具）；
 *  - 配置面：`url` 与 `command` **互斥**、非 http(s) URL 拒绝、headers 可为空；
 *  - CLI：`--mcp-prompts` / `--mcp-resources` 打印结果且**不进 REPL**；能力没声明时**说清楚**；
 *  - HTTP 传输：initialize 捕获 `Mcp-Session-Id` 并在后续请求带上；
 *    普通 JSON 响应与 **SSE 响应**（含一条无关通知 + 目标响应）都能解析；
 *  - 桥接：HTTP 服务端也能注册成工具（`mcp__<server>__<tool>`）。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMcpInspectCommand } from "../src/cli/mcp-inspect.js";
import { configMcpServerSchema } from "../src/config/schema.js";
import { createContext } from "../src/events/index.js";
import {
	bridgeMcpServer,
	connectMcpServer,
	connectMcpStdio,
	PROTOCOL_VERSION,
} from "../src/mcp/index.js";
import { createToolRegistry } from "../src/tools/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];
const servers: Server[] = [];

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = fileURLToPath(new URL("./helpers/mcp-fixture-server.mjs", import.meta.url));

function writeConfig(dir: string, server: Record<string, unknown>): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({ mcp: { servers: [server] } }), "utf8");
	return path;
}

describe("M18a stdio 客户端：提示词与资源（ADR-035）", () => {
	it("列出提示词 / 取提示词 / 列出资源 / 读资源（真进程夹具）", async () => {
		const client = await connectMcpStdio({ command: process.execPath, args: [FIXTURE] });
		try {
			expect(client.serverInfo.capabilities).toMatchObject({
				tools: {},
				prompts: {},
				resources: {},
			});
			const prompts = await client.listPrompts();
			expect(prompts).toEqual([
				{
					name: "greet",
					description: "Greet someone by name.",
					arguments: [{ name: "who", description: "Who to greet", required: true }],
				},
			]);
			expect(await client.getPrompt("greet", { who: "Aster" })).toMatchObject({
				messages: [{ role: "user", content: { type: "text", text: "Hello Aster" } }],
			});
			const resources = await client.listResources();
			expect(resources).toEqual([
				{
					uri: "file:///fixture/readme.txt",
					name: "readme",
					description: "Fixture readme",
					mimeType: "text/plain",
				},
			]);
			expect(await client.readResource("file:///fixture/readme.txt")).toMatchObject({
				contents: [{ text: "fixture resource body" }],
			});
		} finally {
			await client.close();
		}
	});
});

describe("M18a 配置面：stdio 与 HTTP 互斥（ADR-035）", () => {
	it("stdio 声明与 HTTP 声明各自合法", () => {
		expect(
			configMcpServerSchema.safeParse({ name: "a", command: "node", args: ["x"] }).success,
		).toBe(true);
		expect(
			configMcpServerSchema.safeParse({
				name: "b",
				url: "https://example.com/mcp",
				headers: { authorization: "Bearer x" },
			}).success,
		).toBe(true);
	});

	it("混用两边 / 非 http(s) URL 一律拒绝", () => {
		expect(
			configMcpServerSchema.safeParse({ name: "c", command: "node", url: "https://x/mcp" }).success,
		).toBe(false);
		expect(configMcpServerSchema.safeParse({ name: "d", url: "ftp://x/mcp" }).success).toBe(false);
		expect(configMcpServerSchema.safeParse({ name: "e", url: "not-a-url" }).success).toBe(false);
	});
});

describe("M18a CLI：--mcp-prompts / --mcp-resources（不进 REPL）", () => {
	it("打印提示词与资源（真进程夹具）", async () => {
		const dir = newTemp("aster-m18a-cli-");
		const config = writeConfig(dir, {
			name: "fixture",
			command: process.execPath,
			args: [FIXTURE],
		});
		const lines: string[] = [];
		await runMcpInspectCommand({
			home: dir,
			config,
			server: "fixture",
			kind: "prompts",
			output: { write: (text) => lines.push(text) },
		});
		const printed = lines.join("");
		expect(printed).toContain("fixture — 1 prompt(s)");
		expect(printed).toContain("greet — Greet someone by name.");

		lines.length = 0;
		await runMcpInspectCommand({
			home: dir,
			config,
			server: "fixture",
			kind: "resources",
			output: { write: (text) => lines.push(text) },
		});
		const resources = lines.join("");
		expect(resources).toContain("fixture — 1 resource(s)");
		expect(resources).toContain("file:///fixture/readme.txt (readme) [text/plain]");
	});

	it("服务端没声明 prompts 能力 ⇒ **明确说清**，不硬调后报 JSON-RPC error", async () => {
		const dir = newTemp("aster-m18a-cap-");
		const config = writeConfig(dir, {
			name: "fixture",
			command: process.execPath,
			args: [FIXTURE, "--no-prompts-capability"],
		});
		await expect(
			runMcpInspectCommand({
				home: dir,
				config,
				server: "fixture",
				kind: "prompts",
				output: { write: () => undefined },
			}),
		).rejects.toThrowError(/does not declare the "prompts" capability/);
	});

	it("服务器名未声明 ⇒ 报错并列出已声明清单", async () => {
		const dir = newTemp("aster-m18a-miss-");
		const config = writeConfig(dir, {
			name: "fixture",
			command: process.execPath,
			args: [FIXTURE],
		});
		await expect(
			runMcpInspectCommand({
				home: dir,
				config,
				server: "nope",
				kind: "prompts",
				output: { write: () => undefined },
			}),
		).rejects.toThrowError(/not declared; declared: fixture/);
	});
});

/* ------------------------------------------------------------------------------------------------
 * HTTP 传输：本地 fixture 服务端（JSON + SSE 两种响应）
 * ---------------------------------------------------------------------------------------------- */

interface RecordedRequest {
	readonly session: string | undefined;
	readonly protocol: string | undefined;
	readonly body: { id?: number; method?: string; params?: Record<string, unknown> };
}

function collectBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

function sendJson(response: ServerResponse, payload: unknown, session?: string): void {
	if (session !== undefined) response.setHeader("mcp-session-id", session);
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(payload));
}

async function startHttpFixture(): Promise<{ url: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];
	const server = createServer(async (request, response) => {
		const raw = await collectBody(request);
		let body: RecordedRequest["body"] = {};
		try {
			body = JSON.parse(raw) as RecordedRequest["body"];
		} catch {
			response.statusCode = 400;
			response.end("bad json");
			return;
		}
		requests.push({
			session: request.headers["mcp-session-id"] as string | undefined,
			protocol: request.headers["mcp-protocol-version"] as string | undefined,
			body,
		});
		const id = body.id;
		switch (body.method) {
			case "initialize":
				sendJson(
					response,
					{
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: PROTOCOL_VERSION,
							capabilities: { tools: {}, prompts: {}, resources: {} },
							serverInfo: { name: "http-fixture", version: "2.0.0" },
						},
					},
					"sess-1",
				);
				break;
			case "notifications/initialized":
				response.statusCode = 202;
				response.end();
				break;
			case "tools/list":
				sendJson(response, {
					jsonrpc: "2.0",
					id,
					result: {
						tools: [{ name: "ping", description: "Ping", annotations: { readOnlyHint: true } }],
					},
				});
				break;
			case "tools/call": {
				const args = (body.params?.arguments ?? {}) as { stream?: boolean };
				if (args.stream === true) {
					response.setHeader("content-type", "text/event-stream");
					response.write(
						`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
					);
					response.write(
						`data: ${JSON.stringify({
							jsonrpc: "2.0",
							id,
							result: { content: [{ type: "text", text: "sse-ok" }] },
						})}\n\n`,
					);
					response.end();
				} else {
					sendJson(response, {
						jsonrpc: "2.0",
						id,
						result: { content: [{ type: "text", text: "json-ok" }] },
					});
				}
				break;
			}
			case "prompts/list":
				sendJson(response, {
					jsonrpc: "2.0",
					id,
					result: { prompts: [{ name: "remote-greet" }] },
				});
				break;
			case "resources/list":
				sendJson(response, {
					jsonrpc: "2.0",
					id,
					result: { resources: [{ uri: "https://example.com/r.txt", mimeType: "text/plain" }] },
				});
				break;
			default:
				sendJson(response, {
					jsonrpc: "2.0",
					id,
					error: { code: -32601, message: "Method not found" },
				});
		}
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return { url: `http://127.0.0.1:${address.port}/mcp`, requests };
}

describe("M18a Streamable HTTP 传输（ADR-035）", () => {
	it("initialize 捕获并复用 Mcp-Session-Id；普通 JSON 与 SSE 响应都能解析", async () => {
		const { url, requests } = await startHttpFixture();
		const client = await connectMcpServer({ url });
		try {
			expect(client.serverInfo).toMatchObject({ name: "http-fixture", version: "2.0.0" });
			const tools = await client.listTools();
			expect(tools.map((tool) => tool.name)).toEqual(["ping"]);
			expect((await client.listPrompts()).map((prompt) => prompt.name)).toEqual(["remote-greet"]);
			expect((await client.listResources()).map((resource) => resource.uri)).toEqual([
				"https://example.com/r.txt",
			]);
			expect(await client.callTool("ping", {})).toMatchObject({
				content: [{ text: "json-ok" }],
			});
			// SSE：先来一条无关通知，再来目标响应
			expect(await client.callTool("ping", { stream: true })).toMatchObject({
				content: [{ text: "sse-ok" }],
			});
		} finally {
			await client.close();
		}

		// 第一个请求（initialize）没有会话；之后每个请求都带上服务端给的会话 id
		expect(requests[0]?.session).toBeUndefined();
		expect(requests[0]?.protocol).toBe(PROTOCOL_VERSION);
		expect(requests.slice(1).every((entry) => entry.session === "sess-1")).toBe(true);
	});

	it("HTTP 服务端也能桥接成工具（mcp__<server>__<tool>）", async () => {
		const { url } = await startHttpFixture();
		const ctx = createContext();
		const registry = createToolRegistry(ctx);
		const bridged = await bridgeMcpServer({
			serverName: "remote",
			transport: { url },
			registry,
			ctx,
		});
		try {
			expect(bridged.toolNames).toEqual(["mcp__remote__ping"]);
			expect(await bridged.callTool("ping", {})).toMatchObject({ content: [{ text: "json-ok" }] });
			expect(await bridged.listPrompts()).toMatchObject([{ name: "remote-greet" }]);
		} finally {
			bridged.dispose();
		}
	});
});
