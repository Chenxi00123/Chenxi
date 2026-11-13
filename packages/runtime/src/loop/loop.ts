/**
 * 回合制主循环（ADR-004 / 02 §2.1）。
 *
 * 形态 = 「Pi 的双层 while」× 「dsh 的 turn = 0..N step」：
 *   一个回合 = 若干 step；每个 step = 采样 -> 若有 toolCall 则执行 + 回灌 -> 再采样。
 *
 * **主循环不写死任何策略**（ADR-004）：超时、权限、重试、审计一律经 `tools/execute`
 * waterfall 监听器插入。本文件只实现三件**结构性**语义：
 *   1) 不变量 1「模型可见 <=> 已记录」：消息只由 `deriveMessages(log.events)` 投影；
 *   2) **只读工具并发、写类串行**（Gemini Scheduler 思想，判据 #8）；
 *   3) **截断整批失败**：`stopReason==="length"` 时该批 toolCall 全部判失败、不执行、重发（判据 #4）。
 */
import type {
	AgentMode,
	EventDraft,
	EventType,
	SessionEvent,
	StopReason,
	ToolCallContext,
	ToolCallId,
	ToolCallRef,
	ToolExecutionResult,
	TurnId,
} from "@aster/schema";
import { DEFAULT_AGENT_MODE } from "@aster/schema";
import type { Context } from "../events/index.js";
import type { LlmProvider } from "../llm/types.js";
import { deriveMessages, type EventLog, newTurnId } from "../session/index.js";
import type { AfterToolCallHook, BeforeToolCallHook, ToolCallInput } from "../tools/execute.js";
import { executeTool } from "../tools/execute.js";
import type { ToolRegistry } from "../tools/registry.js";

/** 本回合可用工具的运行环境（缺省表示无工具）。 */
export interface ToolRuntime {
	readonly ctx: Context;
	readonly registry: ToolRegistry;
	readonly beforeHooks?: readonly BeforeToolCallHook[];
	readonly afterHooks?: readonly AfterToolCallHook[];
}

export interface RunTurnParams {
	/** 会话内存日志（`session.createEventLog` 产物），用于 deriveMessages 投影。 */
	readonly log: EventLog;
	/** 追加事件（通常来自 persist 的 SessionHandle.append）。 */
	readonly append: <T extends EventType>(draft: EventDraft<T>) => Promise<SessionEvent>;
	readonly provider: LlmProvider;
	readonly model: string;
	/** 可选 system 提示（M4 的 context 模块接入前，测试用固定串）。 */
	readonly system?: string;
	readonly signal?: AbortSignal;
	/** 收到流式文本增量时的回调（CLI 用它即时打印）。 */
	readonly onTextDelta?: (text: string) => void;
	/** 工具运行环境；缺省为「无工具」回合。 */
	readonly tools?: ToolRuntime;
	/** 当前模式（ADR-013）；M4 起参与权限判定。缺省 `plan`。 */
	readonly mode?: AgentMode;
	/** 工具执行的工作目录；缺省 `process.cwd()`。 */
	readonly cwd?: string;
	/** 单回合最大 step 数（防死循环）。缺省 16。 */
	readonly maxSteps?: number;
}

export interface TurnResult {
	readonly turnId: TurnId;
	readonly stopReason: StopReason;
	readonly content: string;
	/** 本回合实际执行的 step 数。 */
	readonly steps: number;
}

const DEFAULT_MAX_STEPS = 16;

/** 当前日志中已有的 `turn/start` 条数（确定性，不依赖随机/时间）。 */
function countTurnStarts(events: readonly SessionEvent[]): number {
	let count = 0;
	for (const event of events) {
		if (event.type === "turn/start") count += 1;
	}
	return count;
}

/**
 * 执行一批 tool call：**只读并发、写类串行**（判据 #8），
 * 返回顺序与入参**严格一致**（事件回灌顺序确定性）。
 */
async function executeBatch(
	calls: readonly ToolCallInput[],
	runtime: ToolRuntime,
	context: Parameters<typeof executeTool>[0]["context"],
): Promise<{ result: ToolExecutionResult; durationMs: number }[]> {
	const outcomes = new Map<ToolCallId, { result: ToolExecutionResult; durationMs: number }>();

	const isReadOnly = (call: ToolCallInput): boolean =>
		runtime.registry.get(call.toolName)?.metadata.readOnly === true;

	const runOne = async (call: ToolCallInput): Promise<void> => {
		const started = Date.now();
		const result = await executeTool({
			ctx: runtime.ctx,
			registry: runtime.registry,
			call,
			context: { ...context, callId: call.callId },
			...(runtime.beforeHooks === undefined ? {} : { beforeHooks: runtime.beforeHooks }),
			...(runtime.afterHooks === undefined ? {} : { afterHooks: runtime.afterHooks }),
		});
		outcomes.set(call.callId, { result, durationMs: Date.now() - started });
	};

	// 只读工具并发
	await Promise.all(calls.filter(isReadOnly).map(runOne));
	// 写类（含未知工具）串行
	for (const call of calls.filter((c) => !isReadOnly(c))) {
		await runOne(call);
	}

	return calls.map((call) => {
		const outcome = outcomes.get(call.callId);
		return (
			outcome ?? {
				result: {
					ok: false,
					error: { code: "internal_error", message: "tool produced no result", retryable: false },
				},
				durationMs: 0,
			}
		);
	});
}

/**
 * 执行一个回合（0..N step）。provider 抛错时：先补 `turn/end`（`error`）再抛原错误。
 */
export async function runTurn(params: RunTurnParams): Promise<TurnResult> {
	const index = countTurnStarts(params.log.events);
	const turnId = newTurnId(index);
	const maxSteps = params.maxSteps ?? DEFAULT_MAX_STEPS;

	await params.append({ type: "turn/start", payload: { turnId, index } });

	const callContext: ToolCallContext = {
		sessionId: params.log.sessionId,
		callId: "" as ToolCallId,
		mode: params.mode ?? DEFAULT_AGENT_MODE,
		cwd: params.cwd ?? process.cwd(),
		...(params.signal === undefined ? {} : { signal: params.signal }),
		// ADR-018：把**本会话**的日志访问权交给工具（`events` 是活数组，`append` 就是本会话的追加）
		sessionLog: { events: params.log.events, append: params.append },
	};

	const descriptors = params.tools?.registry.descriptors() ?? [];
	let steps = 0;
	let stopReason: StopReason = "end_turn";
	let lastContent = "";

	try {
		for (;;) {
			steps += 1;

			// 消息只由事件投影得到（核心不变量 1）
			const messages = deriveMessages(
				params.log.events,
				params.system === undefined ? {} : { system: params.system },
			);

			let streamed = "";
			let finalContent: string | undefined;
			let stepStop: StopReason = "end_turn";
			let toolCalls: readonly ToolCallRef[] = [];

			const stream = params.provider.stream({
				model: params.model,
				messages,
				...(descriptors.length > 0 ? { tools: descriptors } : {}),
				...(params.signal === undefined ? {} : { signal: params.signal }),
			});

			for await (const chunk of stream) {
				switch (chunk.kind) {
					case "text-delta":
						streamed += chunk.text;
						params.onTextDelta?.(chunk.text);
						break;
					case "usage":
						break;
					case "done":
						finalContent = chunk.message.content;
						toolCalls = chunk.message.toolCalls;
						stepStop = chunk.message.stopReason;
						break;
				}
			}

			const content = finalContent ?? streamed;
			lastContent = content;
			stopReason = stepStop;

			// 最终 assistant 事实落盘（流式 chunk 不落事件）
			await params.append({
				type: "assistant/message",
				payload: {
					content,
					stopReason: stepStop,
					...(toolCalls.length > 0 ? { toolCalls } : {}),
				},
			});

			if (toolCalls.length === 0) break;

			// 判据 #4：截断整批失败——该批 toolCall 全部判失败、**不执行**，然后重发
			if (stepStop === "length") {
				for (const call of toolCalls) {
					await params.append({
						type: "tool/result",
						payload: {
							callId: call.callId,
							toolName: call.toolName,
							ok: false,
							error: {
								code: "truncated",
								message:
									`Tool call "${call.toolName}" was NOT executed: the assistant message was truncated ` +
									`(stopReason=length), so the whole batch of ${toolCalls.length} call(s) was discarded. ` +
									"Please re-issue the calls (smaller batches help).",
								retryable: true,
							},
							durationMs: 0,
						},
					});
				}
				if (steps >= maxSteps) {
					stopReason = "error";
					break;
				}
				continue; // 重新采样
			}

			if (params.tools === undefined) {
				// 无工具运行环境：不能执行，回灌可读错误
				for (const call of toolCalls) {
					await params.append({
						type: "tool/result",
						payload: {
							callId: call.callId,
							toolName: call.toolName,
							ok: false,
							error: {
								code: "no_tool_runtime",
								message: `Tool "${call.toolName}" is not available in this session.`,
								retryable: false,
							},
							durationMs: 0,
						},
					});
				}
				if (steps >= maxSteps) {
					stopReason = "error";
					break;
				}
				continue;
			}

			// 执行 + 回灌（只读并发 / 写类串行）
			const calls: ToolCallInput[] = toolCalls.map((call) => ({
				callId: call.callId,
				toolName: call.toolName,
				input: call.input,
			}));
			const executed = await executeBatch(calls, params.tools, callContext);
			for (let i = 0; i < calls.length; i += 1) {
				const call = calls[i] as ToolCallInput;
				const outcome = executed[i];
				if (outcome === undefined) continue;
				await params.append({
					type: "tool/result",
					payload: {
						callId: call.callId,
						toolName: call.toolName,
						ok: outcome.result.ok,
						...(outcome.result.ok
							? { output: outcome.result.value }
							: { error: outcome.result.error }),
						durationMs: outcome.durationMs,
					},
				});
			}

			if (steps >= maxSteps) {
				stopReason = "error";
				break;
			}
		}
	} catch (error) {
		await params.append({ type: "turn/end", payload: { turnId, stopReason: "error" } });
		throw error;
	}

	await params.append({ type: "turn/end", payload: { turnId, stopReason } });
	return { turnId, stopReason, content: lastContent, steps };
}
