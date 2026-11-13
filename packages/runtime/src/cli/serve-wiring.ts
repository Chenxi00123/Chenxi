/**
 * `--serve` 装配（ADR-021 / ADR-022）：把 SSE 服务端、事件生产者与**远端写路径**接到 CLI 上。
 *
 * 单独成文件既满足 400 行门禁，也让"服务端怎么起、写路径什么时候给"这一件事**一处可读**：
 *  - **写路径只在回环绑定时注入**——未鉴权的远端写路径不允许存在（对外暴露时一律 501）；
 *  - **没有模型端点 ⇒ 不注入 driver**（跑不了回合，就不该假装能写）；
 *  - **live 会话集合**由 REPL 经 `registerLive()` 登记，driver 据此对同一会话返回 409
 *    （一个会话一个写入者，避免同一 JSONL 出现两个写入者）。
 */
import type { SessionEvent, SessionId } from "@aster/schema";
import type { ContextBuilder } from "../context/index.js";
import type { LlmProvider } from "../llm/types.js";
import type { ToolRuntime } from "../loop/index.js";
import type { MemorySeam } from "../memory/index.js";
import type { PermissionSystem } from "../permission/index.js";
import { resolveHome } from "../persist/index.js";
import {
	createEventFeed,
	createEventProducer,
	createPromptDriver,
	DEFAULT_SERVE_HOST,
	isLoopbackHost,
	type PromptDriver,
	type ServerHandle,
	startServer,
} from "../serve/index.js";

export interface ServeWiringOptions {
	readonly home?: string;
	readonly host?: string;
	readonly port?: number;
	/** 缺省 = 只跑只读面（不能跑回合，就不注入写路径）。 */
	readonly provider?: LlmProvider;
	readonly model?: string;
	readonly tools?: ToolRuntime;
	readonly permission: PermissionSystem;
	readonly contextBuilder: ContextBuilder;
	readonly memory?: (sessionId: SessionId) => MemorySeam;
	readonly write: (text: string) => void;
}

export interface ServeWiring {
	readonly handle: ServerHandle;
	/** 每条**已记录**事件记完之后喂给 SSE 扇出（**不是**新的写入路径）。 */
	readonly onEvent: (event: SessionEvent) => void;
	/** REPL 建好会话后登记为 live（远端 prompt 对它们一律 409）。 */
	registerLive(sessionId: SessionId): void;
}

export async function startServeCommand(options: ServeWiringOptions): Promise<ServeWiring> {
	const home = resolveHome(options.home);
	const feed = createEventFeed();
	const boundHost = options.host ?? DEFAULT_SERVE_HOST;
	const liveSessions = new Set<SessionId>();

	let driver: PromptDriver | undefined;
	if (!isLoopbackHost(boundHost)) {
		// 未鉴权 + 对外暴露 ⇒ **不允许**远端写（ADR-022 的结构性围栏）
		options.write(
			`serve: remote write disabled — bound to ${boundHost} (prompts are loopback-only)\n`,
		);
	} else if (options.provider === undefined || options.model === undefined) {
		options.write("serve: remote write disabled — no model endpoint configured\n");
	} else {
		driver = createPromptDriver({
			home,
			provider: options.provider,
			model: options.model,
			...(options.tools === undefined ? {} : { tools: options.tools }),
			permission: options.permission,
			contextBuilder: options.contextBuilder,
			...(options.memory === undefined ? {} : { memory: options.memory }),
			onEvent: createEventProducer(feed),
			output: { write: options.write },
			isLive: (sessionId) => liveSessions.has(sessionId),
		});
	}

	const handle = await startServer({
		home,
		feed,
		...(driver === undefined ? {} : { driver }),
		...(options.host === undefined ? {} : { host: options.host }),
		...(options.port === undefined ? {} : { port: options.port }),
	});

	options.write(`serve: ${handle.url} (read-only mirror)\n`);
	options.write(
		"serve: GET /api/event (SSE) | GET /api/sessions | GET /api/sessions/<id>\n" +
			"serve: POST /api/sessions/<id>/prompt " +
			(driver === undefined
				? "(disabled)\n"
				: "(remote write, no approval channel -> ask denied)\n") +
			"serve: no auth; no resume on the stream (reconnect and replay instead)\n",
	);
	if (!isLoopbackHost(handle.host)) {
		options.write(`serve: WARNING — bound to ${handle.host} without authentication\n`);
	}

	return {
		handle,
		onEvent: createEventProducer(feed),
		registerLive: (sessionId) => void liveSessions.add(sessionId),
	};
}
