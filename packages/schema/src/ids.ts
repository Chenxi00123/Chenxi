/**
 * 标识符类型（branded）。
 *
 * schema 层**只定义类型**，具体生成函数（依赖 crypto）放在 `runtime/session` 内，
 * 以保持本包零运行时依赖。
 */

/** 会话标识：`ses_<时间戳><随机>`。 */
export type SessionId = string & { readonly __brand: "SessionId" };

/** 事件标识：`evt_<seq>`（会话内单调）。 */
export type EventId = string & { readonly __brand: "EventId" };

/** 工具调用标识：`call_<随机>`。 */
export type ToolCallId = string & { readonly __brand: "ToolCallId" };

/** 回合标识：`turn_<n>`。 */
export type TurnId = string & { readonly __brand: "TurnId" };
