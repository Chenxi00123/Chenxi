/**
 * 权限判定（ADR-006 / ADR-013）。
 *
 * 判定链（固定）：
 *   1. 按模式取规则集，**首条命中即为基础判定**；无规则命中 → `deny`（fail-closed）；
 *   2. 依次跑**单调 guard**：任一 guard 返回 `false` → 强制 `deny`（guard 永远只降级、不放行）；
 *   3. 返回 `allow / deny / ask`（`ask` 的 fail-closed 转换在 `hook.ts` 完成，因为需要知道有无审批通道）。
 */
import type { AgentMode, PermissionRequest, PermissionVerdict } from "@aster/schema";
import type { Context, Disposer } from "../events/index.js";
import { resolveCallScope } from "./scope.js";
import type {
	CallScope,
	ModePolicy,
	NamedGuard,
	PermissionGuard,
	PermissionRule,
	PermissionSystem,
} from "./types.js";

/** 默认双模式策略（ADR-013，**默认配置，可被覆盖**）。 */
export const DEFAULT_MODE_POLICY: ModePolicy = {
	// plan：只读/非破坏性；对 edit/write/bash 等一律 deny
	plan: [
		{
			tool: "*",
			readOnly: true,
			decision: "allow",
			reason: "plan mode allows read-only / non-destructive tools",
		},
		{
			tool: "*",
			decision: "deny",
			reason:
				"PLAN mode denies write / destructive tools. Do not retry this call; " +
				"switch to BUILD mode (e.g. `/mode build`) if a write is intended.",
		},
	],
	// build：workspace 内写放行；workspace 外 ask（无审批通道时 fail-closed -> deny）
	build: [
		{
			tool: "*",
			readOnly: true,
			decision: "allow",
			reason: "read-only / non-destructive tools are always allowed",
		},
		{
			tool: "*",
			scope: "workspace",
			decision: "allow",
			reason: "BUILD mode allows writes inside the workspace",
		},
		{
			tool: "*",
			scope: "outside",
			decision: "ask",
			reason: "writing OUTSIDE the workspace requires approval",
		},
	],
};

/**
 * 用配置覆盖项合成完整 `ModePolicy`（ADR-014）。
 *
 * **只替换显式提供的模式**，未提供的模式保持内置默认
 * （避免"只配了 build 就把 plan 配空"这类静默副作用）。
 */
export function resolveModePolicy(
	overrides?: Partial<Record<AgentMode, readonly PermissionRule[]>>,
	base: ModePolicy = DEFAULT_MODE_POLICY,
): ModePolicy {
	if (overrides === undefined) return base;
	return {
		plan: overrides.plan ?? base.plan,
		build: overrides.build ?? base.build,
	};
}

interface MatchContext {
	readonly toolName: string;
	readonly readOnly: boolean;
	readonly scope: CallScope;
}

function matches(rule: PermissionRule, ctx: MatchContext): boolean {
	if (rule.tool !== "*" && rule.tool !== ctx.toolName) return false;
	if (rule.readOnly !== undefined && rule.readOnly !== ctx.readOnly) return false;
	if (rule.scope !== undefined && rule.scope !== ctx.scope) return false;
	return true;
}

export interface CreatePermissionSystemOptions {
	/** 覆盖默认策略（ADR-013：模式 → 权限是配置，可被覆盖）。 */
	readonly policy?: ModePolicy;
	/** 事件上下文；提供时 guard 生命周期纳入 `ctx.effect()`。 */
	readonly ctx?: Context;
}

export function createPermissionSystem(
	options: CreatePermissionSystemOptions = {},
): PermissionSystem {
	const policy = options.policy ?? DEFAULT_MODE_POLICY;
	const guards: NamedGuard[] = [];

	const decide = (request: PermissionRequest): PermissionVerdict => {
		const scope = resolveCallScope(request);
		const match: MatchContext = {
			toolName: request.metadata.name,
			readOnly: request.metadata.readOnly,
			scope,
		};

		let verdict: PermissionVerdict;
		const rule = policy[request.mode].find((candidate) => matches(candidate, match));
		if (rule === undefined) {
			// fail-closed：没有规则命中即拒绝
			verdict = {
				decision: "deny",
				reason: `no ${request.mode}-mode policy rule matched tool "${request.metadata.name}"; denied by default`,
				deniedBy: "default",
			};
		} else {
			verdict = { decision: rule.decision, reason: rule.reason };
		}

		// 单调 guard：只能否决（不变量 3）
		for (const entry of guards) {
			const allowed = entry.guard(request);
			if (allowed === false) {
				verdict = {
					decision: "deny",
					reason: `denied by guard "${entry.name}"`,
					deniedBy: entry.name,
				};
				break;
			}
		}

		return verdict;
	};

	const addGuard = (name: string, guard: PermissionGuard): Disposer => {
		guards.push({ name, guard });
		const dispose = () => {
			const index = guards.findIndex((entry) => entry.name === name && entry.guard === guard);
			if (index >= 0) guards.splice(index, 1);
		};
		if (options.ctx !== undefined) {
			return options.ctx.effect(() => dispose);
		}
		return dispose;
	};

	return {
		decide,
		addGuard,
		guards: () => [...guards],
		policy: () => policy,
	};
}
