/**
 * SSE 服务端（ADR-021 / ADR-022）：零依赖 `node:http`。
 *
 * 路由：
 *   - `GET  /api/event`        —— SSE：下发 `hello` 握手帧，随后逐条转发**已记录事件**；
 *   - `GET  /api/sessions`     —— 会话列表（**直接扫 JSONL**，不信派生索引）；
 *   - `GET  /api/sessions/:id` —— 回放：元数据 + 事件 + 投影（`deriveMessages`）；
 *   - `POST /api/sessions/:id/prompt` —— **远端写路径**（ADR-022）：体 `{ prompt }`，
 *     经 `PromptDriver`（单一写入者 + 无审批通道 fail-closed）。
 *
 * 铁律：
 *   - **只绑 `127.0.0.1`（默认）**：本地 harness 不做无鉴权的网络暴露；外部访问必须显式 `--host`；
 *   - **慢消费者只断自己**：写 socket 尊重背压（`write()` 返回 false 就等 `drain`），
 *     于是"跟不上的连接"会让自己的**有界队列**填满 → 被 `overflow` 收尾并收到一条 error 帧，
 *     其余连接**完全不受影响**；
 *   - **不做断点续传**：`hello` 帧里 `resume: "replay-only"` 明说这件事；
 *   - **写路径只在被显式注入 driver 时才存在**（缺省 501 `prompt_unavailable`）；
 *     构造方（CLI）只在**本机回环**绑定时注入 —— 未鉴权的远端写路径不允许存在。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	type ErrorFrame,
	type HelloFrame,
	PROTOCOL_VERSION,
	type PromptResultFrame,
	type StreamFrame,
} from "@aster/protocol";
import type { SessionEvent, SessionId } from "@aster/schema";
import { deriveMessages } from "../session/index.js";
import type { PromptDriver } from "./driver.js";
import { type EventFeed, SubscriberOverflowError } from "./feed.js";
import { deriveDiskMeta, listSessionsFromDisk, readSessionEvents } from "./source.js";

/** 服务端默认只绑本地回环：**未鉴权**，绝不明文暴露到网络。 */
export const DEFAULT_SERVE_HOST = "127.0.0.1";
/** 默认端口（被占用或传 0 时由系统分配，实际值由 `ServerHandle.url` 给出）。 */
export const DEFAULT_SERVE_PORT = 8787;
/** `POST /prompt` 请求体上限（64 KiB）：边界校验，避免无界缓冲。 */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** 回环地址判定（`main` 据此决定**是否**注入远端写路径）。 */
export function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/** 把一条帧编成 SSE 文本（`data: <json>\n\n`，与 OpenCode 的 event-feed 同形）。 */
export function frameLine(frame: StreamFrame): string {
	return `data: ${JSON.stringify(frame)}\n\n`;
}

/** 供 CLI 使用：把"已记录事件"包成 `event` 帧后发布（生产者只有这一处）。 */
export function createEventProducer(feed: EventFeed): (event: SessionEvent) => void {
	return (event) => feed.publish({ kind: "event", event } satisfies StreamFrame);
}

export interface ServerOptions {
	readonly home: string;
	readonly feed: EventFeed;
	readonly host?: string;
	/** `0` = 由系统分配（测试用）。 */
	readonly port?: number;
	/** 远端写路径（ADR-022）；**缺省 = 不提供**（该路由回 501）。 */
	readonly driver?: PromptDriver;
	/** `POST /prompt` 的请求体上限（字节）；缺省 64 KiB。 */
	readonly maxBodyBytes?: number;
}

export interface ServerHandle {
	readonly url: string;
	readonly host: string;
	readonly port: number;
	close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const text = `${JSON.stringify(body)}\n`;
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	response.end(text);
}

function sendError(
	response: ServerResponse,
	status: number,
	error: Omit<ErrorFrame, "kind">,
): void {
	sendJson(response, status, { kind: "error", ...error } satisfies ErrorFrame);
}

/** 等 `drain` 或客户端消失——**两者都要能收场**，否则慢连接会把泵挂死。 */
function waitForDrain(response: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const done = (): void => {
			response.off("drain", done);
			response.off("close", done);
			resolve();
		};
		response.once("drain", done);
		response.once("close", done);
	});
}

/** SSE 泵：逐条取事件，尊重背压；队列满 -> 回一条 error 帧并收尾（只影响这一个连接）。
 *  **导出**以便测试用"假响应"确定性地复现溢出路径（真 http 里要填满 socket 缓冲才触发，不稳定）。 */
export async function pumpEvents(response: ServerResponse, feed: EventFeed): Promise<void> {
	const subscriber = feed.subscribe();
	const onClose = (): void => subscriber.close();
	response.once("close", onClose);
	try {
		for await (const payload of subscriber) {
			const written = response.write(`data: ${String(payload)}\n\n`);
			if (!written) await waitForDrain(response);
			if (response.destroyed || response.writableEnded) return;
		}
		response.end();
	} catch (error) {
		const overflow = error instanceof SubscriberOverflowError;
		response.write(
			frameLine({
				kind: "error",
				code: overflow ? "subscriber_overflow" : "stream_failed",
				message: error instanceof Error ? error.message : String(error),
				// 溢出是可续的（重连后整段回放）；其他流错误按不可续处理
				retryable: overflow,
			}),
		);
		response.end();
	} finally {
		response.off("close", onClose);
		subscriber.close();
	}
}

function handleSessions(home: string, response: ServerResponse): void {
	sendJson(response, 200, { kind: "sessions", sessions: listSessionsFromDisk(home) });
}

function handleSession(home: string, sessionId: SessionId, response: ServerResponse): void {
	const events = readSessionEvents(home, sessionId);
	if (events === undefined) {
		sendError(response, 404, {
			code: "session_not_found",
			message: `no session ${sessionId}`,
			retryable: false,
		});
		return;
	}
	const meta = deriveDiskMeta(sessionId, events);
	if (meta === undefined) {
		sendError(response, 422, {
			code: "session_unreadable",
			message: `session ${sessionId} has no session/start event`,
			retryable: false,
		});
		return;
	}
	sendJson(response, 200, { kind: "session", meta, events, messages: deriveMessages(events) });
}

/** 请求体超限（与"非法 JSON"分开报，便于调用方分辨）。 */
class PayloadTooLargeError extends Error {}

/** 读请求体（带上限）：边界校验，不无界缓冲。 */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > limit) throw new PayloadTooLargeError(`request body exceeds ${limit} bytes`);
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * `POST /api/sessions/:id/prompt`（ADR-022）：校验边界 → 交给 driver（单一写入者）。
 * 每个失败分支返回**可读**错误帧 + 恰当状态码；driver 缺省即 501。
 */
async function handlePrompt(
	options: ServerOptions,
	sessionId: SessionId,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const driver = options.driver;
	if (driver === undefined) {
		sendError(response, 501, {
			code: "prompt_unavailable",
			message:
				"remote writes are disabled on this server (no session driver was injected); " +
				"writes are only available on a loopback-bound server started by the CLI",
			retryable: false,
		});
		return;
	}

	let text: string;
	try {
		text = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
	} catch (error) {
		const tooLarge = error instanceof PayloadTooLargeError;
		sendError(response, tooLarge ? 413 : 400, {
			code: tooLarge ? "payload_too_large" : "invalid_body",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
		return;
	}

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch (error) {
		sendError(response, 400, {
			code: "invalid_json",
			message: `request body must be JSON: ${error instanceof Error ? error.message : String(error)}`,
			retryable: false,
		});
		return;
	}
	const prompt = (body as { prompt?: unknown } | null)?.prompt;
	if (typeof prompt !== "string" || prompt.trim() === "") {
		sendError(response, 422, {
			code: "invalid_prompt",
			message: 'request body must be {"prompt": "<non-empty string>"}',
			retryable: false,
		});
		return;
	}

	const outcome = await driver.run(sessionId, prompt);
	switch (outcome.kind) {
		case "ok":
			sendJson(response, 200, {
				kind: "prompt-result",
				sessionId: outcome.sessionId,
				stopReason: outcome.stopReason,
				steps: outcome.steps,
				content: outcome.content,
				eventCount: outcome.eventCount,
			} satisfies PromptResultFrame);
			return;
		case "not_found":
			sendError(response, 404, {
				code: "session_not_found",
				message: `no session ${outcome.sessionId}`,
				retryable: false,
			});
			return;
		case "unreadable":
			sendError(response, 422, {
				code: "session_unreadable",
				message: `session ${outcome.sessionId} has no session/start event`,
				retryable: false,
			});
			return;
		case "live":
			sendError(response, 409, {
				code: "session_live",
				message:
					`session ${outcome.sessionId} is being driven in this process; ` +
					"prompt it through the local REPL instead (one session = one writer)",
				retryable: false,
			});
			return;
		case "failed":
			sendError(response, 500, {
				code: "prompt_failed",
				message: outcome.message,
				retryable: false,
			});
			return;
	}
}

/**
 * 启动服务端。返回的 `url` 是**实际**监听地址（`--port 0` 时由系统分配）。
 * `close()` 会断开全部在途 SSE 连接并释放端口。
 */
export async function startServer(options: ServerOptions): Promise<ServerHandle> {
	const host = options.host ?? DEFAULT_SERVE_HOST;
	const port = options.port ?? DEFAULT_SERVE_PORT;
	const sockets = new Set<ServerResponse>();

	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", `http://${host}`);
		const path = url.pathname;
		// ADR-022：远端写路径（唯一允许非 GET 的路由）
		const promptMatch = /^\/api\/sessions\/([^/]+)\/prompt$/.exec(path);
		if (promptMatch?.[1] !== undefined) {
			if (request.method !== "POST") {
				sendError(response, 405, {
					code: "method_not_allowed",
					message: "only POST is supported on this route",
					retryable: false,
				});
				return;
			}
			const sessionId = decodeURIComponent(promptMatch[1]) as SessionId;
			// 交出去但**兜住**异常：一个请求绝不能把服务端打死
			void handlePrompt(options, sessionId, request, response).catch((error: unknown) => {
				sendError(response, 500, {
					code: "prompt_failed",
					message: error instanceof Error ? error.message : String(error),
					retryable: false,
				});
			});
			return;
		}
		if (request.method !== "GET") {
			sendError(response, 405, {
				code: "method_not_allowed",
				message: `only GET is supported`,
				retryable: false,
			});
			return;
		}
		if (path === "/api/event") {
			sockets.add(response);
			response.once("close", () => sockets.delete(response));
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				// 让中间代理不要缓冲（本地直连用不上，但写出来更诚实）
				"x-accel-buffering": "no",
			});
			response.write(
				frameLine({
					kind: "hello",
					protocolVersion: PROTOCOL_VERSION,
					resume: "replay-only",
				} satisfies HelloFrame),
			);
			void pumpEvents(response, options.feed);
			return;
		}
		if (path === "/api/sessions") {
			handleSessions(options.home, response);
			return;
		}
		const match = /^\/api\/sessions\/([^/]+)$/.exec(path);
		if (match?.[1] !== undefined) {
			handleSession(options.home, decodeURIComponent(match[1]) as SessionId, response);
			return;
		}
		sendError(response, 404, {
			code: "not_found",
			message: `no route for ${path}`,
			retryable: false,
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	const boundPort = typeof address === "object" && address !== null ? address.port : port;

	return {
		host,
		port: boundPort,
		url: `http://${host}:${boundPort}`,
		async close() {
			for (const response of sockets) response.destroy();
			sockets.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
