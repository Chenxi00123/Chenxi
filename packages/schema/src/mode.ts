/**
 * 默认双模式（ADR-013）与权限判定结果（ADR-006）。
 *
 * ⚠️ 模式 -> 权限的**默认映射**属于配置层（`runtime/permission`），本文件只定义枚举契约。
 */

/** 默认启动模式为 `plan`（ADR-013）。 */
export type AgentMode = "plan" | "build";

export const DEFAULT_AGENT_MODE: AgentMode = "plan";

export const AGENT_MODES: readonly AgentMode[] = ["plan", "build"];

/**
 * 权限判定结果（三值）。
 * - `allow`：放行
 * - `deny`：拒绝，且模型收到可读错误后**不得重试**
 * - `ask`：需审批；在无审批通道时 **fail-closed -> deny**（ADR-007）
 */
export type PermissionDecision = "allow" | "deny" | "ask";

/** guard 只能否决、不可翻转（不变量 3）——guard 返回 `false` 即否决。 */
export type GuardVerdict = boolean;
