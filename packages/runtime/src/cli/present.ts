/**
 * 前端可复用的**呈现层纯函数**（从 `repl.ts` 拆出，见架构门禁的 400 行上限）。
 *
 * 这里只放"格式/文本"这类**纯**函数与**类型转出**；消费者是**非终端前端**
 * （桌面版只被允许 import `@chenxi/runtime` 根入口 ⇒ 经 `cli` 命名空间转出）：
 *  - `renderApprovalPrompt`：审批提问正文（**格式单一来源在 `permission` 模块**）；
 *  - `describePermissionRule`：`/policy` 的短标签（桌面版「策略」面板显示**同一段**文本）；
 *  - `formatHistory`：投影后的模型历史（`/history` 与 resume 横幅用）。
 */
import type { PermissionRule } from "../permission/index.js";
import { deriveMessages } from "../session/index.js";

export type {
	ApprovalChannel,
	ApprovalChoice,
	ApprovalPrompt,
	ApprovalRules,
} from "../permission/index.js";
export { renderApprovalPrompt } from "../permission/index.js";

/** 输出目标（与 `repl.ts` 的 `Output` 同形；本模块只依赖 `write`，故本地声明以免绕回去）。 */
export interface PresentOutput {
	write(text: string): void;
}

/** 打印投影后的模型历史（供 resume 时核对「退出前 == 退出后」）。 */
export function formatHistory(
	events: Parameters<typeof deriveMessages>[0],
	output: PresentOutput,
): void {
	const messages = deriveMessages(events);
	output.write(`history(${messages.length}):\n`);
	for (const message of messages) {
		output.write(`  [${message.role}] ${message.content}\n`);
	}
}

/**
 * 把一条权限规则压成短标签，供 `/policy` 展示（ADR-014：覆盖是否生效应当**看得见**）。
 * 桌面版的「策略」面板也用它 ⇒ 两端显示的是**同一段**文本（不各写一份、不漂移）。
 */
export function describePermissionRule(rule: PermissionRule): string {
	const conditions = [
		...(rule.readOnly === true ? ["readonly"] : []),
		...(rule.scope === undefined ? [] : [`scope=${rule.scope}`]),
	];
	return `${rule.tool}${conditions.length === 0 ? "" : `[${conditions.join(",")}]`}=${rule.decision}`;
}
