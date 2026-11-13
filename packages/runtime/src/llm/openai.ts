/**
 * OpenAI 兼容的流式 provider（ADR-001）。
 *
 * 只实现一条 chat/completions 流式路径：
 *   POST `${baseUrl}/chat/completions`（body: model/messages/stream/temperature?）
 *   -> 解析 SSE -> 产出 `text-delta` / `usage` / `done`。
 *
 * 安全纪律（README 环境变量契约）：任何错误信息都要**脱敏**——
 * 抹掉 `Bearer <token>` / `sk-...` 形态的密钥串，并且绝不回显 `config.apiKey`。
 */
import type { ModelMessage, StopReason, ToolCallId, ToolCallRef } from "@aster/schema";
import type {
	LlmProvider,
	LlmProviderConfig,
	LlmRequest,
	LlmStreamEvent,
	LlmUsage,
} from "./types.js";

const PROVIDER_ID = "openai-compatible";

/** `Bearer <token>`（token 到空白/引号为止）与 `sk-...` 两种常见泄漏形态。 */
const BEARER_RE = /Bearer\s+[^\s"']+/gi;
const SK_RE = /sk-[A-Za-z0-9._-]+/gi;

/**
 * 脱敏：移除密钥串形态，并用已知 `secret` 做兜底全量替换。
 * 正则与 `split/join` 都不做正则转义假设，`secret` 以字面量替换，避免 `$` 等被当替换模板。
 */
export function redact(text: string, secret?: string | undefined): string {
	let out = text.replace(BEARER_RE, "[REDACTED]").replace(SK_RE, "[REDACTED]");
	if (secret !== undefined && secret !== "") {
		out = out.split(secret).join("[REDACTED]");
	}
	return out;
}

/** OpenAI 流式分片的宽松形状（只声明我们用得到的字段）。 */
interface OpenAiToolCallDelta {
	readonly index?: number;
	readonly id?: string;
	readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface OpenAiDelta {
	readonly content?: string | null;
	readonly tool_calls?: readonly OpenAiToolCallDelta[];
}

interface OpenAiChoice {
	readonly delta?: OpenAiDelta;
	readonly finish_reason?: string | null;
}

interface OpenAiUsage {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
	readonly total_tokens?: number;
}

interface OpenAiChunk {
	readonly choices?: readonly OpenAiChoice[];
	readonly usage?: OpenAiUsage | null;
}

/** 把投影后的模型消息映射为 OpenAI 的 messages 数组。 */
function toOpenAiMessages(messages: readonly ModelMessage[]): unknown[] {
	return messages.map((message) => {
		if (
			message.role === "assistant" &&
			message.toolCalls !== undefined &&
			message.toolCalls.length > 0
		) {
			return {
				role: "assistant",
				content: message.content,
				tool_calls: message.toolCalls.map((call) => ({
					id: call.callId,
					type: "function",
					function: {
						name: call.toolName,
						arguments:
							typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}),
					},
				})),
			};
		}
		if (message.role === "tool") {
			return {
				role: "tool",
				content: message.content,
				...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
			};
		}
		return { role: message.role, content: message.content };
	});
}

/** 逐行切分浏览器/Node 的字节流：chunk 会在任意字节处断开，必须按行缓冲。 */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				yield buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) yield buffer;
	} finally {
		reader.releaseLock();
	}
}

function mapFinishReason(reason: string | null | undefined): StopReason {
	switch (reason) {
		case "stop":
			return "end_turn";
		case "tool_calls":
			return "tool_call";
		case "length":
			return "length";
		default:
			return "error";
	}
}

function mapUsage(usage: OpenAiUsage): LlmUsage {
	return {
		promptTokens: usage.prompt_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
		totalTokens: usage.total_tokens ?? 0,
	};
}

async function readErrorBody(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

/** 按 `index` 聚合分散的 tool_call 增量。 */
interface ToolCallAccumulator {
	id: string;
	name: string;
	args: string;
}

export function createOpenAiCompatibleProvider(config: LlmProviderConfig): LlmProvider {
	const fetchImpl = config.fetchImpl ?? fetch;

	async function* iterate(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
		const endpoint = `${config.baseUrl}/chat/completions`;
		const body: Record<string, unknown> = {
			model: request.model,
			messages: toOpenAiMessages(request.messages),
			stream: true,
		};
		if (request.tools !== undefined && request.tools.length > 0) {
			body.tools = request.tools;
		}
		if (request.temperature !== undefined) body.temperature = request.temperature;

		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(body),
			...(request.signal !== undefined ? { signal: request.signal } : {}),
		});

		if (!response.ok) {
			const rawText = await readErrorBody(response);
			const detail = redact(rawText.trim().slice(0, 500), config.apiKey);
			const statusText = response.statusText !== "" ? ` ${response.statusText}` : "";
			throw new Error(`LLM request failed with HTTP ${response.status}${statusText}: ${detail}`);
		}

		const streamBody = response.body;
		if (streamBody === null) {
			throw new Error("LLM response has no readable body");
		}

		let content = "";
		let finishReason: string | null | undefined;
		const accumulators = new Map<number, ToolCallAccumulator>();

		for await (const rawLine of readLines(streamBody)) {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data === "") continue;
			if (data === "[DONE]") break;

			let chunk: OpenAiChunk;
			try {
				chunk = JSON.parse(data) as OpenAiChunk;
			} catch {
				continue;
			}

			const choice = chunk.choices?.[0];
			if (choice !== undefined) {
				const delta = choice.delta;
				if (delta !== undefined) {
					// content 可能是 null（OpenAI 在某些分片给 null）——必须跳过。
					if (typeof delta.content === "string" && delta.content.length > 0) {
						content += delta.content;
						yield { kind: "text-delta", text: delta.content };
					}
					if (delta.tool_calls !== undefined) {
						for (const part of delta.tool_calls) {
							const index = part.index ?? 0;
							const acc = accumulators.get(index) ?? { id: "", name: "", args: "" };
							if (typeof part.id === "string") acc.id += part.id;
							if (part.function !== undefined) {
								if (typeof part.function.name === "string") acc.name += part.function.name;
								if (typeof part.function.arguments === "string") {
									acc.args += part.function.arguments;
								}
							}
							accumulators.set(index, acc);
						}
					}
				}
				if (choice.finish_reason !== undefined) {
					finishReason = choice.finish_reason;
				}
			}

			if (chunk.usage !== undefined && chunk.usage !== null) {
				yield { kind: "usage", usage: mapUsage(chunk.usage) };
			}
		}

		const toolCalls: ToolCallRef[] = [];
		for (const index of [...accumulators.keys()].sort((a, b) => a - b)) {
			const acc = accumulators.get(index);
			if (acc === undefined) continue;
			let input: unknown = acc.args;
			if (acc.args !== "") {
				try {
					input = JSON.parse(acc.args);
				} catch {
					// 解析失败：置为原始字符串（保留证据，不丢内容）。
					input = acc.args;
				}
			}
			toolCalls.push({
				callId: acc.id as ToolCallId,
				toolName: acc.name,
				input,
			});
		}

		yield {
			kind: "done",
			message: { content, toolCalls, stopReason: mapFinishReason(finishReason) },
		};
	}

	return {
		id: PROVIDER_ID,
		stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
			return iterate(request);
		},
	};
}
