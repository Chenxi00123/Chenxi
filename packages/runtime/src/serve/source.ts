/**
 * 服务端的**只读**事实源读取（ADR-021）。
 *
 * 为什么不用 `persist` 的 store：`resume` 会**顺带补齐派生索引**（SQLite 写），而服务端（M11a）
 * 的纪律是"**不新增任何写入**"。这里直接读 JSONL 事实源——顺带证明不变量 6（索引是可重建的派生品，
 * 服务端**完全没有它也能工作**）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { AgentMode, SessionEvent, SessionId } from "@aster/schema";
import { sessionFilePath, sessionIdFromFileName, sessionsDir } from "../persist/index.js";

/** 由磁盘事实源折叠出的会话元数据（与 `persist` 的派生行**同义**，但这里不碰索引）。 */
export interface DiskSessionMeta {
	readonly sessionId: SessionId;
	readonly cwd: string;
	readonly mode: AgentMode;
	readonly model?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly eventCount: number;
	readonly lastSeq: number;
}

/**
 * 读一份 JSONL。
 * 被并发追加时**最后一行可能是半行**（写入方一次 write + fsync，正常情况下不会，
 * 但我们要对"读到半行"这件事守规矩）：**只有最后一行**解析失败才容忍，其余一律抛错。
 */
export function readSessionEvents(home: string, sessionId: SessionId): SessionEvent[] | undefined {
	const file = sessionFilePath(home, sessionId);
	if (!existsSync(file)) return undefined;
	const raw = readFileSync(file, "utf8");
	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	const events: SessionEvent[] = [];
	for (const [index, line] of lines.entries()) {
		try {
			events.push(JSON.parse(line) as SessionEvent);
		} catch (error) {
			if (index === lines.length - 1) break; // 正在被追加的半行：忽略它
			throw new Error(
				`session ${sessionId} is corrupt at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return events;
}

/** 把事件序列折叠成元数据（`session/start` 提供 cwd/mode/model/createdAt，`mode/changed` 覆盖 mode）。 */
export function deriveDiskMeta(
	sessionId: SessionId,
	events: readonly SessionEvent[],
): DiskSessionMeta | undefined {
	let cwd = "";
	let mode: AgentMode = "plan";
	let model: string | undefined;
	let createdAt = "";
	let updatedAt = "";
	for (const event of events) {
		if (event.type === "session/start") {
			cwd = event.payload.cwd;
			mode = event.payload.mode;
			model = event.payload.model;
			createdAt = event.at;
		} else if (event.type === "mode/changed") {
			mode = event.payload.to;
		}
		updatedAt = event.at;
	}
	if (cwd === "" || createdAt === "") return undefined;
	return {
		sessionId,
		cwd,
		mode,
		...(model === undefined ? {} : { model }),
		createdAt,
		updatedAt,
		eventCount: events.length,
		lastSeq: events.length - 1,
	};
}

/** 扫描 `<home>/sessions` 列出全部会话（**只读文件系统**，不信索引）。 */
export function listSessionsFromDisk(home: string): DiskSessionMeta[] {
	const dir = sessionsDir(home);
	if (!existsSync(dir)) return [];
	const metas: DiskSessionMeta[] = [];
	for (const name of readdirSync(dir)) {
		const sessionId = sessionIdFromFileName(name);
		if (sessionId === undefined) continue;
		const events = readSessionEvents(home, sessionId);
		if (events === undefined || events.length === 0) continue;
		const meta = deriveDiskMeta(sessionId, events);
		if (meta !== undefined) metas.push(meta);
	}
	return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
