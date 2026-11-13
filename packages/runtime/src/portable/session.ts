/**
 * 会话导入/导出的**写入侧**（ADR-019）。
 *
 * 纪律（不变量 5/6）：
 *  - **导入永远走我们自己的单一写入路径**（`store.create` + `handle.append`），
 *    绝不把外部 JSONL 直接拷进数据目录——因此 seq / id / 索引永远自洽；
 *  - **身份由导入方重建**：新会话有新 `sessionId`；`seq` / `id` 按顺序重新生成；
 *    除 `sessionId` 外，canonical 往返的事件序列**逐字段深等**（含 `at`、`seq`、`id`、`payload`）；
 *  - **不造数**：厂商导入只写"确实从来源读到的" user/assistant 文本，
 *    `turn/*`、工具轨迹等**不重建**（ADR-019 有损清单）。
 */
import type {
	AgentMode,
	EventDraft,
	ExchangeProducer,
	ExchangeSessionMeta,
	SessionEvent,
	SessionId,
	SessionStartPayload,
} from "@chenxi/schema";
import type { SessionStore } from "../persist/index.js";
import { draftFromExchange, type ExchangeEventDraft } from "./exchange.js";
import { eventsToTurns, type PortableTurn, turnsToDrafts } from "./turns.js";

export interface ExportedSession {
	readonly sessionId: SessionId;
	readonly meta: ExchangeSessionMeta;
	readonly producer: ExchangeProducer;
	readonly events: readonly SessionEvent[];
	readonly turns: readonly PortableTurn[];
}

/**
 * 交换文档里的产出方身份。
 * 版本号是**字面量**（与本仓既有做法一致：`mcp/client.ts` 的 `clientInfo.version` 同样是写死的），
 * `m9` 验收有断言把它与 `package.json` 对齐，避免两处漂移。
 */
export const CHENXI_PRODUCER: ExchangeProducer = { name: "chenxi", version: "1.0.0" };

/** 会话尚未结束时的收尾原因（导入会把未结束的会话补成已结束，保证事实源完整）。 */
const IMPORT_END_REASON = "exit";

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** `--export latest`：取最近更新的会话（与 `--resume latest` 同一口径）。 */
export function resolveLatestSession(
	metas: readonly { readonly sessionId: SessionId; readonly updatedAt: string }[],
): SessionId {
	const latest = [...metas].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
	if (latest === undefined) {
		throw new Error("no recorded session found to export (run a session first)");
	}
	return latest.sessionId;
}

/** 读出一个会话，并整理成「交换文档 + 可移植轮次」两份视图（共用同一次读）。 */
export async function readSessionForExport(params: {
	readonly store: SessionStore;
	readonly sessionId: SessionId;
	readonly producer: ExchangeProducer;
}): Promise<ExportedSession> {
	const handle = await params.store.resume(params.sessionId);
	try {
		const events = handle.log.events;
		const start = events.find((event) => event.type === "session/start");
		const last = events[events.length - 1];
		return {
			sessionId: params.sessionId,
			producer: params.producer,
			meta: {
				cwd: start?.type === "session/start" ? start.payload.cwd : "",
				mode: start?.type === "session/start" ? start.payload.mode : "plan",
				...(start?.type === "session/start" && start.payload.model !== undefined
					? { model: start.payload.model }
					: {}),
				createdAt: start?.at ?? last?.at ?? new Date().toISOString(),
				updatedAt: last?.at ?? start?.at ?? new Date().toISOString(),
			},
			events,
			turns: eventsToTurns(events),
		};
	} finally {
		// 只读导出：读完就关句柄，绝不留下"没人在管"的写入者
		await handle.close();
	}
}

/** 导入 canonical 文档：**按事件重建**（首条 `session/start` 由我们生成）。 */
export async function importExchangeDocument(params: {
	readonly store: SessionStore;
	readonly events: readonly ExchangeEventDraft[];
	readonly session: ExchangeSessionMeta;
}): Promise<{ readonly sessionId: SessionId; readonly eventCount: number }> {
	const start = params.events.find((event) => event.type === "session/start");
	const startPayload =
		start === undefined ? undefined : (start.payload as Partial<SessionStartPayload> | undefined);
	const cwd = asString(startPayload?.cwd) ?? params.session.cwd;
	const mode = (startPayload?.mode ?? params.session.mode) as AgentMode;
	const model = startPayload?.model ?? params.session.model;
	const parentSessionId = asString(startPayload?.parentSessionId) as SessionId | undefined;

	const handle = await params.store.create({
		cwd,
		mode,
		...(model === undefined ? {} : { model }),
		...(parentSessionId === undefined ? {} : { parentSessionId }),
		// 保留原会话的创建时间（否则索引会出现 created_at > updated_at）
		at: start?.at ?? params.session.createdAt,
	});
	try {
		const rest = params.events.filter((event) => event.type !== "session/start");
		for (const event of rest) {
			await handle.append(draftFromExchange(event));
		}
		if (rest[rest.length - 1]?.type !== "session/end") {
			await handle.append({ type: "session/end", payload: { reason: IMPORT_END_REASON } });
		}
		return { sessionId: handle.sessionId, eventCount: handle.log.length };
	} finally {
		await handle.close();
	}
}

/** 导入厂商会话：把可移植轮次落成 `user/message` + `assistant/message`（**不重建**工具轨迹）。 */
export async function importTurns(params: {
	readonly store: SessionStore;
	readonly turns: readonly PortableTurn[];
	readonly cwd?: string;
	readonly mode?: AgentMode;
	readonly model?: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
}): Promise<{ readonly sessionId: SessionId; readonly eventCount: number }> {
	if (params.turns.length === 0) {
		throw new Error("nothing to import: the source session has no user/assistant turn");
	}
	const drafts: EventDraft[] = turnsToDrafts(params.turns);
	const cwd = params.cwd ?? process.cwd();
	const handle = await params.store.create({
		cwd,
		mode: params.mode ?? "plan",
		...(params.model === undefined ? {} : { model: params.model }),
		at: params.createdAt ?? params.updatedAt,
	});
	try {
		for (const draft of drafts) {
			await handle.append(draft);
		}
		await handle.append({ type: "session/end", payload: { reason: IMPORT_END_REASON } });
		return { sessionId: handle.sessionId, eventCount: handle.log.length };
	} finally {
		await handle.close();
	}
}
