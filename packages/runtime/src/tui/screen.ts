/**
 * 屏幕模型与渲染（ADR-020）。
 *
 * 布局（**全屏 + 差分**，动作片式地克制）：
 *
 * ```
 *   row 0           状态条：chenxi · 模式徽标 · cwd · 模型 · 会话 id      （accent + muted）
 *   row 1           细分隔线（muted）
 *   row 2..k        会话视图：**下对齐**的尾部窗口，可滚动（PageUp/PageDown）
 *   row k+1..rows-1 输入区：**1..MAX_INPUT_ROWS 行**（ADR-025：多行草稿；首行 `› `，续行同宽缩进）
 * ```
 *
 * 关键不变量：
 *  - `compose()` 产出的帧**永远恰好 `rows` 行**（顶部补空行）→ 差分恒成立；
 *  - `compose()` 是**纯函数**（给定状态与尺寸），因此布局/裁剪/配色都能被单测逐行断言；
 *  - 每行的颜色都**在行内自闭合**（结尾带重置），避免颜色渗到下一行（Pi 同款纪律）；
 *  - **输入区高度 = 实际需要行数**（单行输入时与 M10 完全一致：只占 1 行）。
 */

import { planDiff, renderCaretMove, renderFrame } from "./diff.js";
import { layoutEditor, MAX_INPUT_ROWS } from "./editor.js";
import { ansi, type Theme } from "./theme.js";
import { truncateToWidth, visibleWidth } from "./width.js";

/** 状态条要展示的会话事实（都是"已有的事实"，不额外推算）。 */
export interface StatusFacts {
	readonly mode: string;
	readonly cwd: string;
	readonly model?: string;
	readonly sessionId: string;
	/** 在跑的 background 子代理数（>0 时显示，ADR-018）。 */
	readonly backgroundTasks?: number;
	/**
	 * 回合内指示（ADR-026）：**本地测量**的忙碌事实（`elapsedMs` 来自本机时钟，
	 * 故显示成 `◐ 1.3s (local)`——`(local)` 明示它不是事件里的字段）。
	 */
	readonly busy?: { readonly glyph: string; readonly elapsedMs: number };
}

export interface ScreenState {
	readonly status: StatusFacts;
	/** 会话文本行（已按 `\n` 切分；只增不改）。 */
	readonly transcript: readonly string[];
	readonly input: string;
	/** 输入文本里的插入点（**字符**下标，非显示列）。 */
	readonly caret: number;
	/** 从底部往上滚动的行数（0 = 贴底）。 */
	readonly scrollOffset: number;
}

export interface Sink {
	write(text: string): void;
}

export interface Screen {
	readonly state: ScreenState;
	update(patch: Partial<ScreenState>): void;
	/** 合帧：把多次 update 合并到下一个 16ms 窗口再画（流式增量不再逐 token 全屏重绘）。 */
	requestRender(): void;
	/** 立刻画（输入回显、回车等"必须跟手"的时刻）。 */
	flush(): void;
	/** 当前帧（供测试断言布局）。 */
	frame(columns: number, rows: number): string[];
}

/** 输入行前缀（写死 2 列：`› `）。 */
export const PROMPT_PREFIX = "› ";
/** 前缀占用的**显示列数**（点击定位插入点时要用它换算）。 */
export const PROMPT_WIDTH = 2;
/** 状态条与视图之间的分隔线。 */
const RULE = "─";
/** 光标移动的按下限。 */
const MIN_RENDER_INTERVAL_MS = 16;

/** 状态条：`chenxi` 徽标 + 模式 + **忙碌指示（本地测量）** + cwd + 模型 + 会话 id（越靠后越弱化）。 */
function composeStatus(facts: StatusFacts, columns: number, theme: Theme): string {
	const parts: string[] = [theme.bold(theme.paint("accent", "chenxi"))];
	parts.push(theme.paint("ok", facts.mode));
	// 忙碌指示紧跟模式：它在**窄终端**里也要活下来（cwd / 模型名比它长得多，排在它后面才不会被先截掉）
	if (facts.busy !== undefined) {
		// `(local)`：这个秒数来自**本机时钟**，不是事件里的字段（ADR-026）
		const seconds = (facts.busy.elapsedMs / 1000).toFixed(1);
		parts.push(theme.paint("warn", `${facts.busy.glyph} ${seconds}s (local)`));
	}
	parts.push(theme.paint("muted", facts.cwd));
	if (facts.model !== undefined) parts.push(theme.paint("muted", facts.model));
	if (facts.backgroundTasks !== undefined && facts.backgroundTasks > 0) {
		parts.push(theme.paint("tool", `${facts.backgroundTasks} background`));
	}
	const left = parts.join(theme.paint("muted", " · "));
	const right = theme.paint("muted", facts.sessionId);
	const gap = columns - visibleWidth(left) - visibleWidth(right) - 1;
	if (gap < 1) return truncateToWidth(left, columns);
	return `${left}${" ".repeat(gap)}${right}`;
}

/**
 * 输入区在当前尺寸下**最多**能占几行（`compose` / `caretPosition` / 点击定位共用**同一公式**）。
 */
export function maxInputRows(rows: number): number {
	const headerHeight = rows >= 4 ? 2 : 0;
	return Math.max(1, Math.min(MAX_INPUT_ROWS, rows - headerHeight));
}

/**
 * 组装一帧（纯函数）。**恰好 `rows` 行**：
 * 顶部空行补齐（视图下对齐），保证差分恒成立。输入区高度 = 草稿实际需要的行数（≥1）。
 */
export function compose(state: ScreenState, columns: number, rows: number, theme: Theme): string[] {
	if (rows <= 0) return [];
	const header =
		rows >= 4
			? [composeStatus(state.status, columns, theme), theme.paint("muted", RULE.repeat(columns))]
			: [];
	// 输入区最多占 `maxInputRows(rows)` 行，窗口**跟随光标**（ADR-025）
	const editor = layoutEditor(state.input, state.caret, { maxRows: maxInputRows(rows) });
	const inputRows = editor.lines.length;
	const viewportHeight = Math.max(0, rows - header.length - inputRows);

	// 视图：取**尾部窗口**（可向上滚动 scrollOffset 行），底部对齐，顶部补空行
	const end = Math.max(0, state.transcript.length - state.scrollOffset);
	const start = Math.max(0, end - viewportHeight);
	const visible = state.transcript.slice(start, end).map((line) => truncateToWidth(line, columns));
	const pad = viewportHeight - visible.length;
	const viewport = [...Array.from({ length: Math.max(0, pad) }, () => ""), ...visible];

	// 输入区：首行带 `› ` 前缀，续行用**同宽空格**缩进（视觉上是一块草稿）
	const available = Math.max(0, columns - PROMPT_WIDTH);
	const inputArea = editor.lines.map((line, index) => {
		const prefix = index === 0 ? theme.paint("accent", PROMPT_PREFIX) : " ".repeat(PROMPT_WIDTH);
		return `${prefix}${truncateToWidth(line, available)}`;
	});

	const frame = [...header, ...viewport, ...inputArea];
	// 兜底：补齐/裁剪到恰好 rows 行（万一分隔线在 columns 极小时被截断）
	while (frame.length < rows) frame.push("");
	return frame.slice(0, rows);
}

/**
 * 光标在帧里的位置（行 / 列）。列是**显示列**；行由输入区窗口决定（ADR-025）。
 * 与 `compose()` 共用同一套窗口算法，因此"画在哪"与"光标停在哪"永远一致。
 */
export function caretPosition(
	state: ScreenState,
	columns: number,
	rows: number,
): { readonly row: number; readonly column: number } {
	const editor = layoutEditor(state.input, state.caret, { maxRows: maxInputRows(rows) });
	const available = Math.max(0, columns - PROMPT_WIDTH);
	return {
		row: rows - editor.lines.length + editor.row,
		column: PROMPT_WIDTH + Math.min(editor.column, available),
	};
}

/**
 * 屏幕行 → **转录行下标**（ADR-026：点击折叠要用它定位）。
 * 与 `compose()` / `caretPosition()` **共用同一套窗口算法**（`maxInputRows`），
 * 因此"画在哪一行"与"点哪一行就命中哪一行"永远一致。
 *
 * 落在状态条 / 顶部补空行 / 输入区 → 返回 `undefined`（**不猜**）。
 */
export function transcriptIndexAt(
	state: ScreenState,
	rows: number,
	screenRow: number,
): number | undefined {
	if (rows <= 0) return undefined;
	const headerHeight = rows >= 4 ? 2 : 0;
	const editor = layoutEditor(state.input, state.caret, { maxRows: maxInputRows(rows) });
	const viewportHeight = Math.max(0, rows - headerHeight - editor.lines.length);
	const end = Math.max(0, state.transcript.length - state.scrollOffset);
	const start = Math.max(0, end - viewportHeight);
	const pad = Math.max(0, viewportHeight - (end - start));
	const offset = screenRow - headerHeight - pad;
	if (offset < 0) return undefined;
	const index = start + offset;
	return index < end ? index : undefined;
}

export function createScreen(options: {
	readonly sink: Sink;
	readonly theme: Theme;
	readonly initial: ScreenState;
	/** 尺寸来源（测试可注入固定尺寸；缺省读 `process.stdout`）。 */
	readonly size: () => { readonly columns: number; readonly rows: number };
	/** 合帧节流窗口（缺省 16ms；测试可注入 0 以同步渲染）。 */
	readonly intervalMs?: number;
}): Screen {
	let state: ScreenState = options.initial;
	let previousFrame: string[] = [];
	let previousColumns = 0;
	/** 上一帧结束时**光标停在哪**（行 / 列）——差分与"只挪光标"都要用到（ADR-025）。 */
	let previousCaret = { row: 0, column: 0 };
	let timer: ReturnType<typeof setTimeout> | null = null;
	const intervalMs = options.intervalMs ?? MIN_RENDER_INTERVAL_MS;

	const paint = (): void => {
		timer = null;
		const { columns, rows } = options.size();
		const next = compose(state, columns, rows, options.theme);
		const diff = planDiff(
			previousFrame,
			next,
			previousColumns !== 0 && previousColumns !== columns,
		);
		const caret = caretPosition(state, columns, rows);
		const text = renderFrame(diff, next, {
			caretRow: caret.row,
			caretCol: caret.column,
			previousCaretRow: previousCaret.row,
		});
		if (text !== "") {
			options.sink.write(text);
		} else if (previousCaret.row !== caret.row || previousCaret.column !== caret.column) {
			// 帧没变但**光标动了**：只把光标挪过去（否则左右移动/Home/End 会"看不见光标动"）
			options.sink.write(renderCaretMove(previousCaret, caret));
		}
		previousFrame = next;
		previousColumns = columns;
		previousCaret = caret;
	};

	return {
		get state() {
			return state;
		},
		update(patch) {
			state = { ...state, ...patch };
		},
		requestRender() {
			if (timer !== null) return; // 已在本窗口内：合并到同一帧
			timer = setTimeout(paint, intervalMs);
		},
		flush() {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			paint();
		},
		frame: (columns, rows) => compose(state, columns, rows, options.theme),
		/** 内部：本帧是否与上一帧完全相同（测试用来验证"无变化不写字节"）。 */
	};
}

/** 会话文本追加：按 `\n` 切分；**末尾未闭合的那段**由调用方决定是否当作"正在流式的一行"。 */
export function appendText(transcript: readonly string[], text: string): string[] {
	const lines = text.split("\n");
	const next = [...transcript];
	next[next.length - 1] = `${next[next.length - 1] ?? ""}${lines[0] ?? ""}`;
	for (const line of lines.slice(1)) next.push(line);
	return next;
}

/** 供测试与清理：ANSI 收尾能力（切到别的语句时把光标放回可见状态）。 */
export const exitSequence = `${ansi.endSync}`;
