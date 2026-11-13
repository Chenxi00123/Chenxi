/**
 * acp 模块门面（ADR-036）：agent 侧最小 ACP 通道（initialize / session/new / prompt / cancel）。
 * ⚠️ **未与真实 ACP 客户端对测**；审批通道缺席 ⇒ `ask` 一律 fail-closed deny。
 */
export * from "./protocol.js";
export * from "./server.js";
