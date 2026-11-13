/**
 * 把权限判定挂进工具流水线（`beforeToolCall` 钩子，ADR-004 的横切能力，**不改主循环**）。
 *
 * - 判定结果 `deny` → 阻断，并把**可读理由**回灌模型（判据 #2：模型收到可读错误）；
 * - 判定结果 `ask` → 无审批通道时 **fail-closed 转 deny**（ADR-007），有通道则向用户确认；
 * - 每次判定经 `record` 落 `permission/decision` 事件（**可审计**）。
 */
import type {
	AgentMode,
	PermissionDecisionPayload,
	PermissionRequest,
	PermissionVerdict,
} from "@aster/schema";
import type { BeforeToolCallBlock, BeforeToolCallHook } from "../tools/execute.js";
import type { PermissionSystem } from "./types.js";

export interface CreatePermissionHookOptions {
	readonly system: PermissionSystem;
	/**
	 * 审批通道：返回 true 表示批准。缺省 = **无审批通道**（ADR-007 fail-closed）。
	 * v0.2 会由 waterfall 中间件提供可交互确认流。
	 */
	readonly approve?: (
		request: PermissionRequest,
		verdict: PermissionVerdict,
	) => Promise<boolean> | boolean;
	/** 记录判定事件（落 `permission/decision`）。缺省不记录（纯单元测试用）。 */
	readonly record?: (payload: PermissionDecisionPayload) => Promise<void> | void;
}

/** 构造 `beforeToolCall` 钩子；`context.mode` 为**当次调用的模式**（ADR-013：每请求对账）。 */
export function createPermissionHook(options: CreatePermissionHookOptions): BeforeToolCallHook {
	return async (params): Promise<BeforeToolCallBlock | void> => {
		const request: PermissionRequest = {
			metadata: params.tool.metadata,
			resolvedInput: params.resolvedInput,
			mode: params.context.mode as AgentMode,
			cwd: params.context.cwd,
		};

		const verdict = options.system.decide(request);

		let effective: PermissionVerdict = verdict;
		if (verdict.decision === "ask") {
			if (options.approve === undefined) {
				// ADR-007：内置 fail-closed——无审批通道时 ask -> deny
				effective = {
					decision: "deny",
					reason: `${verdict.reason}; no approval channel is configured, so this call is denied (fail-closed)`,
					...(verdict.deniedBy === undefined ? {} : { deniedBy: verdict.deniedBy }),
				};
			} else {
				const approved = await options.approve(request, verdict);
				effective = approved
					? { decision: "allow", reason: `${verdict.reason}; approved by user` }
					: { decision: "deny", reason: `${verdict.reason}; rejected by user` };
			}
		}

		if (options.record !== undefined) {
			await options.record({
				callId: params.context.callId,
				toolName: params.tool.metadata.name,
				decision: effective.decision,
				reason: effective.reason,
				...(effective.deniedBy === undefined ? {} : { deniedBy: effective.deniedBy }),
			});
		}

		if (effective.decision === "allow") return;

		return {
			block: true,
			code: "permission_denied",
			retryable: false,
			reason: `${effective.reason} Do not retry this exact call.`,
		};
	};
}
