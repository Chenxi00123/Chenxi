/**
 * 标识符生成（依赖 crypto，故置于 runtime 而非 schema）。
 */
import { randomUUID } from "node:crypto";
import type { EventId, SessionId, ToolCallId, TurnId } from "@chenxi/schema";

export function newSessionId(): SessionId {
	const ts = Date.now().toString(36);
	const rand = randomUUID().slice(0, 8);
	return `ses_${ts}${rand}` as SessionId;
}

export function newToolCallId(): ToolCallId {
	return `call_${randomUUID().replace(/-/g, "").slice(0, 16)}` as ToolCallId;
}

export function newTurnId(index: number): TurnId {
	return `turn_${index}` as TurnId;
}

export function eventIdForSeq(seq: number): EventId {
	return `evt_${seq}` as EventId;
}
