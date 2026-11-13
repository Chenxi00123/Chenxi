/**
 * 权限模块契约（ADR-006 / ADR-013）。
 *
 * - 判定**唯一事实源是工具元数据**（`readOnly / destructive / sideEffectScope / riskLevel / needsApproval`），
 *   **不看代码语义**（zcode 的做法）。
 * - `guard` **只能否决、不能放行**（单调）——列表次序无法把「拒绝」翻成「允许」（不变量 3）。
 * - 模式 → 权限是**默认配置**（可覆盖），切换模式发事件（ADR-013）。
 */
import type {
	AgentMode,
	GuardVerdict,
	PermissionDecision,
	PermissionRequest,
	PermissionVerdict,
} from "@aster/schema";
import type { Disposer } from "../events/index.js";

/** 调用目标范围：workspace 内 / 外。 */
export type CallScope = "workspace" | "outside";

/** 一条权限规则；按顺序匹配，**首条命中即生效**。 */
export interface PermissionRule {
	/** 工具名，或 `"*"` 通配。 */
	readonly tool: string | "*";
	/** 仅匹配只读/写类工具（缺省不限制）。 */
	readonly readOnly?: boolean;
	/** 仅匹配指定作用域（缺省不限制）。 */
	readonly scope?: CallScope;
	readonly decision: PermissionDecision;
	/** 面向模型/审计的**可读理由**。 */
	readonly reason: string;
}

/** 模式 → 规则集 的默认配置。 */
export type ModePolicy = Readonly<Record<AgentMode, readonly PermissionRule[]>>;

/**
 * 单调 guard：只能否决。返回 `false` 即否决；**返回 `true` 不构成放行**。
 */
export type PermissionGuard = (request: PermissionRequest) => GuardVerdict;

export interface NamedGuard {
	readonly name: string;
	readonly guard: PermissionGuard;
}

export interface PermissionSystem {
	/** 判定一次工具调用（含单调 guard）。 */
	decide(request: PermissionRequest): PermissionVerdict;
	/** 注册 guard（注册即 effect，可单独卸载）。 */
	addGuard(name: string, guard: PermissionGuard): Disposer;
	guards(): readonly NamedGuard[];
	policy(): ModePolicy;
}
