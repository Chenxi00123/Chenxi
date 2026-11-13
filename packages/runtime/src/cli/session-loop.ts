/**
 * 会话编排（ADR-022）：**前端无关**的"一个回合"。
 *
 * REPL（本地交互）与 server（远端非交互，`POST /api/sessions/:id/prompt`）**共用本文件**，
 * 因此权限钩子 / 记忆缝 / context 构建 / 事件出口只有**一份**实现——不会各自漂移。
 *
 * ⚠️ **本层所有 append 都必须经 `createTraceAppender` 返回的那个出口**
 * （`/mode`、`user/message`、记忆缝、`permission/decision`、`session/end` 一律如此）：
 * `onEvent`（ADR-021 的 SSE 生产者）挂在**这一个**出口上，否则订阅者会漏事件。
 * 这是 M11a 抓到的真 bug，M11b 又发现 `permission/decision` 曾漏挂（已收敛 + 回归测试）。
 */
import type {
	AgentMode,
	EventDraft,
	EventType,
	PermissionDecisionPayload,
	PermissionRequest,
	PermissionVerdict,
	SessionEvent,
} from "@chenxi/schema";
import type { CompactionConfig, ContextBuilder } from "../context/index.js";
import { planCompaction } from "../context/index.js";
import type { LlmProvider } from "../llm/types.js";
import type { ToolRuntime } from "../loop/index.js";
import { runTurn, type TurnResult } from "../loop/index.js";
import type { MemorySeam } from "../memory/index.js";
import type { PermissionSystem } from "../permission/index.js";
import { createPermissionHook } from "../permission/index.js";
import type { SessionHandle } from "../persist/index.js";
import type { EventLog } from "../session/index.js";

/** 输出目标（REPL 的 stdout、TUI 的屏幕行收集器、server 的审计日志都符合这个形状）。 */
export interface Output {
	write(text: string): void;
}

/** 首行摘要（工具结果可能多行，终端只显示第一行）。 */
function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index === -1 ? text : text.slice(0, index);
}

/**
 * 建"追加 + 轨迹打印"出口：先落盘（`handle.append`），再让订阅者看到同一条事实。
 *
 * 顺序很关键：事件**已经**落进事实源与索引，`onEvent` 只是"顺手让订阅者看到"，
 * 因此它**不是**新的写入路径（ADR-021）。
 *
 * `trace: false` 用于**结构化前端**（TUI，ADR-023）：`tool_call` / `tool_result` **已有事件**，
 * 由前端按事件渲染；本层**不再重复打印**文本轨迹（否则同一事实会出现两遍）。
 */
export function createTraceAppender(params: {
	readonly handle: SessionHandle;
	readonly output: Output;
	readonly onEvent?: (event: SessionEvent) => void;
	readonly trace?: boolean;
}): <T extends EventType>(draft: EventDraft<T>) => Promise<SessionEvent> {
	const { handle, output, onEvent } = params;
	const trace = params.trace !== false;
	return async <T extends EventType>(draft: EventDraft<T>): Promise<SessionEvent> => {
		const event = await handle.append(draft);
		onEvent?.(event);
		if (!trace) return event;
		if (event.type === "assistant/message") {
			for (const call of event.payload.toolCalls ?? []) {
				output.write(`\n  → tool_call: ${call.toolName} ${JSON.stringify(call.input)}\n`);
			}
		}
		if (event.type === "tool/result") {
			const payload = event.payload;
			const status = payload.ok
				? "ok"
				: `error(${payload.error?.code ?? "unknown"}): ${firstLine(payload.error?.message ?? "")}`;
			output.write(`  ← tool_result: ${payload.toolName} ${status}\n`);
		}
		return event;
	};
}

/** 一次回合并发所需的一切（**不持有** REPL 的交互态：控制器与 SIGINT 由前端自己管）。 */
export interface TurnOptions {
	readonly appendWithTrace: <T extends EventType>(draft: EventDraft<T>) => Promise<SessionEvent>;
	readonly output: Output;
	/** 会话内存日志（投影源）。 */
	readonly log: EventLog;
	/** 缺省表示"仅记录"：只落 `user/message`，不跑模型。 */
	readonly provider?: LlmProvider;
	readonly model?: string;
	/** 当次模式（ADR-013：由调用方按**当前**模式传入，本层不缓存）。 */
	readonly mode: AgentMode;
	readonly cwd: string;
	readonly tools?: ToolRuntime;
	readonly permission?: PermissionSystem;
	/** 审批通道；**缺省 = 无审批通道 → `ask` fail-closed deny**（ADR-007）。 */
	readonly approve?: (
		request: PermissionRequest,
		verdict: PermissionVerdict,
	) => Promise<boolean> | boolean;
	/** 记忆注入缝（ADR-016）：在 `runTurn` **之前**调 `beforeTurn`。 */
	readonly memorySeam?: MemorySeam;
	/**
	 * 长会话上下文压缩（M23，ADR-041）：**缺省不做**（不配置时行为与 M22 逐字节相同）。
	 * 开启时在 `user/message` 落盘**之前**压缩更早的整回合，并落 `context/compacted` 事实。
	 */
	readonly compaction?: CompactionConfig;
	readonly contextBuilder?: ContextBuilder;
	/** 显式 system 提示（优先级低于 `contextBuilder`）。 */
	readonly system?: string;
	readonly signal?: AbortSignal;
	/**
	 * 是否打印"**已有事件**的文本事实"（`+ user/message#N`、`~ memory: injected`）。缺省 true。
	 * 结构化前端（TUI / ADR-023）传 false：这些事实由**事件**渲染，本层不再重复打印。
	 * （`! memory unavailable` 这类**没有事件**的提示**不受影响**——它只能走文本通道。）
	 */
	readonly trace?: boolean;
}

/**
 * 跑一个回合（含 `user/message` 落盘、记忆注入、权限钩子、模式对账、`runTurn`）。
 * 返回 `undefined` 表示"未跑模型"（无 provider）或"回合出错/被中止"（已打印可读原因）。
 */
export async function executeTurn(
	options: TurnOptions,
	prompt: string,
): Promise<TurnResult | undefined> {
	// M23（ADR-041）：先压掉更早的整回合，再落本回合的 `user/message`
	// ——顺序很关键：摘要事件必须出现在新消息**之前**，投影才是"摘要 → 最近回合"。
	// 只在显式配置了 `context.compaction.enabled` 时才有 `options.compaction`。
	if (options.compaction !== undefined) {
		const plan = planCompaction(options.log.events, options.compaction);
		if (plan !== undefined) {
			await options.appendWithTrace({
				type: "context/compacted",
				payload: {
					fromSeq: plan.fromSeq,
					toSeq: plan.toSeq,
					removedMessages: plan.removedMessages,
					removedChars: plan.removedChars,
					keepTurns: plan.keepTurns,
					strategy: "truncate",
					summary: plan.summary,
				},
			});
			// 压缩本身是**已有事件**：结构化前端自己渲染，这里只在 trace 模式补一行
			if (options.trace !== false) {
				options.output.write(
					`  ~ context: compacted ${plan.removedMessages} message(s) (seq ${plan.fromSeq}-${plan.toSeq})\n`,
				);
			}
		}
	}

	const event = await options.appendWithTrace({
		type: "user/message",
		payload: { content: prompt },
	});
	if (options.trace !== false) options.output.write(`  + user/message#${event.seq}\n`);

	if (options.provider === undefined) return undefined;

	// ADR-016：`before_turn` —— 先落 `memory/injected` 事件，再由投影成为消息前缀
	if (options.memorySeam !== undefined) {
		const outcome = await options.memorySeam.beforeTurn(prompt, options.appendWithTrace);
		if (outcome.kind === "injected") {
			// 注入**已有事件**（`memory/injected`）⇒ 结构化前端自己渲染，不重复打印
			if (options.trace !== false) {
				options.output.write(`  ~ memory: injected ${outcome.memoryIds.length} record(s)\n`);
			}
		} else if (outcome.kind === "failed") {
			// 失败不阻塞：记忆只是增强（**没有事件**，故不受 trace 开关影响）
			options.output.write(`  ! memory unavailable: ${outcome.reason}\n`);
		}
	}

	// 权限以 beforeToolCall 钩子接入（ADR-004）；判定事件落 `permission/decision`
	const baseTools = options.tools;
	const tools =
		baseTools === undefined || options.permission === undefined
			? baseTools
			: {
					...baseTools,
					beforeHooks: [
						...(baseTools.beforeHooks ?? []),
						createPermissionHook({
							system: options.permission,
							...(options.approve === undefined ? {} : { approve: options.approve }),
							record: (payload: PermissionDecisionPayload) =>
								options
									.appendWithTrace({ type: "permission/decision", payload })
									.then(() => undefined),
						}),
					],
				};
	// ADR-013 模式对账：本回合基于当前模式重建 system prompt，绝不缓存
	const system =
		options.contextBuilder === undefined
			? options.system
			: options.contextBuilder.buildSystem({
					mode: options.mode,
					cwd: options.cwd,
					...(options.tools === undefined ? {} : { registry: options.tools.registry }),
				});

	let result: TurnResult | undefined;
	try {
		let printed = false;
		result = await runTurn({
			log: options.log,
			append: options.appendWithTrace,
			provider: options.provider,
			model: options.model ?? "unknown",
			mode: options.mode,
			cwd: options.cwd,
			...(options.signal === undefined ? {} : { signal: options.signal }),
			onTextDelta: (text) => {
				printed = true;
				options.output.write(text);
			},
			...(system === undefined ? {} : { system }),
			...(tools === undefined ? {} : { tools }),
		});
		if (printed) options.output.write("\n");
		options.output.write(`  [assistant stopped: ${result.stopReason}, steps=${result.steps}]\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = options.signal?.aborted === true;
		options.output.write(`  [${aborted ? "turn aborted" : "model error"}] ${message}\n`);
	}

	// ADR-033：`after_turn` 写入（**只从本轮用户原话抽**）。未配置写入时 `afterTurn` 不存在
	// ⇒ 行为与既有一字不差；写入侧自身 fail-open，这里的 catch 只是最后一道保险。
	if (options.memorySeam?.afterTurn !== undefined) {
		try {
			const report = await options.memorySeam.afterTurn(
				{ prompt, sourceSeq: event.seq },
				options.appendWithTrace,
			);
			const total = report.added + report.skipped + report.rejected + report.failed;
			if (options.trace !== false && total > 0) {
				const parts = [`${report.added} added`];
				if (report.skipped > 0) parts.push(`${report.skipped} skipped`);
				if (report.rejected > 0) parts.push(`${report.rejected} rejected`);
				if (report.failed > 0) parts.push(`${report.failed} failed`);
				options.output.write(`  ~ memory: ${parts.join(", ")}\n`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.output.write(`  ! memory write unavailable: ${message}\n`);
		}
	}

	return result;
}
