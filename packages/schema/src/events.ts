/**
 * 事件溯源会话模型（ADR-003）。
 *
 * 核心不变量 1：「模型可见 <=> 已记录」——任何进入模型请求的输入，
 * 必须能且只能由本文件定义的事件重建。新增模型可见输入 => 新增事件类型。
 *
 * 事件是 append-only 的**不可约事实**；模型历史由 `deriveMessages()` 投影得出，
 * 投影必须**幂等**、resume 必须**确定性**（ADR-003 后果）。
 */
import type { EventId, SessionId, ToolCallId, TurnId } from "./ids.js";
import type { AgentMode, PermissionDecision } from "./mode.js";
import type { SessionFormatVersion } from "./version.js";

/** 模型停止原因（截断整批失败依赖 `length`，见 ADR & 判据 #4）。 */
export type StopReason = "end_turn" | "tool_call" | "length" | "error" | "aborted";

export type SessionEndReason = "exit" | "error" | "interrupted";

/**
 * 事件类型枚举（v0.1 全集）。
 *
 * **同时导出取值常量**（`EVENT_TYPES`）：导入外部交换文档（ADR-019）需要在**运行期**校验
 * `type` 是否属于本格式，而类型联合无法在运行期使用。
 */
export const EVENT_TYPES = [
	"session/start",
	"session/end",
	"turn/start",
	"turn/end",
	"user/message",
	"assistant/message",
	"tool/call",
	"tool/result",
	"permission/decision",
	"mode/changed",
	"memory/injected",
	"memory/written",
	"context/compacted",
	"subagent/context-imported",
	"subagent/result",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** 所有事件的公共基底。 */
export interface EventBase<TType extends EventType, TPayload> {
	/** 会话内单调递增序号（从 0 开始），用于顺序与幂等。 */
	readonly seq: number;
	/** 事件 id，形如 `evt_<seq>`。 */
	readonly id: EventId;
	readonly sessionId: SessionId;
	readonly type: TType;
	/** ISO-8601 时间戳。 */
	readonly at: string;
	readonly payload: TPayload;
}

export interface SessionStartPayload {
	readonly formatVersion: SessionFormatVersion;
	readonly cwd: string;
	readonly mode: AgentMode;
	/** 模型 id（可空——空循环场景无模型）。 */
	readonly model?: string;
	/**
	 * 父会话 id（ADR-017：子代理=独立会话）。
	 * **可选附加字段**，不构成破坏性格式变更（`SESSION_FORMAT_VERSION` 保持 `1`）。
	 */
	readonly parentSessionId?: SessionId;
}

export interface SessionEndPayload {
	readonly reason: SessionEndReason;
}

export interface TurnStartPayload {
	readonly turnId: TurnId;
	readonly index: number;
}

export interface TurnEndPayload {
	readonly turnId: TurnId;
	readonly stopReason: StopReason;
}

export interface UserMessagePayload {
	readonly content: string;
}

/** assistant 最终消息（流式 chunk 不落事件——只有最终事实落盘，保证投影确定性）。 */
export interface AssistantMessagePayload {
	readonly content: string;
	readonly toolCalls?: readonly ToolCallRef[];
	readonly stopReason?: StopReason;
}

export interface ToolCallRef {
	readonly callId: ToolCallId;
	readonly toolName: string;
	readonly input: unknown;
}

export interface ToolCallPayload {
	readonly callId: ToolCallId;
	readonly toolName: string;
	readonly input: unknown;
}

export interface ToolErrorInfo {
	readonly code: string;
	/** 面向模型的**可读**错误文本（ADR & 判据 #2/#3）。 */
	readonly message: string;
	readonly retryable: boolean;
}

export interface ToolResultPayload {
	readonly callId: ToolCallId;
	readonly toolName: string;
	readonly ok: boolean;
	readonly output?: unknown;
	readonly error?: ToolErrorInfo;
	readonly durationMs: number;
}

export interface PermissionDecisionPayload {
	readonly callId: ToolCallId;
	readonly toolName: string;
	readonly decision: PermissionDecision;
	readonly reason: string;
	/** 被哪个 guard 否决（若有）。 */
	readonly deniedBy?: string;
}

export interface ModeChangedPayload {
	readonly from: AgentMode;
	readonly to: AgentMode;
	readonly reason: string;
}

/** 记忆注入事件（缝 3 / ADR-011）——保证「注入即记录」。 */
export interface MemoryInjectedPayload {
	readonly target: "system-stable" | "user-prefix";
	readonly source: string;
	readonly content: string;
	readonly memoryIds: readonly string[];
}

/**
 * 记忆写入**决策**（ADR-033 / ADR-034）。
 *
 * 语义精确到"这一条候选最后怎么样了"，不留"大概写了"这种模糊态：
 *  - `added`：真的写进记忆层了（`memoryId` 有则记，没有就是服务端没返回）；
 *  - `skipped_duplicate`：记忆层里已有归一化后完全相同的记录 ⇒ **不写**；
 *  - `rejected`：被**确定性闸门**挡下（长度 / 密钥样式 / 注入样式 / 超出每轮上限）；
 *  - `failed`：闸门过了但写入链路失败（搜索去重 / 写入 / 失效 / 写后验证）。
 */
export type MemoryWriteDecision = "added" | "skipped_duplicate" | "rejected" | "failed";

/**
 * 记忆写入事件（ADR-033）——**每一次候选决策都落一条**（审计：为什么不写 / 写了什么）。
 *
 * 与 `memory/injected` 同一条纪律的另一半：注入保证"模型看见的一定记录在案"，
 * 写入保证"往长期记忆里加了什么、以及**为什么没加**一定记录在案"。
 * 它**不参与投影**（`deriveMessages` 忽略它）——记忆只在下一回合的注入里才可能进入上下文。
 */
export interface MemoryWrittenPayload {
	readonly decision: MemoryWriteDecision;
	/** 候选正文（截断后的**用户原话**；审计要能直接看出写了什么）。 */
	readonly content: string;
	/** 从哪条 `user/message` 抽出的（seq）——审计可回溯到原话所在回合。 */
	readonly sourceSeq: number;
	/** 写入成功后服务端返回的 id（可缺：服务端不返回时我们不臆造稳定标识）。 */
	readonly memoryId?: string;
	/** 跳过 / 拒绝 / 失败的可读原因。 */
	readonly reason?: string;
	/** M17b：本轮被**失效**的旧记忆 id（显式 supersede 且有目标时）。 */
	readonly invalidatedIds?: readonly string[];
	/**
	 * M17b：**写后验证**结论。`ok` = 旧记录已不可检索或已带 `invalidAt`；
	 * `old_still_visible` = 新事实已写入但旧事实仍可检索（**矛盾已存在，绝不假装成功**）。
	 */
	readonly verification?: "ok" | "old_still_visible";
}

/**
 * 子代理派发方式（ADR-017 / ADR-018）。
 * 定义在 schema 层：`subagent/result` 的载荷需要它，而 schema 不得依赖 runtime。
 */
export type SubagentKind = "fresh" | "fork";

/**
 * `fork` 的上下文导入事实（ADR-018）：「导入即记录」——把**父会话当时的投影**
 * 逐条记录在案；`deriveMessages` 负责把它**展开**为子会话历史（记录是事实，展开是投影）。
 * `parentSessionId` 已落在子会话的 `session/start` 里，故此处不重复。
 */
export interface SubagentContextImportedPayload {
	readonly messages: readonly ModelMessage[];
}

/**
 * 后台子代理的结果（ADR-018）：由**后台 flow** 追加到**父会话**，
 * 供投影在「下一回合」（严格说：晚于最后一条 `assistant/message` 时）以 user 角色通知送达模型。
 */
export interface SubagentResultPayload {
	readonly childSessionId: SessionId;
	readonly kind: SubagentKind;
	readonly ok: boolean;
	/** `ok=true` 时的最终文本摘要。 */
	readonly summary?: string;
	readonly steps?: number;
	readonly stopReason?: StopReason;
	/** `ok=false` 时的**可读**失败原因。 */
	readonly error?: string;
}

/**
 * 上下文压缩事实（M23，ADR-041）：把 `[fromSeq, toSeq]` 区间内的**消息类事件**
 * 从模型投影中省略，并在压缩事件的位置插入一段**确定性摘要**。
 *
 * 纪律：
 *  - 这是**事实**（所以进 JSONL）：投影被它改变，等于"模型看到什么"是已记录的；
 *  - 区间**只覆盖整回合**（边界落在 `turn/start` 之前的消息事件），绝不切断
 *    `assistant(toolCalls)` 与 `tool/result` 的配对；
 *  - 区间**不重叠**（新的压缩从上一段 `toSeq` 之后开始）；
 *  - `summary` 是**确定性生成**的文本（不调用模型）⇒ 回放 / resume 后投影一致。
 */
export interface ContextCompactedPayload {
	/** 被省略区间的起始 seq（含）。 */
	readonly fromSeq: number;
	/** 被省略区间的结束 seq（含）。 */
	readonly toSeq: number;
	/** 被省略的消息条数（user / assistant / tool）。 */
	readonly removedMessages: number;
	/** 被省略文本的总字符数（估算上下文压力用）。 */
	readonly removedChars: number;
	/** 保留的最近回合数。 */
	readonly keepTurns: number;
	/** 压缩策略：当前只有确定性截断。 */
	readonly strategy: "truncate";
	/** 投影时替代被省略区间的摘要文本（确定性，不含模型输出）。 */
	readonly summary: string;
}

export type SessionEvent =
	| EventBase<"session/start", SessionStartPayload>
	| EventBase<"session/end", SessionEndPayload>
	| EventBase<"turn/start", TurnStartPayload>
	| EventBase<"turn/end", TurnEndPayload>
	| EventBase<"user/message", UserMessagePayload>
	| EventBase<"assistant/message", AssistantMessagePayload>
	| EventBase<"tool/call", ToolCallPayload>
	| EventBase<"tool/result", ToolResultPayload>
	| EventBase<"permission/decision", PermissionDecisionPayload>
	| EventBase<"mode/changed", ModeChangedPayload>
	| EventBase<"memory/injected", MemoryInjectedPayload>
	| EventBase<"memory/written", MemoryWrittenPayload>
	| EventBase<"context/compacted", ContextCompactedPayload>
	| EventBase<"subagent/context-imported", SubagentContextImportedPayload>
	| EventBase<"subagent/result", SubagentResultPayload>;

/** 载荷类型按事件类型查询（供构造器做类型安全）。 */
export interface PayloadByType {
	"session/start": SessionStartPayload;
	"session/end": SessionEndPayload;
	"turn/start": TurnStartPayload;
	"turn/end": TurnEndPayload;
	"user/message": UserMessagePayload;
	"assistant/message": AssistantMessagePayload;
	"tool/call": ToolCallPayload;
	"tool/result": ToolResultPayload;
	"permission/decision": PermissionDecisionPayload;
	"mode/changed": ModeChangedPayload;
	"memory/injected": MemoryInjectedPayload;
	"memory/written": MemoryWrittenPayload;
	"context/compacted": ContextCompactedPayload;
	"subagent/context-imported": SubagentContextImportedPayload;
	"subagent/result": SubagentResultPayload;
}

/** 待追加的事件草稿（缺少 seq/id/sessionId，由会话追加时补齐）。 */
export type EventDraft<TType extends EventType = EventType> = {
	readonly type: TType;
	readonly payload: PayloadByType[TType];
	/** 可选显式时间戳；缺省由追加器填充。 */
	readonly at?: string;
};

/**
 * 投影后的模型消息（供 `llm` 使用）。
 * **只由事件投影得到，绝不旁路注入**（不变量 1）。
 */
export interface ModelMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: string;
	/** role=tool 时对应的调用 id。 */
	readonly toolCallId?: ToolCallId;
	/** role=assistant 时的工具调用请求。 */
	readonly toolCalls?: readonly ToolCallRef[];
}
