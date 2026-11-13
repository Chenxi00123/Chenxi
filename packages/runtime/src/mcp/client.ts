/**
 * 零依赖 MCP stdio 客户端（ADR-015）。
 *
 * 设计要点：
 *  - **不引入 `@modelcontextprotocol/sdk`**：只依赖 `node:child_process` + `node:readline`，
 *    以 JSON-RPC 2.0「按行分隔」协议与子进程往返（spike `08` §3 M1~M4 已实测可行）。
 *  - **请求 id 单调递增**（非固定 1/2/3），`pending` 为 Map；请求在**成功 / 失败 / 超时**三条
 *    路径上都从 `pending` 删除，杜绝泄漏。
 *  - **子进程 exit / error 时 reject 全部 pending**，并让**后续请求快速失败**（否则调用方永久挂起）。
 *  - 子进程 stderr **透传**到 `console.debug`，stdout 仅逐行解析 JSON，**非 JSON 行忽略**。
 *  - `close()` 幂等：关 stdin、杀子进程、清 pending。
 */
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** spike `08` §3 M1 实测协商成功的协议版本（HTTP 传输共用）。 */
export const PROTOCOL_VERSION = "2025-11-25";
/** 单次请求缺省超时。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 存活子进程登记表 + **进程退出兜底**。
 *
 * `close()` 是正常路径，但不能假设调用方一定调到它（异常退出、REPL 被强杀等）。
 * 因此在模块级登记所有存活的 MCP 子进程，并在 `process` 的 `exit` 上统一 `kill()`——
 * **绝不留下孤儿进程**（Windows 上父进程退出**不会**自动带走子进程）。
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function trackChild(child: ChildProcess): void {
	liveChildren.add(child);
	child.once("exit", () => liveChildren.delete(child));
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const live of liveChildren) {
			try {
				live.kill();
			} catch {
				// 退出期尽力而为：杀不掉也不该抛
			}
		}
	});
}

export interface McpClientOptions {
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** 单次请求超时（ms），缺省 15000。超时必须 reject 并从 pending 中清除。 */
	readonly timeoutMs?: number;
}

export interface McpToolInfo {
	readonly name: string;
	readonly description?: string;
	/** 服务端给的 JSON Schema，原样保留。 */
	readonly inputSchema?: unknown;
	/** readOnlyHint / destructiveHint 等，原样保留。 */
	readonly annotations?: unknown;
}

/** MCP 提示词（`prompts/list`，ADR-035）。 */
export interface McpPromptInfo {
	readonly name: string;
	readonly description?: string;
	/** 参数声明（服务端原样给出）。 */
	readonly arguments?: unknown;
}

/** MCP 资源（`resources/list`，ADR-035）。 */
export interface McpResourceInfo {
	readonly uri: string;
	readonly name?: string;
	readonly description?: string;
	readonly mimeType?: string;
}

export interface McpClient {
	readonly serverInfo: {
		readonly name: string;
		readonly version: string;
		readonly protocolVersion: string;
		/** 服务端声明的能力（`tools` / `prompts` / `resources` …），原样保留。 */
		readonly capabilities?: Readonly<Record<string, unknown>>;
	};
	listTools(): Promise<readonly McpToolInfo[]>;
	/** 返回 CallToolResult 原样对象。 */
	callTool(name: string, args: unknown): Promise<unknown>;
	/** `prompts/list`（ADR-035）。服务端不支持时抛 JSON-RPC error。 */
	listPrompts(): Promise<readonly McpPromptInfo[]>;
	/** `prompts/get` 原样结果。 */
	getPrompt(name: string, args?: Readonly<Record<string, string>>): Promise<unknown>;
	/** `resources/list`（ADR-035）。服务端不支持时抛 JSON-RPC error。 */
	listResources(): Promise<readonly McpResourceInfo[]>;
	/** `resources/read` 原样结果。 */
	readResource(uri: string): Promise<unknown>;
	close(): Promise<void>;
}

/** 一次在途请求的登记项。 */
interface PendingEntry {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** 只取我们关心的 JSON-RPC 响应字段。 */
interface JsonRpcMessage {
	readonly id?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** 解析 `prompts/list` 结果（宽容：形状不符的项丢弃）。 */
export function parsePromptList(result: unknown): readonly McpPromptInfo[] {
	const record = asRecord(result);
	const prompts = Array.isArray(record?.prompts) ? record.prompts : [];
	return prompts.flatMap((prompt) => {
		const p = asRecord(prompt);
		if (p === undefined || typeof p.name !== "string" || p.name === "") return [];
		return [
			{
				name: p.name,
				...(typeof p.description === "string" ? { description: p.description } : {}),
				...(p.arguments === undefined ? {} : { arguments: p.arguments }),
			},
		];
	});
}

/** 解析 `resources/list` 结果（宽容：形状不符的项丢弃）。 */
export function parseResourceList(result: unknown): readonly McpResourceInfo[] {
	const record = asRecord(result);
	const resources = Array.isArray(record?.resources) ? record.resources : [];
	return resources.flatMap((resource) => {
		const r = asRecord(resource);
		if (r === undefined || typeof r.uri !== "string" || r.uri === "") return [];
		return [
			{
				uri: r.uri,
				...(typeof r.name === "string" ? { name: r.name } : {}),
				...(typeof r.description === "string" ? { description: r.description } : {}),
				...(typeof r.mimeType === "string" ? { mimeType: r.mimeType } : {}),
			},
		];
	});
}

/**
 * 连接一个 stdio MCP 服务端：spawn 子进程 -> `initialize` 往返 ->
 * 发 `notifications/initialized` -> 返回客户端句柄。
 */
export async function connectMcpStdio(options: McpClientOptions): Promise<McpClient> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const child = spawn(options.command, [...(options.args ?? [])], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		// 配置给的 env 与继承环境**合并**（MCP 服务端通常需要 PATH 等系统变量）
		...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
	}) as ChildProcessWithoutNullStreams;
	trackChild(child);

	const pending = new Map<number, PendingEntry>();
	let nextId = 1;
	let closed = false;
	/** 子进程退出/启动失败后的错误，供后续请求快速失败。 */
	let terminalError: Error | undefined;

	const rejectAll = (error: Error): void => {
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		pending.clear();
	};

	child.on("error", (error) => {
		terminalError = new Error(`mcp server "${options.command}" failed to start: ${error.message}`);
		rejectAll(terminalError);
	});
	child.on("exit", (code, signal) => {
		terminalError = new Error(
			`mcp server "${options.command}" exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
		);
		rejectAll(terminalError);
	});
	// stderr 只透传（不污染 stdout 的 JSON 流）
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		console.debug(`[mcp:${options.command}] ${chunk.trimEnd()}`);
	});
	// 子进程死亡后写 stdin 可能 EPIPE：静默吞掉，避免未处理的流错误
	child.stdin.on("error", () => {});

	const reader = createInterface({ input: child.stdout, terminal: false });
	reader.on("line", (line) => {
		if (line.trim() === "") return;
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			// 非 JSON 行：忽略（stdio 上可能混入日志）
			return;
		}
		if (typeof message.id !== "number") return; // 通知 / 服务端请求：本批不处理
		const entry = pending.get(message.id);
		if (entry === undefined) return;
		pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.error !== undefined) {
			const code = message.error.code ?? "unknown";
			const text = message.error.message ?? "unknown error";
			entry.reject(new Error(`MCP JSON-RPC error ${code}: ${text}`));
		} else {
			entry.resolve(message.result);
		}
	});

	const send = (message: Record<string, unknown>): void => {
		if (closed) return;
		child.stdin.write(`${JSON.stringify(message)}\n`);
	};

	const request = (method: string, params: unknown): Promise<unknown> =>
		new Promise((resolve, reject) => {
			if (closed) {
				reject(new Error(`mcp client for "${options.command}" is closed`));
				return;
			}
			if (terminalError !== undefined) {
				reject(terminalError);
				return;
			}
			const id = nextId++;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`mcp request "${method}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			send({ jsonrpc: "2.0", id, method, params });
		});

	const notify = (method: string): void => {
		send({ jsonrpc: "2.0", method });
	};

	const close = async (): Promise<void> => {
		if (closed) return; // 幂等：重复调用无副作用
		closed = true;
		reader.close();
		rejectAll(new Error(`mcp client for "${options.command}" is closed`));
		child.stdin.end();
		child.kill();
	};

	// initialize 往返 + notifications/initialized
	let serverInfo: McpClient["serverInfo"];
	try {
		const result = await request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "aster-mcp-client", version: "1.0.0" },
		});
		notify("notifications/initialized");
		const record = asRecord(result);
		const info = asRecord(record?.serverInfo);
		const negotiated = record?.protocolVersion;
		const declared = asRecord(record?.capabilities);
		serverInfo = {
			name: typeof info?.name === "string" ? info.name : options.command,
			version: typeof info?.version === "string" ? info.version : "0.0.0",
			protocolVersion: typeof negotiated === "string" ? negotiated : PROTOCOL_VERSION,
			...(declared === undefined ? {} : { capabilities: declared }),
		};
	} catch (error) {
		await close();
		throw error;
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
		close,
	};
}
