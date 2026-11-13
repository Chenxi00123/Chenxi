/**
 * 富文本（ADR-026）：**流式文本通道**的极简 markdown 呈现 + 工具结果载荷 → 行。
 *
 * 边界（务必看清，别把它当成"又一轮文本启发式"）：
 *  - **只影响呈现，不产生事实**：它只把**已收全的文本行**画得更有层次；
 *  - **只作用于文本通道**：会话事实仍由 `tui/events.ts` 的 `describeEvent` 结构化映射（本文件一字未改那条路）；
 *  - **未命中任何构造的行回落 `formatLine`** ⇒ 横幅 / 命令输出照旧上色；
 *  - **纯函数**：围栏状态由调用方（`transcript`）持有并回填，因此可逐行断言。
 *
 * 支持的 markdown 子集**刻意收窄为"行内可判定"**：标题 / 无序列表 / 有序列表 / 围栏代码 / 行内代码。
 * 显式不做：表格、引用块、嵌套列表、脚注、软换行（超宽行仍由 `truncateToWidth` 按列截断）。
 */
import { formatLine } from "./format.js";
import type { Theme } from "./theme.js";

/** 富文本的**视图状态**（当前是否在围栏代码里）。它**不进 JSONL**——折叠 / 围栏都只是视图。 */
export interface RichTextState {
	readonly fenced: boolean;
}

export const INITIAL_RICH_TEXT: RichTextState = { fenced: false };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\d{1,3})[.)]\s+(.*)$/;
const FENCE_RE = /^```\s*([A-Za-z0-9_+#-]*)\s*$/;

/** 列表符号（无序列表统一成它，避免 `-` / `*` / `+` 三种画法混杂）。 */
const BULLET = "•";
/** 代码框的竖线（Box Drawing，占 1 显示列）。 */
const RAIL = "│";

/** 行内代码（成对反引号）→ tool 色；不配对时原样（**不做**跨行推断）。 */
export function withInlineCode(text: string, theme: Theme): string {
	if (!text.includes("`")) return text;
	return text
		.split("`")
		.map((part, index) => (index % 2 === 1 ? theme.paint("tool", part) : part))
		.join("");
}

/** 代码框的边线（左角 + 标签）。宽度由终端截断负责，这里不做"满框"（列宽未知）。 */
function boxTop(label: string, theme: Theme): string {
	return theme.paint("muted", `┌─ ${label}`);
}

/** 渲染一行；返回渲染结果与**新的**围栏状态（调用方负责保存）。 */
export function renderRichLine(
	line: string,
	state: RichTextState,
	theme: Theme,
): { readonly rendered: string; readonly state: RichTextState } {
	const trimmed = line.trim();
	const fence = FENCE_RE.exec(trimmed);

	// 围栏内：除闭合行外一律加竖线（保持"一行进、一行出"的不变量）
	if (state.fenced) {
		if (trimmed.startsWith("```")) {
			return { rendered: theme.paint("muted", "└─"), state: INITIAL_RICH_TEXT };
		}
		return { rendered: `${theme.paint("muted", `${RAIL} `)}${line}`, state };
	}

	// 围栏开启
	if (fence !== null) {
		const label = (fence[1] ?? "").trim() === "" ? "code" : (fence[1] as string);
		return { rendered: boxTop(label, theme), state: { fenced: true } };
	}

	const heading = HEADING_RE.exec(line);
	if (heading !== null) {
		return {
			rendered: theme.bold(theme.paint("accent", withInlineCode(heading[2] ?? "", theme))),
			state,
		};
	}

	const bullet = BULLET_RE.exec(line);
	if (bullet !== null) {
		return { rendered: `  ${BULLET} ${withInlineCode(bullet[2] ?? "", theme)}`, state };
	}

	const ordered = ORDERED_RE.exec(line);
	if (ordered !== null) {
		return {
			rendered: `  ${theme.paint("accent", `${ordered[1]}.`)} ${withInlineCode(ordered[2] ?? "", theme)}`,
			state,
		};
	}

	// 未命中任何构造：回到"只配色"的既有职责（横幅 / 命令输出 / 普通正文）
	if (line.includes("`")) {
		return { rendered: withInlineCode(formatLine(line, theme), theme), state };
	}
	return { rendered: formatLine(line, theme), state };
}

/**
 * 工具结果载荷 → 可读行（ADR-026 的展开态要用）。
 * 规则：`undefined` / `null` → 空；字符串 → 按 `\n` 切；其余 → `JSON.stringify(…, null, 2)`。
 * **绝不抛**（不可序列化时给一行可读占位）。
 */
export function payloadLines(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return value.split("\n");
	try {
		return JSON.stringify(value, null, 2).split("\n");
	} catch {
		return ["<unserializable>"];
	}
}
