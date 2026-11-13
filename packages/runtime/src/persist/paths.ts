/**
 * 数据目录布局与路径解析（ADR-008）。
 *
 * 布局：
 *   <home>/sessions/<sessionId>.jsonl   唯一事实源（每行一条事件 JSON）
 *   <home>/index.sqlite                 派生索引（可随时删除后全量重建）
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionId } from "@aster/schema";

/** 索引数据库文件名（仅测试覆盖）。 */
export const DEFAULT_INDEX_FILE = "index.sqlite";

/** 会话事实源所在子目录名。 */
export const SESSIONS_DIR_NAME = "sessions";

/** JSONL 文件扩展名。 */
export const JSONL_EXT = ".jsonl";

/**
 * 解析数据根目录：显式 `home` > 环境变量 `ASTER_HOME` > `~/.aster`。
 */
export function resolveHome(home?: string): string {
	if (home !== undefined && home.trim() !== "") return resolve(home);
	const fromEnv: string | undefined = process.env.ASTER_HOME;
	if (fromEnv !== undefined && fromEnv.trim() !== "") return resolve(fromEnv);
	return join(homedir(), ".aster");
}

/** `<home>/sessions`。 */
export function sessionsDir(home: string): string {
	return join(home, SESSIONS_DIR_NAME);
}

/** `<home>/sessions/<sessionId>.jsonl`。 */
export function sessionFilePath(home: string, sessionId: SessionId): string {
	return join(sessionsDir(home), `${sessionId}${JSONL_EXT}`);
}

/** 索引数据库完整路径。 */
export function indexPath(home: string, indexFile?: string): string {
	return join(home, indexFile ?? DEFAULT_INDEX_FILE);
}

/** 从文件名还原 sessionId；非 JSONL 文件返回 undefined。 */
export function sessionIdFromFileName(name: string): SessionId | undefined {
	if (!name.endsWith(JSONL_EXT)) return undefined;
	return name.slice(0, -JSONL_EXT.length) as SessionId;
}
