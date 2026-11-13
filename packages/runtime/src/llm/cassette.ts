/**
 * LLM cassette（M19 / ADR-037）：**版本化 JSONL** 的格式定义、canonical 请求哈希与序列化。
 *
 * 边界：本文件**不碰文件系统**（读写在 CLI 层）；**不记录 `signal` / 任何密钥**；
 * 严格解析在 `cassette-parse.ts`（本文件**不 import 它**，避免循环依赖）。
 */
import { createHash } from "node:crypto";
import type { ModelMessage, ToolDescriptor } from "@aster/schema";
import type { LlmStreamEvent } from "./types.js";

/** 文件标识（第一行 header 的 `format`）。 */
export const CASSETTE_FORMAT = "aster-llm-cassette";
/** 格式版本（与包版本解耦；破坏性格式变更才递增）。 */
export const CASSETTE_FORMAT_VERSION = 1;

const PRODUCER_NAME = "aster";

/** 第一行 header（版本化 JSONL 的元数据）。 */
export interface CassetteHeader {
	readonly format: typeof CASSETTE_FORMAT;
	readonly formatVersion: typeof CASSETTE_FORMAT_VERSION;
	readonly createdAt: string;
	readonly producer: string;
	/** 录制时的内层 provider id（供审计；回放用 `cassette-replay`）。 */
	readonly providerId: string;
	readonly model: string;
}

/** 请求快照：**刻意不含 `signal`**（cassette 不携带任何执行期能力或密钥）。 */
export interface CassetteRequest {
	readonly model: string;
	readonly messages: readonly ModelMessage[];
	readonly tools?: readonly ToolDescriptor[];
	readonly temperature?: number;
}

/** 一次流式往返（成功或失败都恰好一条）。 */
export interface CassetteExchange {
	readonly kind: "exchange";
	readonly index: number;
	readonly request: CassetteRequest;
	/** sha256(canonicalJson({model,messages,tools,temperature}))；加载时会重算并比对。 */
	readonly requestKey: string;
	readonly events: readonly LlmStreamEvent[];
	/** `true` = 流正常结束；`false` = 抛错或消费者提前中止。 */
	readonly complete: boolean;
	/** 抛错时的**原始** message（消费者提前中止时没有 error）。 */
	readonly error?: string;
}

export interface CassetteDocument {
	readonly header: CassetteHeader;
	readonly exchanges: readonly CassetteExchange[];
}

export type CassetteErrorOptions = { readonly line?: number; readonly field?: string };

/** cassette 的格式/校验错误：行号与字段直接拼进 message（错误必须**当场可读**）。 */
export class CassetteError extends Error {
	readonly line?: number;
	readonly field?: string;

	constructor(message: string, options: CassetteErrorOptions = {}) {
		const where: string[] = [];
		if (options.line !== undefined) where.push(`line ${options.line}`);
		if (options.field !== undefined) where.push(`field "${options.field}"`);
		super(where.length === 0 ? message : `${message} (${where.join(", ")})`);
		this.name = "CassetteError";
		this.line = options.line;
		this.field = options.field;
	}
}

/**
 * canonical JSON：**对象递归按键名排序、数组保序**。
 * 为什么不用默认键序：同一请求在不同构造路径下键序可能不同，排序后哈希只表达**内容**。
 * `undefined` 在对象里视同缺席；数组里的 `undefined` 记为 `null`（与 JSON 语义一致）。
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) {
				throw new CassetteError(`cannot canonicalize non-finite number: ${String(value)}`);
			}
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "object":
			break;
		default:
			throw new CassetteError(`cannot canonicalize value of type ${typeof value}`);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * 请求哈希：sha256(canonicalJson({ model, messages, tools: tools ?? [], temperature: temperature ?? null }))。
 * `?? []` / `?? null` 让"没有"在键空间里有确定表示（否则两份语义相同的请求会算出不同哈希）。
 */
export function requestKeyOf(request: CassetteRequest): string {
	const text = canonicalJson({
		model: request.model,
		messages: request.messages,
		tools: request.tools ?? [],
		temperature: request.temperature ?? null,
	});
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 构造 header（`createdAt` 可注入，便于测试与确定性）。 */
export function createCassetteHeader(input: {
	readonly providerId: string;
	readonly model: string;
	readonly createdAt?: string;
	readonly producer?: string;
}): CassetteHeader {
	return {
		format: CASSETTE_FORMAT,
		formatVersion: CASSETTE_FORMAT_VERSION,
		createdAt: input.createdAt ?? new Date().toISOString(),
		producer: input.producer ?? PRODUCER_NAME,
		providerId: input.providerId,
		model: input.model,
	};
}

/** 序列化 header（**含尾换行**：JSONL 一行一条）。 */
export function serializeCassetteHeader(header: CassetteHeader): string {
	return `${JSON.stringify(header)}\n`;
}

/** 序列化一条 exchange（含尾换行）。 */
export function serializeCassetteExchange(exchange: CassetteExchange): string {
	return `${JSON.stringify(exchange)}\n`;
}

/** 序列化整份文档（header + 全部 exchange 行）。 */
export function serializeCassette(document: CassetteDocument): string {
	return [
		serializeCassetteHeader(document.header),
		...document.exchanges.map((exchange) => serializeCassetteExchange(exchange)),
	].join("");
}
