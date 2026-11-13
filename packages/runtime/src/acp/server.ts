/**
 * ACP **agent 侧最小服务端**（ADR-036）：按行分隔的 JSON-RPC 2.0（与我们的 MCP 客户端同一套读写纪律）。
 *
 * 为什么与传输解耦：`input` / `output` 是注入的流——测试用内存双工流驱动**同一份**协议实现，
 * 不需要为测试再写一个"假服务端"。
 *
 * stdout **只允许出现协议消息**（调用方的诊断输出必须走 stderr）；本文件只写 `output`。
 */
import { createInterface } from "node:readline";
import { ACP_PROTOCOL_VERSION, type AcpContentBlock, type AcpSessionHost } from "./protocol.js";

export interface AcpServerOptions {
	readonly input: NodeJS.ReadableStream;
	readonly output: { write(text: string): void };
	readonly host: AcpSessionHost;
	/** agent 名字 / 版本（`initialize` 的 `agentInfo`）。 */
	readonly agentInfo?: { readonly name: string; readonly version: string };
}

export interface AcpServer {
	/** 读到 EOF 时 resolve（调用方据此退出进程）。 */
	readonly done: Promise<void>;
	close(): Promise<void>;
}

interface JsonRpcRequest {
	readonly jsonrpc?: unknown;
	readonly id?: unknown;
	readonly method?: unknown;
	readonly params?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** 从 prompt 块里取文本（只认 `type:"text"`；其它块忽略）。 */
function promptText(blocks: unknown): string {
	if (!Array.isArray(blocks)) return "";
	const parts: string[] = [];
	for (const block of blocks) {
		const content = asRecord(block) as AcpContentBlock | undefined;
		if (content?.type === "text" && typeof content.text === "string") parts.push(content.text);
	}
	return parts.join("");
}

export function createAcpServer(options: AcpServerOptions): AcpServer {
	const agentInfo = options.agentInfo ?? { name: "aster", version: "1.0.0" };
	const busy = new Set<string>();
	let closed = false;

	const send = (message: Record<string, unknown>): void => {
		if (closed) return;
		options.output.write(`${JSON.stringify(message)}\n`);
	};
	const respond = (id: unknown, result: unknown): void => {
		send({ jsonrpc: "2.0", id, result });
	};
	const respondError = (id: unknown, code: number, message: string): void => {
		send({ jsonrpc: "2.0", id, error: { code, message } });
	};
	const notifyUpdate = (sessionId: string, update: unknown): void => {
		send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
	};

	const handle = async (message: JsonRpcRequest): Promise<void> => {
		const id = message.id;
		const method = message.method;
		if (typeof method !== "string") return;
		const params = asRecord(message.params) ?? {};

		// 通知（无 id）：只处理 cancel
		if (id === undefined) {
			if (method === "session/cancel" && typeof params.sessionId === "string") {
				options.host.cancel(params.sessionId);
			}
			return;
		}

		switch (method) {
			case "initialize":
				respond(id, {
					protocolVersion: ACP_PROTOCOL_VERSION,
					agentCapabilities: {
						loadSession: false,
						promptCapabilities: { image: false, audio: false, embeddedContext: false },
					},
					agentInfo,
				});
				return;
			case "session/new": {
				const cwd =
					typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : process.cwd();
				try {
					const created = await options.host.createSession({ cwd });
					respond(id, { sessionId: created.sessionId });
				} catch (error) {
					respondError(id, -32603, error instanceof Error ? error.message : String(error));
				}
				return;
			}
			case "session/prompt": {
				const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
				const text = promptText(params.prompt).trim();
				if (sessionId === "") {
					respondError(id, -32602, "session/prompt requires a string sessionId");
					return;
				}
				if (text === "") {
					respondError(id, -32602, "session/prompt requires at least one non-empty text block");
					return;
				}
				if (busy.has(sessionId)) {
					respondError(id, -32000, `session ${sessionId} is busy`);
					return;
				}
				busy.add(sessionId);
				try {
					const result = await options.host.prompt({
						sessionId,
						text,
						onUpdate: (update) => notifyUpdate(sessionId, update),
					});
					respond(id, { stopReason: result.stopReason });
				} catch (error) {
					respondError(id, -32603, error instanceof Error ? error.message : String(error));
				} finally {
					busy.delete(sessionId);
				}
				return;
			}
			default:
				respondError(id, -32601, `Method not found: ${method}`);
		}
	};

	const reader = createInterface({
		input: options.input as NodeJS.ReadableStream,
		terminal: false,
	});
	let resolveDone: () => void;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	reader.on("line", (line) => {
		if (line.trim() === "") return;
		let message: JsonRpcRequest;
		try {
			message = JSON.parse(line) as JsonRpcRequest;
		} catch {
			// 非 JSON 行：忽略（与 MCP 客户端同一条纪律）
			return;
		}
		void handle(message);
	});
	reader.on("close", () => resolveDone());

	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		reader.close();
		await options.host.close();
	};

	return { done, close };
}
