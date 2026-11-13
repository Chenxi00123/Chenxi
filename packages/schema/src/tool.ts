/**
 * 工具契约（ADR-005 / ADR-006 / ADR-009）。
 *
 * - **必须声明 output schema**，注册期即校验；schema 与执行期校验**同源**（ADR-005）。
 * - 权限判定的**唯一事实源是元数据**（ADR-006）；`resolveInput` 把入参归一化为
 *   「将执行的事实」，发生在 PreToolUse 钩子**之前**。
 */
import type { EventDraft, EventType, SessionEvent } from "./events.js";
import type { ToolCallId } from "./ids.js";
import type { AgentMode, PermissionDecision } from "./mode.js";

export interface SchemaIssue {
	readonly path: readonly (string | number)[];
	readonly message: string;
}

export type SchemaParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly issues: readonly SchemaIssue[] };

export type JsonSchema = Record<string, unknown>;

/**
 * 模型可见的工具描述（OpenAI 风格；ADR-005 的 prompt 侧投射）。
 * **定义在 schema 层**，使 `llm` 无需依赖 `runtime/tools`。
 */
export interface ToolDescriptor {
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: JsonSchema;
	};
}

/**
 * 值校验器（Standard Schema 风格的**自有**最小契约，保持 schema 包零依赖）。
 * 同一个 `parse` 同时服务于「注册期校验」与「执行期校验」，二者不会漂移。
 */
export interface ValueSchema<T> {
	readonly kind: "chenxi/value-schema";
	parse(input: unknown): SchemaParseResult<T>;
	toJsonSchema(): JsonSchema;
}

export type ToolSideEffectScope = "none" | "workspace" | "host";
export type ToolRiskLevel = "low" | "medium" | "high";

/** 权限事实源（ADR-006）：判定**只读**这些字段，不猜代码语义。 */
export interface ToolMetadata {
	readonly name: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly destructive: boolean;
	readonly sideEffectScope: ToolSideEffectScope;
	readonly riskLevel: ToolRiskLevel;
	readonly needsApproval: boolean;
}

/**
 * 会话日志的「只读投影 + 追加」能力（ADR-018）。
 *
 * 这是**执行期能力**（与 `signal?: AbortSignal` 同类），**不是**可序列化的审计事实：
 * 它由主循环在装配 `ToolCallContext` 时提供，供子代理 `fork`（读父会话投影）
 * 与 `background`（结果落父会话）使用。`events` 是**活的**日志数组，`append`
 * 就是父会话自己的 `SessionHandle.append`（因此 seq / JSONL / 索引始终由同一句柄维护）。
 */
export interface SessionLogAccess {
	readonly events: readonly SessionEvent[];
	append<T extends EventType>(draft: EventDraft<T>): Promise<SessionEvent>;
}

export interface ToolCallContext {
	readonly sessionId: string;
	readonly callId: ToolCallId;
	readonly mode: AgentMode;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	/** 父/当前会话的日志访问权（ADR-018；缺省表示该调用上下文不提供）。 */
	readonly sessionLog?: SessionLogAccess;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
	readonly metadata: ToolMetadata;
	readonly input: ValueSchema<TInput>;
	/** **必需**（ADR-005）：没有 output 声明的工具不允许注册。 */
	readonly output: ValueSchema<TOutput>;
	/** 归一化入参 -> 「将执行的事实」（ADR-006），早于任何 hook。 */
	resolveInput?(raw: unknown, ctx: ToolCallContext): TInput;
	execute(input: TInput, ctx: ToolCallContext): Promise<TOutput> | TOutput;
}

export interface ToolError {
	/** 稳定错误码，供扩展与测试断言。 */
	readonly code: string;
	/** 面向模型的**可读**错误文本。 */
	readonly message: string;
	readonly retryable: boolean;
}

export type ToolExecutionResult<T = unknown> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: ToolError };

/** 权限判定请求（`permission` 模块消费）。 */
export interface PermissionRequest {
	readonly metadata: ToolMetadata;
	/** 归一化后的「将执行的事实」。 */
	readonly resolvedInput: unknown;
	readonly mode: AgentMode;
	readonly cwd: string;
}

export interface PermissionVerdict {
	readonly decision: PermissionDecision;
	readonly reason: string;
	readonly deniedBy?: string;
}
