/**
 * 事件日志（ADR-003）：append-only、会话内单调序号。
 *
 * **纯内存、无 I/O**——落盘由 `persist` 负责（架构：persist -> session）。
 * 本模块保证：追加后 seq 单调、id 与 seq 绑定、resume 注入的历史事件被校验。
 */
import type { EventDraft, EventType, PayloadByType, SessionEvent, SessionId } from "@chenxi/schema";
import { eventIdForSeq } from "./ids.js";

export interface EventLog {
	readonly sessionId: SessionId;
	readonly events: readonly SessionEvent[];
	readonly length: number;
	/** 追加一条草稿事件：补齐 seq / id / sessionId / at，返回完整事件。 */
	append<T extends EventType>(draft: EventDraft<T>): SessionEvent;
	/** 最后一次写入的序号（-1 表示空日志）。 */
	lastSeq(): number;
	last(): SessionEvent | undefined;
}

export interface CreateEventLogParams {
	readonly sessionId: SessionId;
	/** resume 时注入的既有事件（必须已按 seq 单调、id 与 seq 一致）。 */
	readonly initialEvents?: readonly SessionEvent[];
}

export class EventLogError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "EventLogError";
		this.code = code;
	}
}

export function createEventLog(params: CreateEventLogParams): EventLog {
	const events: SessionEvent[] = [];

	const hydrate = (initial: readonly SessionEvent[]): void => {
		let expected = 0;
		for (const ev of initial) {
			if (ev.sessionId !== params.sessionId) {
				throw new EventLogError(
					"session_mismatch",
					`event seq=${ev.seq} belongs to session ${ev.sessionId}, expected ${params.sessionId}`,
				);
			}
			if (ev.seq !== expected) {
				throw new EventLogError(
					"non_monotonic",
					`event seq=${ev.seq} breaks monotonic order (expected ${expected})`,
				);
			}
			if (ev.id !== eventIdForSeq(ev.seq)) {
				throw new EventLogError(
					"id_seq_mismatch",
					`event id=${ev.id} does not match seq=${ev.seq}`,
				);
			}
			expected += 1;
		}
		events.push(...initial);
	};

	if (params.initialEvents && params.initialEvents.length > 0) {
		hydrate(params.initialEvents);
	}

	const append = <T extends EventType>(draft: EventDraft<T>): SessionEvent => {
		const seq = events.length;
		const event = {
			seq,
			id: eventIdForSeq(seq),
			sessionId: params.sessionId,
			type: draft.type,
			at: draft.at ?? new Date().toISOString(),
			payload: draft.payload as PayloadByType[T],
		} as SessionEvent;
		events.push(event);
		return event;
	};

	return {
		sessionId: params.sessionId,
		get events() {
			return events;
		},
		get length() {
			return events.length;
		},
		append,
		lastSeq: () => events.length - 1,
		last: () => events[events.length - 1],
	};
}
