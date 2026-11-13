/**
 * 终端**显示列宽**计算（ADR-020）。
 *
 * 为什么不能直接用 `String.length`：ANSI 转义序列不占列、东亚全角字符占 **2 列**、
 * 组合字符占 **0 列**。用错列宽就会在中文/emoji 处错位（Pi 的 `docs/tui.md` 明确要求
 * "Measure visible terminal columns rather than string length"）。
 *
 * 本实现是**零依赖的近似**（区间表 + 组合字符区间），覆盖常见 CJK / 全角 / emoji / 组合记号；
 * 不追求 Unicode 全表（那需要引入依赖），**已知局限**：区间表之外的少量码位按 1 列处理。
 */

/** 组合字符（占 0 列）：变音符号、零宽连接符等常见区间。 */
function isCombining(code: number): boolean {
	return (
		(code >= 0x0300 && code <= 0x036f) || // Combining Diacritical Marks
		(code >= 0x0483 && code <= 0x0489) ||
		(code >= 0x0591 && code <= 0x05bd) ||
		(code >= 0x0610 && code <= 0x061a) ||
		(code >= 0x064b && code <= 0x065f) ||
		(code >= 0x0e31 && code <= 0x0e3a) ||
		(code >= 0x0f71 && code <= 0x0f7e) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0x200b && code <= 0x200f) || // ZWSP / ZWNJ / ZWJ / LRM / RLM
		(code >= 0x20d0 && code <= 0x20f0) ||
		(code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
		(code >= 0xfe20 && code <= 0xfe2f) ||
		(code >= 0x1f3fb && code <= 0x1f3ff) // emoji skin-tone modifiers
	);
}

/** 全角（占 2 列）区间：CJK / 假名 / 全角标点 / 常见 emoji 与符号。 */
function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
		(code >= 0x2e80 && code <= 0x303e) || // CJK Radicals / Kangxi / CJK Symbols
		(code >= 0x3041 && code <= 0x33ff) || // Hiragana..CJK Compatibility
		(code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
		(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
		(code >= 0xa000 && code <= 0xa4cf) || // Yi
		(code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
		(code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
		(code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
		(code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) || // emoji 与符号（含 1F680 一类"交通/地图"）
		(code >= 0x20000 && code <= 0x3fffd) // CJK Ext B+
	);
}

/** 单个码位的显示列宽（0 / 1 / 2）。 */
export function codePointWidth(code: number): number {
	if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return 0; // 控制字符不占列
	if (isCombining(code)) return 0;
	if (isWide(code)) return 2;
	return 1;
}

/**
 * ANSI 转义序列（CSI 形态）。
 * ESC 字符**在运行期拼出来**（不在源码里写控制字符/转义序列）——biome 的
 * `noControlCharactersInRegex` 对正则字面量与转义写法都会报错，这样写语义一致且干净。
 */
const ESC_CHAR = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC_CHAR}\\[[0-9;?]*[A-Za-z]`, "g");

/** 字符串的显示列宽（**跳过 ANSI 转义序列**）。 */
export function visibleWidth(text: string): number {
	let width = 0;
	const stripped = text.replace(ANSI_RE, "");
	for (const char of stripped) {
		const code = char.codePointAt(0);
		if (code === undefined) continue;
		width += codePointWidth(code);
	}
	return width;
}

/** 按显示列宽截断（保留 ANSI 序列；不会把一个宽字符切一半）。 */
export function truncateToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	let width = 0;
	let out = "";
	let index = 0;
	while (index < text.length) {
		const ansi = ANSI_RE.exec(text.slice(index));
		ANSI_RE.lastIndex = 0;
		if (ansi !== null && ansi.index === 0) {
			out += ansi[0];
			index += ansi[0].length;
			continue;
		}
		const char = String.fromCodePoint(text.codePointAt(index) as number);
		const charWidth = codePointWidth(char.codePointAt(0) as number);
		if (width + charWidth > maxWidth) break;
		out += char;
		width += charWidth;
		index += char.length;
	}
	return `${out}\u001b[0m`;
}

/**
 * 按显示列宽**硬换行**（不做词边界：终端内容多为路径/日志，硬换行更可预测）。
 * 返回的每一行都**自带重置码结尾**，避免颜色渗到下一行（Pi 同款纪律）。
 */
export function wrapToWidth(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const lines: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine === "") {
			lines.push("");
			continue;
		}
		let current = "";
		let currentWidth = 0;
		let index = 0;
		while (index < rawLine.length) {
			const ansi = ANSI_RE.exec(rawLine.slice(index));
			ANSI_RE.lastIndex = 0;
			if (ansi !== null && ansi.index === 0) {
				current += ansi[0];
				index += ansi[0].length;
				continue;
			}
			const char = String.fromCodePoint(rawLine.codePointAt(index) as number);
			const charWidth = codePointWidth(char.codePointAt(0) as number);
			if (currentWidth + charWidth > width) {
				lines.push(`${current}\u001b[0m`);
				current = "";
				currentWidth = 0;
				// 宽字符换行后留白会错位，故宽字符单独成行时不补空格
			}
			current += char;
			currentWidth += charWidth;
			index += char.length;
		}
		lines.push(`${current}\u001b[0m`);
	}
	return lines;
}
