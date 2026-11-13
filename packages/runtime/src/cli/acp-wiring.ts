/**
 * Chenxi 的 `--acp` 装配（ADR-036）：把"一个回合"接到 ACP 最小通道上。
 *
 * 复用**同一份**会话编排（`executeTurn` / 权限 / 记忆 / context 构建），不新增后端：
 *  - **stdout 只走协议**（JSON-RPC）；所有诊断（config / mcp / memory 横幅）走 **stderr**；
 *  - `session/prompt` 的正文更新来自**已记录事件**（`assistant/message` 全文一块 + 工具调用状态），
 *    不是另起一条文本通道；
 *  - **没有审批通道**：ACP 客户端没实现 `session/request_permission` 之前，`ask` 一律 fail-closed deny
 *    （与 `--serve` 同一条结构性理由）；
 *  - `session/cancel` 只 abort **该会话**的 `AbortController`（不是进程级 SIGINT）。
 */
import type { SessionId } from "@chenxi/schema";
import type { AcpSessionHost, AcpSessionUpdate } from "../acp/index.js";
import { createAcpServer } from "../acp/index.js";
import type { SessionHandle } from "../persist/index.js";
import { createSessionStore } from "../persist/index.js";
import type { CliOptions } from "./args.js";
import { bootstrapSessionRuntime } from "./bootstrap.js";
import { createTraceAppender, executeTurn, type Output } from "./session-loop.js";

interface LiveSession {
	readonly handle: SessionHandle;
	readonly cwd: string;
	controller?: AbortController;
}

/** stopReason 映射（ACP 只认三个值；`error` 走 JSON-RPC error，不硬塞进枚举）。 */
function mapStop(stop: string): "end_turn" | "max_tokens" | "cancelled" {
	if (stop === "length") return "max_tokens";
	if (stop === "aborted") return "cancelled";
	return "end_turn";
}

export interface AcpStreams {
	readonly input: NodeJS.ReadableStream;
	/** **只**用于 JSON-RPC 协议消息（绝不可混入诊断文本）。 */
	readonly output: Output;
	/** 诊断输出（缺省 stderr）。 */
	readonly diagnostics: Output;
}

/** 启动 ACP 通道；读到 stdin EOF 时返回。 */
export async function startAcpCommand(options: CliOptions, streams: AcpStreams): Promise<void> {
	const runtime = await bootstrapSessionRuntime({ options, output: streams.diagnostics });
	const store = createSessionStore(options.home === undefined ? {} : { home: options.home });
	const live = new Map<SessionId, LiveSession>();
	const sink: Output = { write: () => undefined };
	let closed = false;

	const host: AcpSessionHost = {
		async createSession(input) {
			const handle = await store.create({ cwd: input.cwd, mode: runtime.defaultMode });
			live.set(handle.sessionId, { handle, cwd: input.cwd });
			return { sessionId: handle.sessionId };
		},
		async prompt(input) {
			const session = live.get(input.sessionId as SessionId);
			if (session === undefined) throw new Error(`unknown session: ${input.sessionId}`);
			if (runtime.provider === undefined) {
				throw new Error(
					"no model provider configured (set CHENXI_BASE_URL / CHENXI_API_KEY / CHENXI_MODEL)",
				);
			}
			const controller = new AbortController();
			session.controller = controller;
			const emit = (update: AcpSessionUpdate): void => input.onUpdate(update);

			// 正文与工具状态**全部来自已记录事件**（不另开文本通道）
			const appendWithTrace = createTraceAppender({
				handle: session.handle,
				output: sink,
				trace: false,
				onEvent: (event) => {
					if (event.type === "assistant/message") {
						emit({
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: event.payload.content },
						});
					} else if (event.type === "tool/call") {
						emit({
							sessionUpdate: "tool_call",
							toolCallId: event.payload.callId,
							title: event.payload.toolName,
							status: "in_progress",
						});
					} else if (event.type === "tool/result") {
						emit({
							sessionUpdate: "tool_call_update",
							toolCallId: event.payload.callId,
							status: event.payload.ok ? "completed" : "failed",
						});
					}
				},
			});

			// 事先建好 draft（executeTurn 内部落 user/message）
			const result = await executeTurn(
				{
					log: session.handle.log,
					appendWithTrace,
					provider: runtime.provider,
					...(runtime.model === undefined ? {} : { model: runtime.model }),
					mode: runtime.defaultMode,
					cwd: session.cwd,
					...(runtime.tools === undefined ? {} : { tools: runtime.tools }),
					permission: runtime.permission,
					contextBuilder: runtime.contextBuilder,
					...(runtime.memory === undefined
						? {}
						: { memorySeam: runtime.memory(session.handle.sessionId) }),
					...(runtime.compaction === undefined ? {} : { compaction: runtime.compaction }),
					signal: controller.signal,
					output: sink,
					trace: false,
				},
				input.text,
			);
			session.controller = undefined;

			if (result === undefined) {
				if (controller.signal.aborted) return { stopReason: "cancelled" };
				throw new Error("turn failed (model error); see the session log for details");
			}
			return { stopReason: mapStop(result.stopReason) };
		},
		cancel(sessionId) {
			live.get(sessionId as SessionId)?.controller?.abort();
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const session of live.values()) {
				try {
					await session.handle.append({ type: "session/end", payload: { reason: "exit" } });
				} catch {
					// 会话已不可写时不阻塞退出
				}
				await session.handle.close();
			}
			live.clear();
			await store.dispose();
			await runtime.dispose();
		},
	};

	const server = createAcpServer({ input: streams.input, output: streams.output, host });
	await server.done;
	await server.close();
}
