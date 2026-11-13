/**
 * cassette 的**严格解析**（M19 / ADR-037）——从 `cassette.ts` 拆出（架构门禁的 400 行上限）。
 *
 * 边界：本文件**只解析文本**（不碰文件系统、不发网络）；格式定义 / canonical 哈希 / 序列化
 * 留在 `cassette.ts`。依赖方向**单向**：`cassette.ts` **不 import 本文件**（无循环依赖）。
 * 解析**严格**：缺字段、错 format、版本不符、坏 JSON、requestKey 篡改一律 `CassetteError`，
 * 信息带**行号 / 字段**。
 */
import type { ModelMessage, StopReason, ToolCallRef, ToolDescriptor } from "@aster/schema";
import {
	CASSETTE_FORMAT,
	CASSETTE_FORMAT_VERSION,
	type CassetteDocument,
	CassetteError,
	type CassetteErrorOptions,
	type CassetteExchange,
	type CassetteHeader,
	type CassetteRequest,
	requestKeyOf,
} from "./cassette.js";
import type { LlmStreamEvent, LlmUsage } from "./types.js";

const STOP_REASONS: readonly StopReason[] = ["end_turn", "tool_call", "length", "error", "aborted"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, options: CassetteErrorOptions): CassetteError {
	return new CassetteError(message, options);
}

// ---- 严格解析 ----

function need(value: unknown, line: number, field: string): string {
	if (typeof value !== "string") throw fail("expected a string", { line, field });
	return value;
}

function parseJson(raw: string, line: number): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw fail(`invalid JSON: ${message}`, { line });
	}
}

function parseHeader(value: unknown, line: number): CassetteHeader {
	if (!isRecord(value)) throw fail("cassette header must be a JSON object", { line });
	if (value.format !== CASSETTE_FORMAT) {
		throw fail(`unsupported cassette format (expected "${CASSETTE_FORMAT}")`, {
			line,
			field: "format",
		});
	}
	if (value.formatVersion !== CASSETTE_FORMAT_VERSION) {
		throw fail(
			`unsupported formatVersion ${String(value.formatVersion)} (expected ${CASSETTE_FORMAT_VERSION})`,
			{ line, field: "formatVersion" },
		);
	}
	return {
		format: CASSETTE_FORMAT,
		formatVersion: CASSETTE_FORMAT_VERSION,
		createdAt: need(value.createdAt, line, "createdAt"),
		producer: need(value.producer, line, "producer"),
		providerId: need(value.providerId, line, "providerId"),
		model: need(value.model, line, "model"),
	};
}

function parseCall(value: unknown, line: number, field: string): ToolCallRef {
	if (!isRecord(value)) throw fail("expected a tool call object", { line, field });
	if (!("input" in value)) throw fail("missing required field", { line, field: `${field}.input` });
	return {
		callId: need(value.callId, line, `${field}.callId`) as ToolCallRef["callId"],
		toolName: need(value.toolName, line, `${field}.toolName`),
		input: value.input,
	};
}

function parseMessage(value: unknown, line: number, field: string): ModelMessage {
	if (!isRecord(value)) throw fail("expected a message object", { line, field });
	const role = need(value.role, line, `${field}.role`);
	if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
		throw fail(`unknown message role "${role}"`, { line, field: `${field}.role` });
	}
	const message: {
		role: ModelMessage["role"];
		content: string;
		toolCallId?: ModelMessage["toolCallId"];
		toolCalls?: readonly ToolCallRef[];
	} = { role, content: need(value.content, line, `${field}.content`) };
	if (value.toolCallId !== undefined) {
		message.toolCallId = need(
			value.toolCallId,
			line,
			`${field}.toolCallId`,
		) as ModelMessage["toolCallId"];
	}
	if (value.toolCalls !== undefined) {
		if (!Array.isArray(value.toolCalls)) {
			throw fail("expected an array of tool calls", { line, field: `${field}.toolCalls` });
		}
		message.toolCalls = value.toolCalls.map((call, index) =>
			parseCall(call, line, `${field}.toolCalls[${index}]`),
		);
	}
	return message;
}

function parseDescriptor(value: unknown, line: number, field: string): ToolDescriptor {
	if (!isRecord(value)) throw fail("expected a tool descriptor object", { line, field });
	if (value.type !== "function") {
		throw fail(`unsupported tool type "${String(value.type)}"`, { line, field: `${field}.type` });
	}
	if (!isRecord(value.function)) {
		throw fail("expected a function descriptor object", { line, field: `${field}.function` });
	}
	const fn = value.function;
	if (!isRecord(fn.parameters)) {
		throw fail("expected a parameters object", { line, field: `${field}.function.parameters` });
	}
	return {
		type: "function",
		function: {
			name: need(fn.name, line, `${field}.function.name`),
			description: need(fn.description, line, `${field}.function.description`),
			parameters: fn.parameters,
		},
	};
}

function parseRequest(value: unknown, line: number): CassetteRequest {
	if (!isRecord(value)) throw fail("request must be a JSON object", { line, field: "request" });
	if (!Array.isArray(value.messages)) {
		throw fail("expected an array of messages", { line, field: "request.messages" });
	}
	const request: {
		model: string;
		messages: readonly ModelMessage[];
		tools?: readonly ToolDescriptor[];
		temperature?: number;
	} = {
		model: need(value.model, line, "request.model"),
		messages: value.messages.map((message, index) =>
			parseMessage(message, line, `request.messages[${index}]`),
		),
	};
	if (value.tools !== undefined) {
		if (!Array.isArray(value.tools)) {
			throw fail("expected an array of tool descriptors", { line, field: "request.tools" });
		}
		request.tools = value.tools.map((tool, index) =>
			parseDescriptor(tool, line, `request.tools[${index}]`),
		);
	}
	if (value.temperature !== undefined) {
		if (typeof value.temperature !== "number" || !Number.isFinite(value.temperature)) {
			throw fail("expected a finite number", { line, field: "request.temperature" });
		}
		request.temperature = value.temperature;
	}
	return request;
}

function parseUsage(value: unknown, line: number, field: string): LlmUsage {
	if (!isRecord(value)) throw fail("expected a usage object", { line, field });
	const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	for (const key of ["promptTokens", "completionTokens", "totalTokens"] as const) {
		const raw = value[key];
		if (typeof raw !== "number" || !Number.isFinite(raw)) {
			throw fail("expected a finite number", { line, field: `${field}.${key}` });
		}
		usage[key] = raw;
	}
	return usage;
}

function parseEvent(value: unknown, line: number, field: string): LlmStreamEvent {
	if (!isRecord(value)) throw fail("expected a stream event object", { line, field });
	switch (value.kind) {
		case "text-delta":
			return { kind: "text-delta", text: need(value.text, line, `${field}.text`) };
		case "usage":
			return { kind: "usage", usage: parseUsage(value.usage, line, `${field}.usage`) };
		case "done": {
			if (!isRecord(value.message)) {
				throw fail("expected a final message object", { line, field: `${field}.message` });
			}
			const message = value.message;
			if (!Array.isArray(message.toolCalls)) {
				throw fail("expected an array of tool calls", {
					line,
					field: `${field}.message.toolCalls`,
				});
			}
			const stopReason = need(message.stopReason, line, `${field}.message.stopReason`);
			if (!STOP_REASONS.includes(stopReason as StopReason)) {
				throw fail(`unknown stopReason "${stopReason}"`, {
					line,
					field: `${field}.message.stopReason`,
				});
			}
			return {
				kind: "done",
				message: {
					content: need(message.content, line, `${field}.message.content`),
					toolCalls: message.toolCalls.map((call, index) =>
						parseCall(call, line, `${field}.message.toolCalls[${index}]`),
					),
					stopReason: stopReason as StopReason,
				},
			};
		}
		default:
			throw fail(`unknown stream event kind "${String(value.kind)}"`, {
				line,
				field: `${field}.kind`,
			});
	}
}

function parseExchange(value: unknown, line: number): CassetteExchange {
	if (!isRecord(value)) throw fail("exchange must be a JSON object", { line });
	if (value.kind !== "exchange") {
		throw fail(`expected kind "exchange", got "${String(value.kind)}"`, { line, field: "kind" });
	}
	if (typeof value.index !== "number" || !Number.isInteger(value.index) || value.index < 0) {
		throw fail("expected a non-negative integer", { line, field: "index" });
	}
	const request = parseRequest(value.request, line);
	const requestKey = need(value.requestKey, line, "requestKey");
	const expectedKey = requestKeyOf(request);
	if (requestKey !== expectedKey) {
		throw fail(
			`cassette tampered: requestKey does not match the recorded request (expected ${expectedKey.slice(0, 12)}...)`,
			{ line, field: "requestKey" },
		);
	}
	if (!Array.isArray(value.events)) {
		throw fail("expected an array of stream events", { line, field: "events" });
	}
	if (typeof value.complete !== "boolean") {
		throw fail("expected a boolean", { line, field: "complete" });
	}
	const error = value.error === undefined ? undefined : need(value.error, line, "error");
	if (value.complete && error !== undefined) {
		throw fail("complete exchange must not carry an error", { line, field: "error" });
	}
	return {
		kind: "exchange",
		index: value.index,
		request,
		requestKey,
		events: value.events.map((event, index) => parseEvent(event, line, `events[${index}]`)),
		complete: value.complete,
		...(error === undefined ? {} : { error }),
	};
}

/**
 * 解析一份 cassette 文本（严格）。
 *
 * 容忍首个 UTF-8 BOM 与空行（Windows 记事本 / PowerShell 会写 BOM）；
 * 其余任何漂移都抛 `CassetteError`，且**行号是物理行号**（含空行，便于对照原文件）。
 */
export function loadCassette(text: string): CassetteDocument {
	const rawLines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split(/\r?\n/);
	let header: CassetteHeader | undefined;
	const exchanges: CassetteExchange[] = [];

	for (let index = 0; index < rawLines.length; index += 1) {
		const raw = rawLines[index] ?? "";
		if (raw.trim() === "") continue;
		const line = index + 1;
		const value = parseJson(raw, line);
		if (header === undefined) header = parseHeader(value, line);
		else exchanges.push(parseExchange(value, line));
	}
	if (header === undefined) {
		throw new CassetteError("missing cassette header: the first non-empty line must be the header");
	}
	exchanges.forEach((exchange, position) => {
		if (exchange.index !== position) {
			throw fail(`exchange index ${exchange.index} is out of order (expected ${position})`, {
				field: "index",
			});
		}
	});
	return { header, exchanges };
}
