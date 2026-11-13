/**
 * 事件流帧（ADR-021：client/server 采用「单全局订阅 + 每连接有界队列」）。
 * ADR-022 追加一条 §POST /api/sessions/:id/prompt§ 的**响应**形状（只加形状，不改既有帧）。
 */
import type { SessionEvent, SessionId, StopReason } from "@aster/schema";

export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * 握手帧（ADR-021）：连接一开始就**把契约说清楚**——
 * `resume: "replay-only"` 明确"本流**不做断点续传**，要续请整段回放"。
 */
export interface HelloFrame {
	readonly kind: "hello";
	readonly protocolVersion: ProtocolVersion;
	/** 断线后如何续：只有"整段回放"这一条路（见 ADR-021）。 */
	readonly resume: "replay-only";
}

/** 单条事件帧。 */
export interface EventFrame {
	readonly kind: "event";
	readonly event: SessionEvent;
}

/** 错误帧：`retryable=false` 表示不可续（对应不变量 5「首个存储错误即封禁」）。 */
export interface ErrorFrame {
	readonly kind: "error";
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}

/** 会话标识帧（resume / 订阅握手用）。 */
export interface SessionFrame {
	readonly kind: "session";
	readonly sessionId: SessionId;
}

export type StreamFrame = HelloFrame | EventFrame | ErrorFrame | SessionFrame;

/**
 * `POST /api/sessions/:id/prompt` 的**请求体**（ADR-022）。
 * 只有 `prompt` 一个必填字段：模式 / cwd 由**会话自身**决定，不由客户端指定。
 */
export interface PromptRequest {
	readonly prompt: string;
}

/**
 * `POST /api/sessions/:id/prompt` 的**响应**（ADR-022）：
 * 一次远端 prompt = **一个回合**；`eventCount` 是本回合**新落盘**的事件条数（可审计）。
 */
export interface PromptResultFrame {
	readonly kind: "prompt-result";
	readonly sessionId: SessionId;
	readonly stopReason: StopReason;
	readonly steps: number;
	/** 最后一条 assistant 文本（可能为空——纯工具调用回合）。 */
	readonly content: string;
	readonly eventCount: number;
}

/** JSON 响应体（成功帧或错误帧）。 */
export type JsonFrame = PromptResultFrame | ErrorFrame;
