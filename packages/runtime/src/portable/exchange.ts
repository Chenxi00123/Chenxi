/**
 * canonical 交换文档的构建与解析（ADR-019）。
 *
 * 纪律：
 *  - **版本门禁是真实分支**：`formatVersion > EXCHANGE_FORMAT_VERSION` → 快速失败并给出可读原因
 *    （绝不静默降级去读一个自己看不懂的格式）；`formatVersion < EXCHANGE_FORMAT_VERSION` → 同样拒绝
 *    （v1 是首版，**没有更早版本**，故此刻没有任何迁移路径可言；将来新增版本时在此登记迁移）；
 *  - **只校验会进模型历史的载荷**：审计类事件（`turn/*`、`permission/*`、`mode/changed` …）形状有误
 *    不会污染投影，因此不做深层校验——避免把整套事件 schema 复制一遍造成两份事实源；
 *  - **导入方永远重新分配身份**：文档里的 `seq` / `id` / `sessionId` 只表示**来源会话**，
 *    导入时一律由我们自己的写入路径重新生成（不变量 5/6：单一事实源、单一写入路径）。
 */
import {
	EVENT_TYPES,
	type EventDraft,
	type EventType,
	EXCHANGE_FORMAT,
	EXCHANGE_FORMAT_VERSION,
	type ExchangeProducer,
	type ExchangeSessionMeta,
	type SessionEvent,
	type SessionExchangeDocument,
} from "@aster/schema";
import { z } from "zod";

/** 文档里的一条事件草稿（身份字段已剥离：导入方重建）。 */
export interface ExchangeEventDraft {
	readonly type: EventType;
	readonly payload: unknown;
	readonly at?: string;
}

export interface ParsedExchangeDocument {
	readonly formatVersion: number;
	readonly producer: ExchangeProducer;
	readonly session: ExchangeSessionMeta;
	readonly events: readonly ExchangeEventDraft[];
}

/** 交换文档格式错误（稳定 code 供测试与 CLI 断言）。 */
export class ExchangeFormatError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ExchangeFormatError";
		this.code = code;
	}
}

const producerSchema = z.strictObject({
	name: z.string().min(1),
	version: z.string().min(1),
});

// `mode` 的取值集合必须与 `@aster/schema` 的 `AGENT_MODES` 一致（m9 验收有断言，避免两处漂移）
const sessionSchema = z.strictObject({
	cwd: z.string().min(1),
	mode: z.enum(["plan", "build"]),
	model: z.string().min(1).optional(),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
});

const eventSchema = z.object({
	type: z.enum(EVENT_TYPES),
	payload: z.record(z.string(), z.unknown()),
	at: z.string().min(1),
	// 来源会话的身份；导入时被重新分配，故可选（手写文档可省略）
	seq: z.number().int().nonnegative().optional(),
	id: z.string().min(1).optional(),
	sessionId: z.string().min(1).optional(),
});

const documentSchema = z.object({
	format: z.literal(EXCHANGE_FORMAT),
	formatVersion: z.number().int().nonnegative(),
	producer: producerSchema,
	session: sessionSchema,
	events: z.array(eventSchema),
});

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
	return issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
			return `${path}: ${issue.message}`;
		})
		.join("; ");
}

/** 只校验「会进模型历史」的载荷（这些一旦形状不对，投影就会产出坏消息）。 */
function assertPayloadShape(type: EventType, payload: Record<string, unknown>): void {
	const bad = (what: string): never => {
		throw new ExchangeFormatError("payload_invalid", `event "${type}": payload ${what}`);
	};
	const has = (field: string): boolean => typeof payload[field] === "string";
	switch (type) {
		case "user/message":
			if (!has("content")) bad('must have a string "content"');
			break;
		case "assistant/message":
			if (!has("content")) bad('must have a string "content"');
			if (payload.toolCalls !== undefined && !Array.isArray(payload.toolCalls)) {
				bad('"toolCalls" must be an array when present');
			}
			break;
		case "tool/result":
			if (!has("callId") || typeof payload.ok !== "boolean") {
				bad('must have a string "callId" and a boolean "ok"');
			}
			break;
		case "memory/injected":
			if (!has("target") || !has("source") || !has("content")) {
				bad('must have strings "target" / "source" / "content"');
			}
			break;
		case "memory/written":
			if (!has("decision") || !has("content") || typeof payload.sourceSeq !== "number") {
				bad('must have strings "decision" / "content" and a numeric "sourceSeq"');
			}
			break;
		case "subagent/context-imported":
			if (!Array.isArray(payload.messages)) bad('must have an array "messages"');
			break;
		case "subagent/result":
			if (!has("childSessionId") || !has("kind") || typeof payload.ok !== "boolean") {
				bad('must have strings "childSessionId" / "kind" and a boolean "ok"');
			}
			break;
		default:
			break;
	}
}

/** 由会话元数据 + 事件构建 canonical 文档。 */
export function buildExchangeDocument(params: {
	readonly session: ExchangeSessionMeta;
	readonly events: readonly SessionEvent[];
	readonly producer: ExchangeProducer;
}): SessionExchangeDocument {
	return {
		format: EXCHANGE_FORMAT,
		formatVersion: EXCHANGE_FORMAT_VERSION,
		producer: params.producer,
		session: params.session,
		events: params.events,
	};
}

/** 解析（并做版本门禁 + 载荷校验）。`raw` 通常是 `JSON.parse` 的结果。 */
export function parseExchangeDocument(raw: unknown): ParsedExchangeDocument {
	const parsed = documentSchema.safeParse(raw);
	if (!parsed.success) {
		throw new ExchangeFormatError(
			"document_invalid",
			`not a valid ${EXCHANGE_FORMAT} document — ${describeIssues(parsed.error.issues)}`,
		);
	}
	const version = parsed.data.formatVersion;
	if (version > EXCHANGE_FORMAT_VERSION) {
		throw new ExchangeFormatError(
			"version_unsupported",
			`document formatVersion ${version} is newer than this client supports ` +
				`(${EXCHANGE_FORMAT_VERSION}); upgrade Aster instead of importing blindly`,
		);
	}
	if (version < EXCHANGE_FORMAT_VERSION) {
		// v1 是首版：没有更早版本，因此没有任何可用的迁移路径（将来新增版本时在此登记迁移）
		throw new ExchangeFormatError(
			"version_unmigratable",
			`document formatVersion ${version} predates ${EXCHANGE_FORMAT_VERSION} and no migration is registered`,
		);
	}

	const events: ExchangeEventDraft[] = [];
	for (const event of parsed.data.events) {
		assertPayloadShape(event.type, event.payload);
		events.push({ type: event.type, payload: event.payload, at: event.at });
	}
	return {
		formatVersion: version,
		producer: parsed.data.producer,
		session: parsed.data.session,
		events,
	};
}

/** 解析 JSON 文本（`JSON.parse` 失败 -> 可读格式错误，而不是裸 `SyntaxError`）。 */
export function parseExchangeJson(text: string): ParsedExchangeDocument {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ExchangeFormatError("json_invalid", `document is not valid JSON: ${message}`);
	}
	return parseExchangeDocument(raw);
}

/** 事件草稿 -> 可直接 `append` 的草稿（`payload` 已通过载荷校验）。 */
export function draftFromExchange(event: ExchangeEventDraft): EventDraft {
	return {
		type: event.type,
		payload: event.payload as EventDraft["payload"],
		...(event.at === undefined ? {} : { at: event.at }),
	} as EventDraft;
}
