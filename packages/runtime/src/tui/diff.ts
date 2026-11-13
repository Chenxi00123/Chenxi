/**
 * 行级差分重绘（ADR-020）——「逐行比较只重绘变更区间」。
 *
 * 模型（**故意做得很小，以便断言**）：
 *  - 光标**恒停在最后一行的行首**（每帧结束时都会归一化到那里）；
 *  - 于是"从 `from` 重绘到 `to`、再清掉多余尾行、再把光标挪回末行"就够，**无变化一个字节都不写**；
 *  - 宽度变化 → 全量重绘（换行位置全变，差分无意义）；
 *  - 整帧包在**同步输出**（`ESC[?2026h` … `ESC[?2026l`）里，避免撕裂。
 *
 * `planDiff` 与 `renderFrame` 都是**纯函数**（不碰 IO），因此可被单测逐字节断言。
 */
import { ansi } from "./theme.js";

export interface FrameDiff {
	/** `none` = 与上一帧完全相同；`partial` = 只重绘 `from..to`；`full` = 全量重绘。 */
	readonly kind: "none" | "partial" | "full";
	readonly from: number;
	readonly to: number;
	readonly previousLength: number;
}

export const NO_DIFF: FrameDiff = { kind: "none", from: -1, to: -1, previousLength: 0 };

/** 比较两帧，算出差分（纯函数）。 */
export function planDiff(
	previous: readonly string[],
	next: readonly string[],
	widthChanged: boolean,
): FrameDiff {
	if (widthChanged && previous.length > 0) {
		return {
			kind: "full",
			from: 0,
			to: Math.max(0, next.length - 1),
			previousLength: previous.length,
		};
	}
	const max = Math.max(previous.length, next.length);
	let from = -1;
	let to = -1;
	for (let i = 0; i < max; i += 1) {
		const oldLine = i < previous.length ? (previous[i] as string) : "";
		const newLine = i < next.length ? (next[i] as string) : "";
		if (oldLine !== newLine) {
			if (from === -1) from = i;
			to = i;
		}
	}
	if (from === -1) return { ...NO_DIFF, previousLength: previous.length };
	return { kind: "partial", from, to, previousLength: previous.length };
}

export interface RenderFrameOptions {
	/**
	 * **光标所在行**（相对本帧行首）。缺省 = 末行（M10 单行输入的行为）。
	 * ADR-025 起输入区可以有多行，光标因此可能在**非末行**。
	 */
	readonly caretRow?: number;
	/** 输入框里的光标列（0 表示不移动；相对**光标所在行**行首）。 */
	readonly caretCol?: number;
	/**
	 * 上一帧结束时**光标停在那一行**（缺省 = 上一帧末行）。
	 * 差分的前提是"光标在一个已知位置"，多行输入区下这个位置不再总是末行。
	 */
	readonly previousCaretRow?: number;
}

/**
 * 帧**没有变化**但**光标动了**时的最小重绘（ADR-025）：
 * 只把光标从 `from` 挪到 `to`（同一帧内），不重画任何内容。
 * 返回空串表示"不需要动"。
 *
 * 为什么需要它：帧的文本里**不含**光标位置，因此"在一行内左右移动/Home/End"这类操作
 * 会让 `planDiff` 判定 `none`（一个字节都不写）——那样**光标就看不见动**了（M10 的潜在缺陷）。
 */
export function renderCaretMove(
	from: { readonly row: number; readonly column: number },
	to: { readonly row: number; readonly column: number },
): string {
	if (from.row === to.row && from.column === to.column) return "";
	const out: string[] = [ansi.beginSync, ansi.carriage];
	if (to.row < from.row) out.push(ansi.up(from.row - to.row));
	else if (to.row > from.row) out.push(ansi.down(to.row - from.row));
	out.push(ansi.right(to.column));
	out.push(ansi.endSync);
	return out.join("");
}

/**
 * 把帧渲染成**一段 ANSI**（纯函数）。
 * 前提：调用前光标位于上一帧的**末行行首**（首次渲染则在内容区起点）。
 */
export function renderFrame(
	diff: FrameDiff,
	next: readonly string[],
	options: RenderFrameOptions = {},
): string {
	if (diff.kind === "none") return "";
	const endRow = Math.max(0, next.length - 1);
	const out: string[] = [ansi.beginSync];

	if (diff.kind === "full") {
		out.push(ansi.clearScreen);
		for (const [index, line] of next.entries()) {
			if (index > 0) out.push("\r\n");
			out.push(line === "" ? "" : line);
		}
	} else {
		const lastPrev = diff.previousLength - 1;
		// 先把光标从"上一帧的落点"归位到上一帧的**末行行首**（差分的前提，ADR-025）
		const prevCaretRow = options.previousCaretRow ?? lastPrev;
		out.push(ansi.carriage);
		if (prevCaretRow < lastPrev) out.push(ansi.down(lastPrev - prevCaretRow));
		else if (prevCaretRow > lastPrev) out.push(ansi.up(prevCaretRow - lastPrev));
		out.push(ansi.carriage);
		if (diff.from > lastPrev) {
			// 新帧比旧帧长：往下走（首帧时为 0，避免一上来就滚屏）
			out.push(ansi.down(diff.previousLength === 0 ? 0 : diff.from - lastPrev));
		} else {
			out.push(ansi.up(lastPrev - diff.from));
		}
		// 只重绘 from..to（越界的行按"空行"处理，正好把被删的行清掉）
		for (let i = diff.from; i <= diff.to; i += 1) {
			if (i > diff.from) out.push("\r\n");
			out.push(ansi.eraseLine);
			out.push(i < next.length ? (next[i] as string) : "");
		}
	}

	// 把光标归一到**末行行首**（下一帧的前提），再上移到**光标所在行**、右移到光标列
	const currentRow = diff.kind === "full" ? Math.max(0, next.length - 1) : diff.to;
	if (currentRow > endRow) out.push(ansi.up(Math.min(currentRow, currentRow - endRow)));
	else if (currentRow < endRow) out.push(ansi.down(endRow - currentRow));
	out.push(ansi.carriage);
	const caretRow = Math.max(0, Math.min(options.caretRow ?? endRow, endRow));
	if (caretRow < endRow) out.push(ansi.up(endRow - caretRow));
	out.push(ansi.right(options.caretCol ?? 0));
	out.push(ansi.endSync);
	return out.join("");
}
