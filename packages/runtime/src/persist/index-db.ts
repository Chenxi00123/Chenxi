/**
 * 派生索引（SQLite，`node:sqlite` 的 `DatabaseSync`）。
 *
 * ADR-008：**索引绝不可作为第二事实源**。本类只提供「由 JSONL 事实重放得到」的读写，
 * 任何索引内容都应能由 `sessions/*.jsonl` 全量重建；二者不一致时一律以 JSONL 为准。
 *
 * 连接策略：按需开连接、用完即关。这样在任何时刻都不会长期持有 `index.sqlite` 句柄，
 * 使 `rebuild-index`（删除索引文件 + 重建）在 Windows 上也能自由替换文件。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionEvent } from "@aster/schema";

/** sessions 表一行（对应一个会话的派生元信息）。 */
export interface SessionIndexRow {
	session_id: string;
	cwd: string;
	model: string | null;
	mode: string;
	created_at: string;
	updated_at: string;
	event_count: number;
	last_seq: number;
}

/** events 表一行（逐条事件事实的派生副本）。 */
export interface EventIndexRow {
	session_id: string;
	seq: number;
	type: string;
	at: string;
	payload: string;
}

/** 重建输入：一个会话的派生行 + 重放事件。 */
export interface RebuildEntry {
	readonly row: SessionIndexRow;
	readonly events: readonly SessionEvent[];
}

/** 重建计数。 */
export interface RebuildCounts {
	readonly sessions: number;
	readonly events: number;
}

/** 索引全量快照（供逐条一致性比对）。 */
export interface IndexSnapshot {
	readonly sessions: SessionIndexRow[];
	readonly events: EventIndexRow[];
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
	session_id TEXT PRIMARY KEY,
	cwd TEXT NOT NULL,
	model TEXT,
	mode TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	event_count INTEGER NOT NULL,
	last_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
	session_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	type TEXT NOT NULL,
	at TEXT NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, seq)
);
`;

const DROP_SQL = `
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS sessions;
`;

const INSERT_SESSION_SQL = `
INSERT OR REPLACE INTO sessions
	(session_id, cwd, model, mode, created_at, updated_at, event_count, last_seq)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_EVENT_SQL = `
INSERT OR REPLACE INTO events (session_id, seq, type, at, payload)
VALUES (?, ?, ?, ?, ?)
`;

const SELECT_SESSIONS_SQL = `
SELECT session_id, cwd, model, mode, created_at, updated_at, event_count, last_seq
FROM sessions ORDER BY session_id
`;

const SELECT_EVENTS_SQL = `
SELECT session_id, seq, type, at, payload
FROM events ORDER BY session_id, seq
`;

/** 把一个 SessionEvent 映射为 events 表绑定参数。 */
function eventParams(sessionId: string, event: SessionEvent) {
	return [sessionId, event.seq, event.type, event.at, JSON.stringify(event.payload)] as const;
}

/** 把一个 SessionIndexRow 映射为 sessions 表绑定参数。 */
function sessionParams(row: SessionIndexRow) {
	return [
		row.session_id,
		row.cwd,
		row.model,
		row.mode,
		row.created_at,
		row.updated_at,
		row.event_count,
		row.last_seq,
	] as const;
}

export class IndexDb {
	readonly #file: string;

	constructor(file: string) {
		this.#file = file;
	}

	/** 打开连接、确保表结构存在、执行 fn、关闭连接。 */
	#with<T>(fn: (db: DatabaseSync) => T): T {
		mkdirSync(dirname(this.#file), { recursive: true });
		const db = new DatabaseSync(this.#file);
		try {
			db.exec(SCHEMA_SQL);
			return fn(db);
		} finally {
			db.close();
		}
	}

	/** 全量写入一个会话（resume 时把事实源同步进索引）。 */
	syncSession(row: SessionIndexRow, events: readonly SessionEvent[]): void {
		this.#with((db) => {
			db.prepare(INSERT_SESSION_SQL).run(...sessionParams(row));
			const insertEvent = db.prepare(INSERT_EVENT_SQL);
			for (const event of events) {
				insertEvent.run(...eventParams(row.session_id, event));
			}
		});
	}

	/** 追加一条事件：同一连接内更新会话派生行与事件行。 */
	upsertSessionAndEvent(row: SessionIndexRow, event: SessionEvent): void {
		this.#with((db) => {
			db.prepare(INSERT_SESSION_SQL).run(...sessionParams(row));
			db.prepare(INSERT_EVENT_SQL).run(...eventParams(row.session_id, event));
		});
	}

	/** 会话列表（派生）。 */
	listSessions(): SessionIndexRow[] {
		return this.#with(
			(db) => db.prepare(SELECT_SESSIONS_SQL).all() as unknown as SessionIndexRow[],
		);
	}

	/** 全量快照，用于重建前后逐条比对。 */
	snapshot(): IndexSnapshot {
		return this.#with((db) => ({
			sessions: db.prepare(SELECT_SESSIONS_SQL).all() as unknown as SessionIndexRow[],
			events: db.prepare(SELECT_EVENTS_SQL).all() as unknown as EventIndexRow[],
		}));
	}

	/** 由 JSONL 重放结果全量重建索引：drop + recreate + 重放。幂等。 */
	rebuild(entries: readonly RebuildEntry[]): RebuildCounts {
		return this.#with((db) => {
			db.exec(DROP_SQL);
			db.exec(SCHEMA_SQL);
			const insertSession = db.prepare(INSERT_SESSION_SQL);
			const insertEvent = db.prepare(INSERT_EVENT_SQL);
			let eventCount = 0;
			for (const { row, events } of entries) {
				insertSession.run(...sessionParams(row));
				for (const event of events) {
					insertEvent.run(...eventParams(row.session_id, event));
					eventCount += 1;
				}
			}
			return { sessions: entries.length, events: eventCount };
		});
	}
}
