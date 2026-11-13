/**
 * 会话持久化（ADR-008）：**JSONL 是唯一事实源，SQLite 只是可全量重建的派生索引**。
 *
 * 写入路径严格「先 JSONL（并 fsync 落盘）再更新索引」；首个不可续的存储错误即封禁该会话，
 * 之后任何 `append` 直接抛出同一错误、**绝不重试**（核心不变量 5）。
 */
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	writeSync,
} from "node:fs";
import type { AgentMode, EventDraft, EventType, SessionEvent, SessionId } from "@aster/schema";
import { SESSION_FORMAT_VERSION } from "@aster/schema";
import type { EventLog } from "../session/index.js";
import { createEventLog, newSessionId } from "../session/index.js";
import type { RebuildCounts, SessionIndexRow } from "./index-db.js";
import { IndexDb } from "./index-db.js";
import {
	indexPath,
	resolveHome,
	sessionFilePath,
	sessionIdFromFileName,
	sessionsDir,
} from "./paths.js";

export interface PersistOptions {
	/** ASTER_HOME 数据目录；缺省取 env.ASTER_HOME 或 ~/.aster。 */
	readonly home?: string;
	/** 索引数据库文件名，仅测试用；缺省 "index.sqlite"。 */
	readonly indexFile?: string;
}

export interface SessionMeta {
	readonly sessionId: SessionId;
	readonly cwd: string;
	readonly model?: string;
	readonly mode: AgentMode;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly eventCount: number;
	readonly lastSeq: number;
}

export interface RebuildReport {
	readonly sessions: number;
	readonly events: number;
}

export interface SessionHandle {
	readonly sessionId: SessionId;
	/** 内存态事件日志（由 session 模块提供）。 */
	readonly log: EventLog;
	/** 写入路径：**先 append JSONL（fsync）再更新索引**；返回完整事件。 */
	append<T extends EventType>(draft: EventDraft<T>): Promise<SessionEvent>;
	/** 关闭句柄（刷新索引；不删除数据）。 */
	close(): Promise<void>;
}

export interface SessionStore {
	/** 新建会话：写 session/start 事件并建索引行。 */
	create(init: {
		cwd: string;
		mode: AgentMode;
		model?: string;
		/** 子代理：父会话 id（ADR-017）。 */
		parentSessionId?: SessionId;
		/** `session/start` 的显式时间戳（ADR-019：可移植导入要保留原创建时间）。 */
		at?: string;
	}): Promise<SessionHandle>;
	/** resume：从 JSONL 重建事件日志；若索引缺失也可用（JSONL 是事实源）。 */
	resume(sessionId: SessionId): Promise<SessionHandle>;
	/** 会话列表（读索引）。 */
	list(): Promise<SessionMeta[]>;
	/** 由 JSONL 全量重建索引（drop + recreate + 重放），返回计数。 */
	rebuildIndex(): Promise<RebuildReport>;
	dispose(): Promise<void>;
}

/**
 * 会话派生行的**唯一归约函数**：写入路径与索引重建路径共用同一实现，
 * 以此保证「实时索引」与「由 JSONL 重建的索引」逐条深等。
 */
function reduceSessionRow(prev: SessionIndexRow | undefined, event: SessionEvent): SessionIndexRow {
	const next: SessionIndexRow =
		prev === undefined
			? {
					session_id: event.sessionId,
					cwd: "",
					model: null,
					mode: "plan",
					created_at: event.at,
					updated_at: event.at,
					event_count: 0,
					last_seq: -1,
				}
			: { ...prev };

	if (event.type === "session/start") {
		next.cwd = event.payload.cwd;
		next.mode = event.payload.mode;
		next.model = event.payload.model ?? null;
		next.created_at = event.at;
	} else if (event.type === "mode/changed") {
		next.mode = event.payload.to;
	}
	next.updated_at = event.at;
	next.event_count += 1;
	next.last_seq = event.seq;
	return next;
}

/** 由完整事件序列折叠出会话派生行（与重建路径同源）。 */
function rowFromEvents(events: readonly SessionEvent[]): SessionIndexRow | undefined {
	let row: SessionIndexRow | undefined;
	for (const event of events) {
		row = reduceSessionRow(row, event);
	}
	return row;
}

/** 读取一份 JSONL 事实源：每行一条事件。 */
function readSessionEvents(file: string): SessionEvent[] {
	const raw = readFileSync(file, "utf8");
	const events: SessionEvent[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		events.push(JSON.parse(line) as SessionEvent);
	}
	return events;
}

/** 追加一条事件到 JSONL 并 fsync，确保落盘（不变量 5 / ADR-008）。 */
function appendEventLine(file: string, event: SessionEvent): void {
	const line = `${JSON.stringify(event)}\n`;
	const fd = openSync(file, "a");
	try {
		writeSync(fd, line);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function toSessionMeta(row: SessionIndexRow): SessionMeta {
	return {
		sessionId: row.session_id as SessionId,
		cwd: row.cwd,
		model: row.model ?? undefined,
		mode: row.mode as AgentMode,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		eventCount: row.event_count,
		lastSeq: row.last_seq,
	};
}

/** 会话句柄：把内存日志、JSONL 事实源与派生索引串成「先事实、后派生」的写入路径。 */
class Handle implements SessionHandle {
	readonly sessionId: SessionId;
	readonly log: EventLog;
	readonly #file: string;
	readonly #db: IndexDb;
	#failed: Error | undefined;
	#closed = false;

	constructor(sessionId: SessionId, log: EventLog, file: string, db: IndexDb) {
		this.sessionId = sessionId;
		this.log = log;
		this.#file = file;
		this.#db = db;
	}

	/**
	 * 追加一条事件：**先事实源（JSONL + fsync）、后派生索引**；首个错误即封禁。
	 *
	 * ⚠️ **故意写成箭头属性**：`append` 在本仓库多处被当**值**传递（记忆注入缝、扩展缝等）。
	 * 原型方法一旦被解构/传参就会丢 `this`，而本类用了 `#私有字段` —— 表现为
	 * `Cannot read properties of undefined (reading '#failed')` 这类难查的 TypeError。
	 * 箭头属性天然绑定，从根上消灭这个坑。
	 */
	readonly append = async <T extends EventType>(draft: EventDraft<T>): Promise<SessionEvent> => {
		if (this.#failed !== undefined) throw this.#failed; // 已封禁：抛同一错误，不重试
		if (this.#closed) throw new Error(`session ${this.sessionId} handle is closed`);

		const event = this.log.append(draft);
		try {
			// 先写事实源（JSONL + fsync）
			appendEventLine(this.#file, event);
			// 再更新派生索引
			const row = rowFromEvents(this.log.events);
			if (row !== undefined) this.#db.upsertSessionAndEvent(row, event);
		} catch (err) {
			this.#failed = err instanceof Error ? err : new Error(String(err));
			throw this.#failed;
		}
		return event;
	};

	/** 关闭句柄（同样用箭头属性，保证可被安全地当值传递）。 */
	readonly close = async (): Promise<void> => {
		this.#closed = true;
	};
}

class Store implements SessionStore {
	readonly #home: string;
	readonly #sessionsDir: string;
	readonly #db: IndexDb;
	readonly #handles = new Set<Handle>();
	#disposed = false;

	constructor(options: PersistOptions) {
		this.#home = resolveHome(options.home);
		this.#sessionsDir = sessionsDir(this.#home);
		this.#db = new IndexDb(indexPath(this.#home, options.indexFile));
	}

	async create(init: {
		cwd: string;
		mode: AgentMode;
		model?: string;
		/** 子代理：父会话 id（ADR-017；`--list` 因此能看出父子关系）。 */
		parentSessionId?: SessionId;
		/**
		 * `session/start` 的显式时间戳（ADR-019）：**可移植导入**要保留原会话的创建时间，
		 * 否则索引里会出现 `created_at > updated_at` 这种自相矛盾的派生行。
		 */
		at?: string;
	}): Promise<SessionHandle> {
		if (this.#disposed) throw new Error("session store disposed");
		mkdirSync(this.#sessionsDir, { recursive: true });

		const sessionId = newSessionId();
		const file = sessionFilePath(this.#home, sessionId);
		const log = createEventLog({ sessionId });
		const start = log.append({
			type: "session/start",
			payload: {
				formatVersion: SESSION_FORMAT_VERSION,
				cwd: init.cwd,
				mode: init.mode,
				model: init.model,
				...(init.parentSessionId === undefined ? {} : { parentSessionId: init.parentSessionId }),
			},
			...(init.at === undefined ? {} : { at: init.at }),
		});
		// 先事实源、后派生索引
		appendEventLine(file, start);
		const row = rowFromEvents(log.events);
		if (row !== undefined) this.#db.syncSession(row, log.events);

		const handle = new Handle(sessionId, log, file, this.#db);
		this.#handles.add(handle);
		return handle;
	}

	async resume(sessionId: SessionId): Promise<SessionHandle> {
		if (this.#disposed) throw new Error("session store disposed");
		const file = sessionFilePath(this.#home, sessionId);
		if (!existsSync(file)) {
			throw new Error(`session ${sessionId} not found: ${file}`);
		}
		const events = readSessionEvents(file);
		const log = createEventLog({ sessionId, initialEvents: events });
		// 索引缺失/落后时，用事实源把它补齐（索引始终是派生的）
		const row = rowFromEvents(log.events);
		if (row !== undefined) this.#db.syncSession(row, log.events);

		const handle = new Handle(sessionId, log, file, this.#db);
		this.#handles.add(handle);
		return handle;
	}

	async list(): Promise<SessionMeta[]> {
		return this.#db.listSessions().map(toSessionMeta);
	}

	async rebuildIndex(): Promise<RebuildReport> {
		const entries: { row: SessionIndexRow; events: readonly SessionEvent[] }[] = [];
		if (existsSync(this.#sessionsDir)) {
			for (const name of readdirSync(this.#sessionsDir)) {
				const sessionId = sessionIdFromFileName(name);
				if (sessionId === undefined) continue;
				const events = readSessionEvents(sessionFilePath(this.#home, sessionId));
				if (events.length === 0) continue;
				const row = rowFromEvents(events);
				if (row === undefined) continue;
				entries.push({ row, events });
			}
		}
		const counts: RebuildCounts = this.#db.rebuild(entries);
		return { sessions: counts.sessions, events: counts.events };
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		for (const handle of this.#handles) {
			await handle.close();
		}
		this.#handles.clear();
	}
}

/** 创建一个会话存储（JSONL 事实源 + 可重建索引）。 */
export function createSessionStore(options: PersistOptions = {}): SessionStore {
	return new Store(options);
}
