/**
 * 多行编辑器（ADR-025）：**纯函数**的文本 / 光标几何。
 *
 * 三条明确边界：
 *  - **不做软换行**：一条逻辑行超宽时仍按显示列**截断**（与 M10 的单行输入一致）；
 *    理由：软换行会让"逻辑行 / 显示行"分离，牵动光标行号与差分重绘的面太大，**显式不做**（见 ADR-025）；
 *  - **光标用显示列**（东亚全角 = 2 列，组合字符 = 0 列），复用 `width.ts` 的判定；
 *  - **输入区窗口跟随光标**（光标永远在可见窗口内），窗口高度上限 `MAX_INPUT_ROWS`。
 */
import { visibleWidth } from "./width.js";

/** 输入区最多占几行（超过则在窗口内上滚，光标仍可见）。 */
export const MAX_INPUT_ROWS = 8;

export interface EditorLayout {
	/** 可见的逻辑行（已按窗口裁剪，**不含**提示前缀）。 */
	readonly lines: readonly string[];
	/** 光标所在的**可见行**下标。 */
	readonly row: number;
	/** 光标的**显示列**（相对行首，不含提示前缀）。 */
	readonly column: number;
	/** 窗口首行在全部逻辑行中的下标（点击定位要用它换算）。 */
	readonly firstVisible: number;
	/** 逻辑行总数。 */
	readonly total: number;
}

export interface CaretSpot {
	readonly line: number;
	readonly offset: number;
}

/**
 * 光标（**字符**下标）→ 它所在的逻辑行与该行内的**字符偏移**。
 * 行尾也算"在该行"（`caret === 行末`），因此换行符归属于**下一行**的起点。
 */
export function caretLineOf(lines: readonly string[], caret: number): CaretSpot {
	let remaining = Math.max(0, caret);
	for (const [index, line] of lines.entries()) {
		const length = [...line].length;
		if (remaining <= length) return { line: index, offset: remaining };
		remaining -= length + 1; // +1 是那个 `\n`
	}
	const last = Math.max(0, lines.length - 1);
	return { line: last, offset: [...(lines[last] ?? "")].length };
}

/** 每条逻辑行的**起始字符下标**（垂直移动 / 点击定位共用）。 */
export function lineStarts(lines: readonly string[]): number[] {
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += [...line].length + 1;
	}
	return starts;
}

/** 显示列 → 该行内的**字符下标**（点击定位用）。**只落在字符边界上**：
 *  - 列落在某个宽字符**内部** → 归到该字符的**左边界**（绝不把全角切一半，也不会莫名跳到右边）；
 *  - 列越过行尾 → 取行尾。 */
export function charIndexAtColumn(line: string, column: number): number {
	if (column <= 0) return 0;
	const chars = [...line];
	let width = 0;
	for (const [index, char] of chars.entries()) {
		const next = width + visibleWidth(char);
		if (column <= width) return index; // 落在该字符左边界（或之前）
		if (column < next) return index; // 落在该字符内部 → 归到左边界
		width = next;
	}
	return chars.length;
}

/** 算输入区的可见窗口（**跟随光标**：光标所在行永远在窗口内）。 */
export function layoutEditor(
	text: string,
	caret: number,
	options: { readonly maxRows: number },
): EditorLayout {
	const all = text.split("\n");
	const total = all.length;
	const { line, offset } = caretLineOf(all, caret);
	const maxRows = Math.max(1, Math.min(options.maxRows, total));
	const firstVisible = Math.min(Math.max(0, line - maxRows + 1), Math.max(0, total - maxRows));
	const lines = all.slice(firstVisible, firstVisible + maxRows);
	const column = visibleWidth((all[line] ?? "").slice(0, offset));
	return { lines, row: line - firstVisible, column, firstVisible, total };
}

/**
 * 垂直移动（↑/↓）：按**行内字符偏移**保持（简化：不记忆"目标显示列"，见 ADR-025）。
 * **越出缓冲区边界时返回 `undefined`** —— 调用方据此转成"翻历史"或"不动"。
 */
export function moveVertical(text: string, caret: number, direction: -1 | 1): number | undefined {
	const lines = text.split("\n");
	const { line, offset } = caretLineOf(lines, caret);
	const target = line + direction;
	if (target < 0 || target >= lines.length) return undefined;
	const starts = lineStarts(lines);
	return (starts[target] ?? 0) + Math.min(offset, [...(lines[target] ?? "")].length);
}
