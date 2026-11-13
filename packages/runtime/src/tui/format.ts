/**
 * 把**非事实行**渲染成带语义色的屏幕行（ADR-020 / ADR-023）。
 *
 * 职责边界（ADR-023 收紧过一次，务必看清）：
 *  - **会话事实**（用户消息 / assistant 正文 / 工具轨迹 / 模式切换 / 记忆 / 审批 / 子代理）
 *    **不再**走这里——它们有**事件**，由 `tui/events.ts` 的 `describeEvent` 直接映射（结构化）；
 *  - 本文件只处理**没有事件**的那类行：横幅（`session:` / `format v` / `llm provider:` / …）、
 *    命令输出（`/history` `/policy` `/approvals`）、交互提示（审批提问 / `(exit)` / `(interrupting…)`）
 *    与**流式 assistant 正文**（增量本身不是事件，故保持终端默认前景）。
 *  因此它**只做配色，不决定语义**：一行是不是"事实"由事件流说了算，不是靠前缀猜。
 *
 * 纯函数：输入一行朴素文本 + 主题，输出一行带色文本（行内自闭合）。
 */
import type { Theme, ThemeToken } from "./theme.js";

/** 已知前缀 → 语义 token（顺序即优先级；未命中一律按**正文**处理）。 */
const PREFIX_RULES: readonly {
	readonly match: (line: string) => boolean;
	readonly token: ThemeToken;
}[] = [
	{
		match: (line) => line.startsWith("  [error]") || line.startsWith("  [model error]"),
		token: "err",
	},
	// `[assistant stopped: …]` / `[turn aborted]` / 审批提问头 `[approval required]` / `/history` 的 `[user] …`
	{ match: (line) => line.startsWith("  ["), token: "muted" },
	{ match: (line) => line.startsWith("  ! "), token: "warn" },
	{ match: (line) => line.startsWith("  (approval"), token: "muted" },
	{
		match: (line) => line.startsWith("  (interrupting") || line.startsWith("  (exit)"),
		token: "muted",
	},
	{ match: (line) => line.startsWith("  (waiting for"), token: "tool" },
	{
		match: (line) => line.startsWith("  approvals:") || line.startsWith("  policy"),
		token: "muted",
	},
];

/** 预热横幅（session/format/provider/config/…）统一压成 muted，不与正文抢注意力。 */
function isBannerLine(line: string): boolean {
	return (
		line.startsWith("session: ") ||
		line.startsWith("format v") ||
		line.startsWith("llm provider:") ||
		line.startsWith("config: ") ||
		line.startsWith("resumed with ") ||
		line.startsWith("history(") ||
		line.startsWith("mcp: ") ||
		line.startsWith("memory: ") ||
		line.startsWith("subagents: ") ||
		line.startsWith("sandbox: ") ||
		line.startsWith("no model endpoint")
	);
}

/** 渲染一行；返回**带重置码结尾**的字符串（避免颜色渗行）。 */
export function formatLine(line: string, theme: Theme): string {
	const rule = PREFIX_RULES.find((candidate) => candidate.match(line));
	if (rule !== undefined) return theme.paint(rule.token, line);
	if (isBannerLine(line)) return theme.paint("muted", line);
	return line; // 正文（模型输出）保持终端默认前景：深色极简里正文最该"沉"
}
