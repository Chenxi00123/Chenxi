/**
 * llm 模块单测：**全程 keyless、不访问外网**。
 *
 * 用 `node:http` 在 127.0.0.1 起本地服务器回放可控 SSE，把 `fetchImpl` 指过去；
 * stub provider 则完全不碰网络。
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { ModelMessage } from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmFinalMessage, LlmProvider, LlmRequest, LlmStreamEvent } from "../src/llm/index.js";
import {
	createOpenAiCompatibleProvider,
	createStubProvider,
	LlmConfigError,
	resolveLlmConfig,
} from "../src/llm/index.js";

const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

/** 起一个 127.0.0.1 本地服务器，返回其 baseUrl。 */
async function startServer(handler: (res: ServerResponse) => void): Promise<string> {
	const server = createServer((_req, res) => {
		handler(res);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("expected a TCP address");
	}
	return `http://127.0.0.1:${address.port}`;
}

/** 写一条 SSE data 帧。 */
function sse(res: ServerResponse, payload: string): void {
	res.write(`data: ${payload}\n\n`);
}

const userMessage: ModelMessage = { role: "user", content: "hi" };

async function collect(provider: LlmProvider, request: LlmRequest): Promise<LlmStreamEvent[]> {
	const events: LlmStreamEvent[] = [];
	for await (const event of provider.stream(request)) {
		events.push(event);
	}
	return events;
}

function lastDone(events: LlmStreamEvent[]): LlmFinalMessage {
	const last = events.at(-1);
	if (last === undefined || last.kind !== "done") {
		throw new Error("expected the stream to end with a `done` event");
	}
	return last.message;
}

function textDeltas(events: LlmStreamEvent[]): string[] {
	return events.filter((e) => e.kind === "text-delta").map((e) => e.text);
}

describe("resolveLlmConfig", () => {
	it("缺 ASTER_API_KEY / ASTER_MODEL 时抛 LlmConfigError 且 missing 正确", () => {
		let caught: unknown;
		try {
			resolveLlmConfig({ ASTER_BASE_URL: "https://api.example.com/v1" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(LlmConfigError);
		const err = caught as LlmConfigError;
		expect(err.name).toBe("LlmConfigError");
		expect([...err.missing]).toEqual(["ASTER_API_KEY", "ASTER_MODEL"]);
	});

	it("错误文本绝不包含已提供的 key 值", () => {
		const secret = "SUPER-SECRET-KEY-9182736450";
		let caught: unknown;
		try {
			resolveLlmConfig({ ASTER_BASE_URL: "https://api.example.com", ASTER_API_KEY: secret });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(LlmConfigError);
		const err = caught as LlmConfigError;
		expect([...err.missing]).toEqual(["ASTER_MODEL"]);
		expect(err.message).not.toContain(secret);
		expect(JSON.stringify(err.missing)).not.toContain(secret);
	});

	it("空串视为缺失", () => {
		let caught: unknown;
		try {
			resolveLlmConfig({
				ASTER_BASE_URL: "https://api.example.com",
				ASTER_API_KEY: "   ",
				ASTER_MODEL: "m",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(LlmConfigError);
		expect([...(caught as LlmConfigError).missing]).toEqual(["ASTER_API_KEY"]);
	});

	it("完整 env -> baseUrl 去掉尾部斜杠", () => {
		const config = resolveLlmConfig({
			ASTER_BASE_URL: "https://api.example.com/v1///",
			ASTER_API_KEY: "sk-local-only",
			ASTER_MODEL: "gpt-4o-mini",
		});
		expect(config.baseUrl).toBe("https://api.example.com/v1");
		expect(config.apiKey).toBe("sk-local-only");
		expect(config.defaultModel).toBe("gpt-4o-mini");
	});
});

describe("createOpenAiCompatibleProvider", () => {
	it("正常流式：delta 顺序正确（含 null content 与跨 chunk 断行）", async () => {
		const baseUrl = await startServer((res) => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.flushHeaders();
			sse(res, '{"choices":[{"delta":{"content":"Hello"}}]}');
			sse(res, '{"choices":[{"delta":{"content":null}}]}');
			// 跨 chunk 断行：这一行被拆成两次 write，中间在 JSON 正文字符串内断开。
			res.write('data: {"choices":[{"delta":{"content":" ');
			res.write('world"}}]}\n\n');
			sse(res, '{"choices":[{"delta":{},"finish_reason":"stop"}]}');
			res.write("data: [DONE]\n\n");
			res.end();
		});

		const provider = createOpenAiCompatibleProvider({
			baseUrl,
			apiKey: "sk-local-only",
			defaultModel: "m",
			fetchImpl: fetch,
		});
		expect(provider.id).toBe("openai-compatible");

		const events = await collect(provider, { model: "m", messages: [userMessage] });

		expect(textDeltas(events)).toEqual(["Hello", " world"]);
		expect(events.filter((e) => e.kind === "usage")).toHaveLength(0);
		expect(lastDone(events)).toEqual({
			content: "Hello world",
			toolCalls: [],
			stopReason: "end_turn",
		});
	});

	it("usage chunk -> 字段正确映射为 LlmUsage", async () => {
		const baseUrl = await startServer((res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, '{"choices":[{"delta":{"content":"hi"}}]}');
			sse(
				res,
				'{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
			);
			sse(res, '{"choices":[{"delta":{},"finish_reason":"stop"}]}');
			res.write("data: [DONE]\n\n");
			res.end();
		});

		const provider = createOpenAiCompatibleProvider({
			baseUrl,
			apiKey: "sk-local-only",
			defaultModel: "m",
		});
		const events = await collect(provider, { model: "m", messages: [userMessage] });

		const usageEvents = events.filter((e) => e.kind === "usage");
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]?.usage).toEqual({
			promptTokens: 11,
			completionTokens: 7,
			totalTokens: 18,
		});
		expect(lastDone(events).content).toBe("hi");
	});

	it('finish_reason="length" -> stopReason="length"', async () => {
		const baseUrl = await startServer((res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, '{"choices":[{"delta":{"content":"truncated"}}]}');
			sse(res, '{"choices":[{"delta":{},"finish_reason":"length"}]}');
			res.write("data: [DONE]\n\n");
			res.end();
		});

		const provider = createOpenAiCompatibleProvider({
			baseUrl,
			apiKey: "sk-local-only",
			defaultModel: "m",
		});
		const events = await collect(provider, { model: "m", messages: [userMessage] });
		expect(lastDone(events).stopReason).toBe("length");
	});

	it("聚合分片 tool_calls（参数 JSON 字符串拼接后解析）", async () => {
		const baseUrl = await startServer((res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(
				res,
				'{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}',
			);
			sse(
				res,
				'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}',
			);
			sse(res, '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
			res.write("data: [DONE]\n\n");
			res.end();
		});

		const provider = createOpenAiCompatibleProvider({
			baseUrl,
			apiKey: "sk-local-only",
			defaultModel: "m",
		});
		const events = await collect(provider, { model: "m", messages: [userMessage] });
		const message = lastDone(events);
		expect(message.stopReason).toBe("tool_call");
		expect(message.toolCalls).toHaveLength(1);
		expect(message.toolCalls[0]?.callId).toBe("call_1");
		expect(message.toolCalls[0]?.toolName).toBe("read");
		expect(message.toolCalls[0]?.input).toEqual({ path: "a.txt" });
	});

	it("HTTP 401：抛错、含状态码，且经脱敏不回显 key", async () => {
		const apiKey = "SUPER-SECRET-API-KEY-1234567890";
		const baseUrl = await startServer((res) => {
			res.writeHead(401, { "content-type": "text/plain" });
			res.end(`unauthorized: Bearer ${apiKey} rejected; leaked sk-live-ABCDEF123`);
		});

		const provider = createOpenAiCompatibleProvider({ baseUrl, apiKey, defaultModel: "m" });

		let message = "";
		try {
			await collect(provider, { model: "m", messages: [userMessage] });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("401");
		expect(message).not.toContain(apiKey);
		expect(message).not.toContain("sk-live-ABCDEF123");
		expect(message).not.toContain("Bearer ");
	});

	it("AbortSignal 中止 -> 流提前结束并抛错（不悬挂）", async () => {
		const baseUrl = await startServer((res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, '{"choices":[{"delta":{"content":"first"}}]}');
			// 故意不发 [DONE] 也不 end：连接保持打开，等待客户端 abort。
		});

		const provider = createOpenAiCompatibleProvider({
			baseUrl,
			apiKey: "sk-local-only",
			defaultModel: "m",
		});
		const controller = new AbortController();

		await expect(
			(async () => {
				for await (const event of provider.stream({
					model: "m",
					messages: [userMessage],
					signal: controller.signal,
				})) {
					if (event.kind === "text-delta") controller.abort();
				}
			})(),
		).rejects.toThrow();
	});
});

describe("createStubProvider", () => {
	it("单脚本按序 yield，并记录 request", async () => {
		const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
		const provider = createStubProvider({
			chunks: ["foo", "bar"],
			usage,
			stopReason: "end_turn",
		});
		expect(provider.id).toBe("stub");

		const request: LlmRequest = { model: "m", messages: [userMessage] };
		const events = await collect(provider, request);

		expect(textDeltas(events)).toEqual(["foo", "bar"]);
		expect(events.filter((e) => e.kind === "usage")).toHaveLength(1);
		expect(lastDone(events)).toEqual({ content: "foobar", toolCalls: [], stopReason: "end_turn" });
		expect(provider.calls).toEqual([request]);
	});

	it("无 chunks 时把 content 一次性发出", async () => {
		const provider = createStubProvider({ content: "solo" });
		const events = await collect(provider, { model: "m", messages: [userMessage] });
		expect(textDeltas(events)).toEqual(["solo"]);
		expect(lastDone(events).content).toBe("solo");
	});

	it("数组脚本：第 2 次调用取第 2 个", async () => {
		const provider = createStubProvider([
			{ content: "one", stopReason: "end_turn" },
			{ content: "two", stopReason: "length" },
		]);

		expect(lastDone(await collect(provider, { model: "m", messages: [userMessage] })).content).toBe(
			"one",
		);
		expect(lastDone(await collect(provider, { model: "m", messages: [userMessage] })).content).toBe(
			"two",
		);
		expect(provider.calls).toHaveLength(2);
	});

	it("取尽后抛错", async () => {
		const provider = createStubProvider([{ content: "only" }]);
		await collect(provider, { model: "m", messages: [userMessage] });
		await expect(collect(provider, { model: "m", messages: [userMessage] })).rejects.toThrow(
			/exhaust/i,
		);
	});
});
