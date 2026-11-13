/**
 * 深色极简主题（ADR-020）。
 *
 * 纪律：
 *  - **语义 token，不是"每个地方一个颜色"**（Pi 的 `docs/tui.md` 同款要求）：只有 accent / muted /
 *    ok / warn / err / tool / user 六类；**不设背景色**（让终端自己的底透上来），单一强调色；
 *  - **可关闭**：`NO_COLOR`（业界约定）或 `--no-color` → 一律不上色（无障碍 + 让渲染可被测试断言）；
 *  - **能力自适应**：`COLORTERM=truecolor|24bit` → 24 位色，否则退到 256 色。
 *
 * 配色取"低饱和、深色背景可读"的一组（用户偏好深色极简人文风）：
 * accent = 柔和蓝、tool = 柔和紫、ok = 柔和绿、warn = 柔和琥珀、err = 柔和玫红、muted = 灰。
 */
export type ThemeToken = "accent" | "muted" | "ok" | "warn" | "err" | "tool" | "user";

interface ColorPair {
	/** 24 位色（r,g,b）。 */
	readonly rgb: readonly [number, number, number];
	/** 256 色近似（终端的色卡索引）。 */
	readonly idx: number;
}

const COLORS: Record<ThemeToken, ColorPair> = {
	accent: { rgb: [122, 162, 247], idx: 111 },
	tool: { rgb: [187, 154, 247], idx: 141 },
	ok: { rgb: [158, 206, 106], idx: 149 },
	warn: { rgb: [224, 175, 104], idx: 179 },
	err: { rgb: [247, 118, 142], idx: 203 },
	muted: { rgb: [138, 145, 155], idx: 245 },
	user: { rgb: [122, 162, 247], idx: 111 },
};

export const RESET = "\u001b[0m";

export interface Theme {
	/** 是否上色（false 时所有 paint 都是恒等，便于测试与 `NO_COLOR`）。 */
	readonly colored: boolean;
	/** 某个 token 的前景色 SGR（未上色时为空串）。 */
	fg(token: ThemeToken): string;
	/** 上色（未上色时原样返回）。 */
	paint(token: ThemeToken, text: string): string;
	/** 加粗（未上色时原样返回）。 */
	bold(text: string): string;
}

export interface ThemeOptions {
	/** 显式关闭（`--no-color`）。 */
	readonly disabled?: boolean;
	/** 终端的 `COLORTERM`（测试可注入；缺省读环境变量）。 */
	readonly colorTerm?: string;
	/** `NO_COLOR` 是否生效（缺省读环境变量）。 */
	readonly noColor?: boolean;
}

/** 创建一个主题；`colored=false` 时全部退化为恒等变换。 */
export function createTheme(options: ThemeOptions = {}): Theme {
	const noColor = options.noColor ?? process.env.NO_COLOR !== undefined;
	const colorTerm = options.colorTerm ?? process.env.COLORTERM;
	const colored = options.disabled !== true && !noColor;
	const truecolor = colorTerm === "truecolor" || colorTerm === "24bit";

	const fg = (token: ThemeToken): string => {
		if (!colored) return "";
		const color = COLORS[token];
		return truecolor
			? `\u001b[38;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}m`
			: `\u001b[38;5;${color.idx}m`;
	};

	return {
		colored,
		fg,
		paint: (token, text) => (colored ? `${fg(token)}${text}${RESET}` : text),
		bold: (text) => (colored ? `\u001b[1m${text}\u001b[22m` : text),
	};
}

/** 光标移动/清行等同质工具（与主题无关，集中在这里免得散落在各处）。 */
export const ansi = {
	/** 隐藏 / 显示硬件光标（本实现**显示**光标：中文 IME 候选框要跟着它走）。 */
	showCursor: "\u001b[?25h",
	/**
	 * 开启鼠标上报（ADR-024）：`?1000h` = 只报**点击与滚轮**（不带拖拽跟踪 `?1002/?1003`），
	 * `?1006h` = SGR 扩展坐标（大终端也能用）。
	 *
	 * ⚠️ **不启用 `?1002/?1003`（拖拽跟踪）是有意的**：一旦跟踪拖拽，终端就不再做
	 * **原生选中复制**；只报点击/滚轮时，拖拽仍由终端自己处理（多数终端还留 `Shift` 作旁路）。
	 */
	enableMouse: "\u001b[?1000h\u001b[?1006h",
	disableMouse: "\u001b[?1000l\u001b[?1006l",
	/**
	 * 括号粘贴（ADR-025）：开启后终端会把粘贴内容用 `ESC[200~ … ESC[201~` 包起来，
	 * 因此**粘贴多行不会被当成一串回车逐行提交**。退出前必须关掉（成对）。
	 */
	enablePaste: "\u001b[?2004h",
	disablePaste: "\u001b[?2004l",
	/** 同步输出包裹：整帧一次提交，避免撕裂（Windows Terminal 支持）。 */
	beginSync: "\u001b[?2026h",
	endSync: "\u001b[?2026l",
	/** 回到行首 + 清除整行 + 清除到行尾。 */
	carriage: "\r",
	eraseLine: "\u001b[2K",
	/** 清屏并回到原点（**不清 scrollback**，`\x1b[3J` 会连回滚缓冲一起清掉）。 */
	clearScreen: "\u001b[2J\u001b[H",
	up: (rows: number): string => (rows > 0 ? `\u001b[${rows}A` : ""),
	down: (rows: number): string => (rows > 0 ? `\u001b[${rows}B` : ""),
	right: (cols: number): string => (cols > 0 ? `\u001b[${cols}C` : ""),
} as const;
