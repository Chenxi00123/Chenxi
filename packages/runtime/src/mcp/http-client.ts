/**
 * MCP **Streamable HTTP** 客户端（ADR-035）——零新依赖（用 Node 22 内置 `fetch`）。
 *
 * 只实现客户端真正需要的形状（不假装支持全部规范）：
 *  - 单一端点 URL；每个请求一次 `POST`（JSON-RPC 2.0）；
 *  - 响应既可以是 `application/json`，也可以是 `text/event-stream`（SSE）——
 *    后者逐个事件解析，直到拿到与本请求 `id` 对应的响应；
 *  - `initialize` 响应里的 `Mcp-Session-Id` 会被后续请求带上（服务端没给就不带）；
 *  - 通知（`notifications/initialized`）走无 `id` 的 POST，不等待结果；
 *  - 不支持服务端主动发起的请求（本批无此需求），收到时**忽略**（与 stdio 同一条纪律）。
 *
 * ⚠️ 已声明的局限：**只与仓内 fixture 对测**，未与真实远端 MCP 服务对测。
 */
import {
	type McpClient,
	type McpPromptInfo,
	type McpResourceInfo,
	type McpToolInfo,
	PROTOCOL_VERSION,
	parsePromptList,
	parseResourceList,
} from "./client.js";

export interface McpHttpClientOptions {
	readonly url: string;
	/** 额外请求头（例如 Authorization；**不打印**、不落盘）。 */
	readonly headers?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

interface JsonRpcResponse {
	readonly id?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

/** 从 SSE 事件流里找出 `id` 对应的响应；找不到返回 undefined。 */
async function readSseResponse(
	body: ReadableStream<Uint8Array> | null,
	id: number,
): Promise<JsonRpcResponse | undefined> {
	if (body === null) return undefined;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const find = (): JsonRpcResponse | undefined => {
		for (const event of buffer.split("\n\n")) {
			const data = event
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice("data:".length).trim())
				.join("\n");
			if (data === "") continue;
			let message: JsonRpcResponse;
			try {
				message = JSON.parse(data) as JsonRpcResponse;
			} catch {
				continue;
			}
			if (message.id === id) return message;
		}
		return undefined;
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const found = find();
		if (found !== undefined) {
			await reader.cancel();
			return found;
		}
	}
	return find();
}

export async function connectMcpHttp(options: McpHttpClientOptions): Promise<McpClient> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let sessionId: string | undefined;
	let nextId = 1;
	let closed = false;
	let terminalError: Error | undefined;

	const post = async (
		payload: Record<string, unknown>,
		notification: boolean,
	): Promise<{ response?: JsonRpcResponse; sessionHeader?: string }> => {
		if (closed) throw new Error(`mcp http client for "${options.url}" is closed`);
		if (terminalError !== undefined) throw terminalError;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(options.url, {
				method: "POST",
				signal: controller.signal,
				headers: {
					"content-type": "application/json",
					accept: notification ? "application/json" : "application/json, text/event-stream",
					"mcp-protocol-version": PROTOCOL_VERSION,
					...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
					...options.headers,
				},
				body: JSON.stringify(payload),
			});
			if (!response.ok) {
				throw new Error(`mcp http ${options.url} returned HTTP ${response.status}`);
			}
			const header = response.headers.get("mcp-session-id") ?? undefined;
			if (notification) {
				await response.text().catch(() => undefined);
				return { sessionHeader: header };
			}
			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("text/event-stream")) {
				const found = await readSseResponse(response.body, Number(payload.id));
				if (found === undefined) {
					throw new Error(
						`mcp http ${options.url}: SSE ended without a response for id ${payload.id}`,
					);
				}
				return { response: found, sessionHeader: header };
			}
			return { response: (await response.json()) as JsonRpcResponse, sessionHeader: header };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`mcp http request failed: ${message}`);
		} finally {
			clearTimeout(timer);
		}
	};

	const request = async (method: string, params: unknown): Promise<unknown> => {
		const id = nextId++;
		const { response, sessionHeader } = await post({ jsonrpc: "2.0", id, method, params }, false);
		if (sessionHeader !== undefined) sessionId = sessionHeader;
		if (response === undefined) throw new Error(`mcp http ${options.url}: empty response`);
		if (response.error !== undefined) {
			const code = response.error.code ?? "unknown";
			const text = response.error.message ?? "unknown error";
			throw new Error(`MCP JSON-RPC error ${code}: ${text}`);
		}
		return response.result;
	};

	const notify = async (method: string): Promise<void> => {
		const { sessionHeader } = await post({ jsonrpc: "2.0", method }, true);
		if (sessionHeader !== undefined) sessionId = sessionHeader;
	};

	let serverInfo: McpClient["serverInfo"];
	try {
		const result = await request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "chenxi-mcp-http-client", version: "1.0.0" },
		});
		await notify("notifications/initialized");
		const record = asRecord(result);
		const info = asRecord(record?.serverInfo);
		const negotiated = record?.protocolVersion;
		const declared = asRecord(record?.capabilities);
		serverInfo = {
			name: typeof info?.name === "string" ? info.name : options.url,
			version: typeof info?.version === "string" ? info.version : "0.0.0",
			protocolVersion: typeof negotiated === "string" ? negotiated : PROTOCOL_VERSION,
			...(declared === undefined ? {} : { capabilities: declared }),
		};
	} catch (error) {
		terminalError = error instanceof Error ? error : new Error(String(error));
		throw terminalError;
	}

	return {
		serverInfo,
		async listTools(): Promise<readonly McpToolInfo[]> {
			const result = await request("tools/list", {});
			const record = asRecord(result);
			const tools = Array.isArray(record?.tools) ? record.tools : [];
			return tools.map((tool) => {
				const t = asRecord(tool) ?? {};
				return {
					name: typeof t.name === "string" ? t.name : String(t.name),
					description: typeof t.description === "string" ? t.description : undefined,
					inputSchema: t.inputSchema,
					annotations: t.annotations,
				};
			});
		},
		callTool: (name, args) => request("tools/call", { name, arguments: args }),
		async listPrompts(): Promise<readonly McpPromptInfo[]> {
			return parsePromptList(await request("prompts/list", {}));
		},
		getPrompt: (name, args) =>
			request("prompts/get", { name, ...(args === undefined ? {} : { arguments: args }) }),
		async listResources(): Promise<readonly McpResourceInfo[]> {
			return parseResourceList(await request("resources/list", {}));
		},
		readResource: (uri) => request("resources/read", { uri }),
		async close(): Promise<void> {
			closed = true;
			// Streamable HTTP 无子进程可杀；DELETE 终止会话是规范允许的可选项，本批不做
		},
	};
}
