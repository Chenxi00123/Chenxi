/**
 * 审批流（M6）：把 `ask` 从「无通道即 fail-closed 拒绝」升级为**可交互确认**。
 *
 * 关键语义辨析（与 ADR-006 不冲突）：
 * - **guard 只能否决**（单调）——这是权限**判定**层的不变量；
 * - **审批**是「用户对本次调用的授权」，属**判定之外**的输入：用户批准不改变 guard 的否决权。
 *   因此 `always`（本会话内始终允许）实现为**审批规则**（approval rules），**不是** guard，也**不是**改策略。
 * - 任何情况下 `reject` → deny；解析失败 → deny（fail-closed）。
 */
import type { PermissionRequest, PermissionVerdict } from "@chenxi/schema";
import { resolveCallScope } from "./scope.js";
import type { CallScope } from "./types.js";

/** 用户对一次审批的三种选择。 */
export type ApprovalChoice = "once" | "always" | "reject";

/** 审批规则的键：工具名 + 作用域（避免「一次批准 write@workspace」被泛化到 host）。 */
export interface ApprovalKey {
	readonly toolName: string;
	readonly scope: CallScope;
}

/** 本会话内的审批规则（`always` 沉淀于此；进程内、不落盘）。 */
export interface ApprovalRules {
	allow(key: ApprovalKey): void;
	isAllowed(key: ApprovalKey): boolean;
	list(): readonly ApprovalKey[];
	clear(): void;
}

function keyString(key: ApprovalKey): string {
	return `${key.toolName}@${key.scope}`;
}

export function createApprovalRules(): ApprovalRules {
	const allowed = new Set<string>();
	return {
		allow: (key) => void allowed.add(keyString(key)),
		isAllowed: (key) => allowed.has(keyString(key)),
		list: () =>
			[...allowed].map((raw) => {
				const at = raw.lastIndexOf("@");
				return { toolName: raw.slice(0, at), scope: raw.slice(at + 1) as CallScope };
			}),
		clear: () => allowed.clear(),
	};
}

/** 审批请求的上下文（用于渲染给用户看的提示）。 */
export interface ApprovalPrompt {
	readonly request: PermissionRequest;
	readonly verdict: PermissionVerdict;
	readonly scope: CallScope;
}

/** 审批通道：向用户征询。返回选择；抛错或返回非法值一律按 `reject`（fail-closed）。 */
export type ApprovalChannel = (prompt: ApprovalPrompt) => Promise<ApprovalChoice> | ApprovalChoice;

export interface CreateInteractiveApprovalOptions {
	/** 提问并取回一行答案（CLI 用 readline；测试用桩）。 */
	readonly ask: (question: string) => Promise<string>;
	/**
	 * 结构化审批通道（ADR-029 增补，M13b）：非终端前端（桌面版）直接给出三档选择。
	 * **缺省时**由 `ask` + `parseApprovalAnswer` 组成（既有 CLI/TUI 行为逐字节不变）。
	 */
	readonly channel?: ApprovalChannel;
	/** 规则存储（`always` 写入此处）。缺省新建。 */
	readonly rules?: ApprovalRules;
}

/** 把一行答案解析为三种选择；无法识别 -> `reject`（fail-closed）。 */
export function parseApprovalAnswer(answer: string): ApprovalChoice {
	switch (answer.trim().toLowerCase()) {
		case "y":
		case "yes":
		case "1":
		case "是":
		case "允许":
			return "once";
		case "a":
		case "always":
		case "2":
		case "总是":
		case "始终":
			return "always";
		default:
			return "reject";
	}
}

/** 渲染审批提示（**只显示入参摘要，绝不显示密钥**）。 */
export function renderApprovalPrompt(prompt: ApprovalPrompt): string {
	const { request, verdict, scope } = prompt;
	const input = JSON.stringify(request.resolvedInput ?? null);
	const preview = input.length > 240 ? `${input.slice(0, 240)}…` : input;
	return [
		"",
		`  [approval required] ${request.metadata.name} (scope: ${scope}, mode: ${request.mode})`,
		`    reason: ${verdict.reason}`,
		`    input : ${preview}`,
		"    allow? [y] once / [a] always (this session) / [n] reject > ",
	].join("\n");
}

export function createInteractiveApproval(
	options: CreateInteractiveApprovalOptions,
): ApprovalChannel {
	return async (prompt) => {
		const answer = await options.ask(renderApprovalPrompt(prompt));
		return parseApprovalAnswer(answer);
	};
}

/** 解析出"实际使用的通道"：显式 `channel` 优先，否则由 `ask` 组成（两者语义一致）。 */
function resolveApprovalChannel(options: CreateInteractiveApprovalOptions): ApprovalChannel {
	if (options.channel !== undefined) return options.channel;
	return createInteractiveApproval({ ask: options.ask });
}

/**
 * 审批闸门：把它交给 `createPermissionHook` 的 `approve` 参数。
 * - 已有 `always` 规则（同工具 + 同作用域）→ 直接批准；
 * - 否则询问通道；选 `always` 时写入规则并批准。
 */
export function createApprovalGate(options: CreateInteractiveApprovalOptions): {
	readonly approve: (request: PermissionRequest, verdict: PermissionVerdict) => Promise<boolean>;
	readonly rules: ApprovalRules;
} {
	const rules = options.rules ?? createApprovalRules();
	// 通道二选一：显式结构化通道（桌面版）或"下一行输入即答案"的朴素通道（CLI/TUI）——语义一致
	const channel = resolveApprovalChannel(options);
	return {
		rules,
		approve: async (request, verdict) => {
			// 作用域与判定层保持同一套判定（scope.ts），避免两处漂移
			const resolvedScope: CallScope = resolveCallScope(request);
			const key: ApprovalKey = { toolName: request.metadata.name, scope: resolvedScope };
			if (rules.isAllowed(key)) return true;
			const choice = await channel({ request, verdict, scope: resolvedScope });
			if (choice === "always") {
				rules.allow(key);
				return true;
			}
			return choice === "once";
		},
	};
}
