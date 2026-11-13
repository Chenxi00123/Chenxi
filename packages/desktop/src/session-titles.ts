/**
 * 桌面会话标题（M22，ADR-040）——**桌面视图配置**，不是会话事实。
 *
 * 为什么不写进 JSONL：标题是"我怎么称呼这条会话"，不是"会话里发生了什么"。写进 JSONL 会
 * 改 `SESSION_FORMAT_VERSION` 的语义面、并让 CLI/TUI 也要处理它；而它**不影响模型上下文**
 * （不参与 `deriveMessages`），所以放在 `<数据根>\desktop\session-titles.json` 更诚实。
 *
 * 纪律：
 *  - 与主题偏好 / 模型设置同性质：**绝不进 JSONL**，也**绝不进模型上下文**；
 *  - 文件损坏 / 版本不认 ⇒ 当作"没有标题"，**绝不拖垮启动**；
 *  - 本文件不依赖 Electron，vitest 可直接测。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const TITLES_FORMAT = "aster-desktop-session-titles";
export const TITLES_VERSION = 1;
export const TITLES_FILENAME = "session-titles.json";

export type TitleMap = Readonly<Record<string, string>>;

export function titlesPath(home: string): string {
	return join(resolve(home, "desktop"), TITLES_FILENAME);
}

/**
 * 标题的规范化：去首尾空白、压掉换行、**限长 60 字符**（列表一行的展示宽度）。
 * 空串 = 删除该标题（回到用 sessionId 显示）。
 */
export function normalizeTitle(raw: string): string {
	const flat = String(raw ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > 60 ? flat.slice(0, 60) : flat;
}

/** 读标题表（任何异常都退化为空表；**不抛**）。 */
export function loadTitles(home: string): TitleMap {
	const file = titlesPath(home);
	if (!existsSync(file)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const record = parsed as Record<string, unknown>;
		if (record.format !== TITLES_FORMAT || record.formatVersion !== TITLES_VERSION) return {};
		const titles = record.titles;
		if (typeof titles !== "object" || titles === null) return {};
		const out: Record<string, string> = {};
		for (const [sessionId, title] of Object.entries(titles as Record<string, unknown>)) {
			if (typeof title === "string" && normalizeTitle(title) !== "")
				out[sessionId] = normalizeTitle(title);
		}
		return out;
	} catch {
		return {};
	}
}

/** 写标题表（只增改这一条；空标题 = 删除）。 */
export function saveTitle(home: string, sessionId: string, rawTitle: string): TitleMap {
	const titles = { ...loadTitles(home) };
	const title = normalizeTitle(rawTitle);
	if (title === "") delete titles[sessionId];
	else titles[sessionId] = title;
	writeTitles(home, titles);
	return titles;
}

/** 删除一条标题（会话被删时用；当前没有删除会话，保留给后续批次）。 */
export function removeTitle(home: string, sessionId: string): TitleMap {
	return saveTitle(home, sessionId, "");
}

function writeTitles(home: string, titles: TitleMap): void {
	const file = titlesPath(home);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify({ format: TITLES_FORMAT, formatVersion: TITLES_VERSION, titles }, null, 2)}\n`,
		"utf8",
	);
}
