/**
 * 非交互会话驱动器（ADR-022）：`POST /api/sessions/:id/prompt` 的后端。
 *
 * 四条铁律：
 *  1. **单一写入者**——走 `persist` 的 `store.resume(id)` + `handle.append`（经 `session-loop`
 *     的 trace 出口），**绝不**直接写 JSONL、绝不新增第二条写入路径（ADR-008 / ADR-018 同款纪律）；
 *  2. **无审批通道** → `ask` 一律 **fail-closed deny**（ADR-007；与子代理 ADR-017 同一条规则）；
 *  3. **live 会话拒写**——同一份 JSONL 不得出现两个写入者（否则 seq 打架、派生索引漂移）；
 *  4. **同会话串行**——按会话 id 排队，避免两次 prompt 交错写同一个日志。
 *
 * 模式 / cwd **取自会话自身**（最后一条 `mode/changed`，否则 `session/start`），不由客户端指定。
 */
import type { SessionEvent, SessionId, StopReason } from "@chenxi/schema";
import { createTraceAppender, executeTurn, type Output } from "../cli/session-loop.js";
import type { CompactionConfig, ContextBuilder } from "../context/index.js";
import type { LlmProvider } from "../llm/types.js";
import type { ToolRuntime } from "../loop/index.js";
import type { MemorySeam } from "../memory/index.js";
import type { PermissionSystem } from "../permission/index.js";
import { createSessionStore } from "../persist/index.js";
import { deriveDiskMeta } from "./source.js";

export interface PromptDriverOptions {
	readonly home: string;
	/** 没有 provider 就不该构造 driver（构造方负责判定）。 */
	readonly provider: LlmProvider;
	readonly model: string;
	readonly tools?: ToolRuntime;
	readonly permission?: PermissionSystem;
	readonly contextBuilder?: ContextBuilder;
	/** 长会话上下文压缩（M23，ADR-041）；缺省不做。 */
	readonly compaction?: CompactionConfig;
	/** 记忆注入缝工厂（按会话 id 构造；缺省不注入）。 */
	readonly memory?: (sessionId: SessionId) => MemorySeam;
	/** 每条**已记录**事件记完之后的回调（ADR-021：喂给 SSE 扇出）。 */
	readonly onEvent: (event: SessionEvent) => void;
	/** 审计输出（缺省静默）。 */
	readonly output?: Output;
	/** live 判定：命中的会话**拒绝写入**（409）。 */
	readonly isLive?: (sessionId: SessionId) => boolean;
}

/** 一次远端 prompt 的结果（与 HTTP 状态码一一对应）。 */
export type PromptOutcome =
	| {
			readonly kind: "ok";
			readonly sessionId: SessionId;
			readonly stopReason: StopReason;
			readonly steps: number;
			readonly content: string;
			readonly eventCount: number;
	  }
	| { readonly kind: "not_found"; readonly sessionId: SessionId }
	| { readonly kind: "unreadable"; readonly sessionId: SessionId }
	| { readonly kind: "live"; readonly sessionId: SessionId }
	| { readonly kind: "failed"; readonly sessionId: SessionId; readonly message: string };

export interface PromptDriver {
	run(sessionId: SessionId, prompt: string): Promise<PromptOutcome>;
}

const SILENT: Output = { write: () => undefined };

export function createPromptDriver(options: PromptDriverOptions): PromptDriver {
	const output = options.output ?? SILENT;
	/** 同会话串行：后一次 prompt 排在**前一次之后**（不是并行写同一个日志）。 */
	const queues = new Map<SessionId, Promise<unknown>>();

	const runOne = async (sessionId: SessionId, prompt: string): Promise<PromptOutcome> => {
		if (options.isLive?.(sessionId) === true) return { kind: "live", sessionId };

		const store = createSessionStore({ home: options.home });
		let handle: Awaited<ReturnType<typeof store.resume>>;
		try {
			handle = await store.resume(sessionId);
		} catch {
			await store.dispose();
			return { kind: "not_found", sessionId };
		}

		try {
			// 会话事实源里必须有 `session/start`（cwd / mode 的来源）；否则不可读
			const meta = deriveDiskMeta(sessionId, handle.log.events);
			if (meta === undefined) return { kind: "unreadable", sessionId };

			// 唯一出口：事件先落盘、再喂订阅者（不是新的写入路径）
			const appendWithTrace = createTraceAppender({
				handle,
				output,
				onEvent: options.onEvent,
			});
			const before = handle.log.length;
			// ⚠️ 不传 `approve`：服务端**无审批通道** ⇒ `ask` fail-closed deny（ADR-007）
			const result = await executeTurn(
				{
					appendWithTrace,
					output,
					log: handle.log,
					provider: options.provider,
					model: options.model,
					mode: meta.mode,
					cwd: meta.cwd,
					...(options.tools === undefined ? {} : { tools: options.tools }),
					...(options.permission === undefined ? {} : { permission: options.permission }),
					...(options.contextBuilder === undefined
						? {}
						: { contextBuilder: options.contextBuilder }),
					...(options.memory === undefined ? {} : { memorySeam: options.memory(sessionId) }),
					...(options.compaction === undefined ? {} : { compaction: options.compaction }),
				},
				prompt,
			);

			return {
				kind: "ok",
				sessionId,
				stopReason: result?.stopReason ?? "error",
				steps: result?.steps ?? 0,
				content: result?.content ?? "",
				eventCount: handle.log.length - before,
			};
		} catch (error) {
			// 存储错误（首个错误即封禁）等：以可读原因收场，绝不假装成功
			return {
				kind: "failed",
				sessionId,
				message: error instanceof Error ? error.message : String(error),
			};
		} finally {
			await handle.close();
			await store.dispose();
		}
	};

	return {
		run(sessionId, prompt) {
			const previous = queues.get(sessionId) ?? Promise.resolve();
			const next = previous.then(
				() => runOne(sessionId, prompt),
				() => runOne(sessionId, prompt),
			);
			queues.set(sessionId, next);
			return next.finally(() => {
				if (queues.get(sessionId) === next) queues.delete(sessionId);
			});
		},
	};
}
