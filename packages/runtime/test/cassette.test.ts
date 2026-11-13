/**
 * M19 单测（ADR-037）：cassette 的格式 / 请求哈希 / 严格解析，以及录制 / 回放装饰器。
 *
 * 全程 keyless、零网络：内层用 stub provider，文件 IO 不参与（本模块**不 import fs**）。
 */
import type { ModelMessage, ToolDescriptor } from "@aster/schema";
import { describe, expect, it } from "vitest";
import {
	CASSETTE_FORMAT,
	CASSETTE_FORMAT_VERSION,
	type CassetteDocument,
	CassetteError,
	type CassetteExchange,
	canonicalJson,
	createCassetteHeader,
	createRecordingProvider,
	createReplayProvider,
	createStubProvider,
	type LlmProvider,
	type LlmRequest,
	type LlmStreamEvent,
	loadCassette,
	requestKeyOf,
	type StubScript,
	serializeCassette,
	serializeCassetteExchange,
	serializeCassetteHeader,
} from "../src/llm/index.js";

const user = (content: string): ModelMessage => ({ role: "user", content });

const readTool: ToolDescriptor = {
	type: "function",
	function: {
		name: "read",
		description: "read a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
};

async function collect(provider: LlmProvider, request: LlmRequest): Promise<LlmStreamEvent[]> {
	const events: LlmStreamEvent[] = [];
	for await (const event of provider.stream(request)) events.push(event);
	return events;
}

function documentOf(exchanges: readonly CassetteExchange[], model = "m"): CassetteDocument {
	return {
		header: createCassetteHeader({
			providerId: "stub",
			model,
			createdAt: "2026-01-01T00:00:00.000Z",
		}),
		exchanges,
	};
}

function capture(): {
	onExchange: (exchange: CassetteExchange) => void;
	exchanges: CassetteExchange[];
} {
	const exchanges: CassetteExchange[] = [];
	return { exchanges, onExchange: (exchange) => void exchanges.push(exchange) };
}

function loadError(text: string): CassetteError {
	let caught: unknown;
	try {
		loadCassette(text);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(CassetteError);
	return caught as CassetteError;
}

describe("M19 录制 -> 回放", () => {
	it("事件序列逐条深等（text-delta 分片 / usage / toolCalls / stopReason）", async () => {
		const script: StubScript = {
			chunks: ["he", "llo"],
			usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
			toolCalls: [
				{ callId: "call_1" as never, toolName: "read", input: { path: "note.txt", limit: 2 } },
			],
			stopReason: "tool_call",
		};
		const sink = capture();
		const recorder = createRecordingProvider(createStubProvider(script), sink);
		const request: LlmRequest = {
			model: "m",
			messages: [user("hi")],
			tools: [readTool],
			temperature: 0.2,
		};

		const recordedEvents = await collect(recorder, request);
		expect(sink.exchanges).toHaveLength(1);
		const exchange = sink.exchanges[0] as CassetteExchange;
		expect(exchange.complete).toBe(true);
		expect(exchange.error).toBeUndefined();
		expect(exchange.requestKey).toBe(requestKeyOf(exchange.request));
		expect(exchange.events).toEqual(recordedEvents);

		const replay = createReplayProvider(
			loadCassette(serializeCassette(documentOf(sink.exchanges))),
		);
		expect(replay.id).toBe("cassette-replay");
		const replayed = await collect(replay, request);
		expect(replayed).toEqual(recordedEvents);
		expect(replay.consumed).toBe(1);
		expect(replay.remaining).toBe(0);
	});

	it("同一 requestKey 多次出现按 FIFO 消费", async () => {
		const sink = capture();
		const recorder = createRecordingProvider(
			createStubProvider([{ content: "one" }, { content: "two" }]),
			sink,
		);
		const request: LlmRequest = { model: "m", messages: [user("same")] };
		await collect(recorder, request);
		await collect(recorder, request);

		const replay = createReplayProvider(
			loadCassette(serializeCassette(documentOf(sink.exchanges))),
		);
		const first = await collect(replay, request);
		const second = await collect(replay, request);
		expect(first.at(-1)).toEqual({
			kind: "done",
			message: expect.objectContaining({ content: "one" }),
		});
		expect(second.at(-1)).toEqual({
			kind: "done",
			message: expect.objectContaining({ content: "two" }),
		});
		expect(replay.consumed).toBe(2);
		expect(replay.remaining).toBe(0);
	});

	it("未命中 / 队列耗尽：可读 cassette mismatch（含 key 前 12 位、消息数、角色预览、工具、剩余数）", async () => {
		const sink = capture();
		const recorder = createRecordingProvider(createStubProvider({ content: "hi" }), sink);
		await collect(recorder, { model: "m", messages: [user("recorded prompt")], tools: [readTool] });
		const replay = createReplayProvider(
			loadCassette(serializeCassette(documentOf(sink.exchanges))),
		);

		const different: LlmRequest = {
			model: "m",
			messages: [user("system? no"), user("a different prompt")],
			tools: [readTool],
		};
		const key = requestKeyOf({
			model: different.model,
			messages: different.messages,
			tools: different.tools,
		});
		let caught: unknown;
		try {
			await collect(replay, different);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CassetteError);
		const message = (caught as CassetteError).message;
		expect(message).toContain("cassette mismatch");
		expect(message).toContain(key.slice(0, 12));
		expect(message).toContain("messages=2");
		expect(message).toContain("last=user: a different prompt");
		expect(message).toContain("tools=[read]");
		expect(message).toContain("1 exchange(s) remaining");
		expect(message).toContain("cwd / mode");

		// 同一 key 第二次消费时队列已耗尽
		const same: LlmRequest = { model: "m", messages: [user("recorded prompt")], tools: [readTool] };
		await collect(replay, same);
		await expect(collect(replay, same)).rejects.toThrow(/cassette mismatch/);
	});

	it("consumer 提前中止：记已收到事件 + complete:false，不伪造 error，且只回调一次", async () => {
		const sink = capture();
		const recorder = createRecordingProvider(
			createStubProvider({ chunks: ["a", "b", "c"], content: "abc" }),
			sink,
		);
		const seen: LlmStreamEvent[] = [];
		for await (const event of recorder.stream({ model: "m", messages: [user("stop")] })) {
			seen.push(event);
			if (seen.length === 1) break;
		}
		expect(sink.exchanges).toHaveLength(1);
		const exchange = sink.exchanges[0] as CassetteExchange;
		expect(exchange.complete).toBe(false);
		expect(exchange.error).toBeUndefined();
		expect(exchange.events).toEqual([{ kind: "text-delta", text: "a" }]);
	});

	it("onExchange 抛错 fail-fast（录制是显式动作，磁盘错误必须可见）", async () => {
		const recorder = createRecordingProvider(createStubProvider({ content: "x" }), {
			onExchange: () => {
				throw new Error("disk full");
			},
		});
		await expect(collect(recorder, { model: "m", messages: [user("hi")] })).rejects.toThrow(
			"disk full",
		);
	});

	it("内层抛错：原始 message 记进 error 并原样重抛；回放先 yield 已记录事件再抛同一 message", async () => {
		async function* failing(): AsyncGenerator<LlmStreamEvent> {
			yield { kind: "text-delta", text: "partial" };
			throw new Error("upstream exploded");
		}
		const inner: LlmProvider = { id: "failing", stream: () => failing() };
		const sink = capture();
		const recorder = createRecordingProvider(inner, sink);
		const request: LlmRequest = { model: "m", messages: [user("boom")] };
		await expect(collect(recorder, request)).rejects.toThrow("upstream exploded");

		expect(sink.exchanges).toHaveLength(1);
		const exchange = sink.exchanges[0] as CassetteExchange;
		expect(exchange.complete).toBe(false);
		expect(exchange.error).toBe("upstream exploded");
		expect(exchange.events).toEqual([{ kind: "text-delta", text: "partial" }]);

		const replay = createReplayProvider(
			loadCassette(serializeCassette(documentOf(sink.exchanges))),
		);
		const seen: LlmStreamEvent[] = [];
		let message = "";
		try {
			for await (const event of replay.stream(request)) seen.push(event);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(seen).toEqual([{ kind: "text-delta", text: "partial" }]);
		expect(message).toBe("upstream exploded");
	});

	it("录制请求不含 signal；cassette 文本不含任何密钥串", async () => {
		const secret = "sk-aster-m19-LOCAL-ONLY-7f3a9c";
		const sink = capture();
		const recorder = createRecordingProvider(createStubProvider({ content: "ok" }), sink);
		const controller = new AbortController();
		await collect(recorder, {
			model: "m",
			messages: [user("hi")],
			signal: controller.signal,
		});
		const exchange = sink.exchanges[0] as CassetteExchange;
		expect("signal" in exchange.request).toBe(false);
		expect(Object.keys(exchange.request)).toEqual(["model", "messages"]);
		const text = serializeCassette(documentOf(sink.exchanges));
		expect(text).not.toContain(secret);
		expect(text).not.toContain("signal");
	});
});

describe("M19 cassette 格式与严格解析", () => {
	it("canonicalJson：键序无关、数组保序", () => {
		const a = {
			model: "m",
			messages: [{ role: "user", content: "x" }],
			tools: [
				{
					type: "function",
					function: {
						name: "read",
						description: "d",
						parameters: { type: "object", properties: { a: { type: "string" } } },
					},
				},
			],
			temperature: 0.1,
		};
		const b = {
			temperature: 0.1,
			tools: [
				{
					function: {
						parameters: { properties: { a: { type: "string" } }, type: "object" },
						description: "d",
						name: "read",
					},
					type: "function",
				},
			],
			messages: [{ content: "x", role: "user" }],
			model: "m",
		};
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(requestKeyOf(a)).toBe(requestKeyOf(b));
		// 数组顺序是内容的一部分
		expect(requestKeyOf({ model: "m", messages: [user("1"), user("2")] })).not.toBe(
			requestKeyOf({ model: "m", messages: [user("2"), user("1")] }),
		);
	});

	it("版本门禁：v0 / 999 / 错 format 一律 CassetteError", () => {
		const exchange = { kind: "exchange" } as unknown as CassetteExchange;
		const header = createCassetteHeader({ providerId: "stub", model: "m" });
		const base = { ...header, createdAt: "2026-01-01T00:00:00.000Z" };
		const body = serializeCassetteExchange({
			...exchange,
			index: 0,
			request: { model: "m", messages: [] },
			requestKey: requestKeyOf({ model: "m", messages: [] }),
			events: [],
			complete: false,
		});
		loadError(`${JSON.stringify({ ...base, formatVersion: 0 })}\n${body}`);
		expect(loadError(`${JSON.stringify({ ...base, formatVersion: 999 })}\n${body}`).field).toBe(
			"formatVersion",
		);
		const wrongFormat = loadError(`${JSON.stringify({ ...base, format: "other" })}\n${body}`);
		expect(wrongFormat.field).toBe("format");
		expect(wrongFormat.message).toContain(CASSETTE_FORMAT);
		expect(loadError("").message).toContain("missing cassette header");
	});

	it("容忍首个 BOM 与空行；坏 JSON 报物理行号", () => {
		const ok = loadCassette(`\uFEFF\n\n${serializeCassette(documentOf([]))}`);
		expect(ok.header.formatVersion).toBe(CASSETTE_FORMAT_VERSION);
		expect(ok.exchanges).toEqual([]);

		const bad = loadError(`${serializeCassetteHeader(documentOf([]).header)}\n{broken json`);
		expect(bad.line).toBe(3);
	});

	it("非 exchange 行 / 缺字段 / complete 与 error 并存都报行号 + 字段", () => {
		const header = serializeCassetteHeader(documentOf([]).header);
		const notExchange = loadError(`${header}${JSON.stringify({ kind: "note" })}`);
		expect(notExchange.line).toBe(2);
		expect(notExchange.field).toBe("kind");

		const exchange = {
			kind: "exchange",
			index: 0,
			request: { model: "m", messages: [] },
			events: [],
			complete: true,
		};
		const missingKey = loadError(`${header}${JSON.stringify(exchange)}`);
		expect(missingKey.field).toBe("requestKey");
		expect(missingKey.line).toBe(2);

		const withError = loadError(
			`${header}${JSON.stringify({
				...exchange,
				requestKey: requestKeyOf({ model: "m", messages: [] }),
				error: "boom",
			})}`,
		);
		expect(withError.field).toBe("error");
	});

	it("requestKey 被篡改（请求与存储哈希不符）报 cassette tampered 且带行号", () => {
		const request = { model: "m", messages: [user("ask me")] };
		const exchange: CassetteExchange = {
			kind: "exchange",
			index: 0,
			request,
			requestKey: requestKeyOf(request),
			events: [],
			complete: false,
		};
		const text = serializeCassette(documentOf([exchange])).replace("ask me", "hacked");
		const error = loadError(text);
		expect(error.message).toContain("tampered");
		expect(error.line).toBe(2);
		expect(error.field).toBe("requestKey");
	});

	it("缺失 header / 错 format 的错误信息不含任何被解析出的值（不可回显密钥）", () => {
		const secret = "sk-aster-m19-SECRET-123";
		const error = loadError(JSON.stringify({ format: secret }));
		expect(error.message).not.toContain(secret);
	});
});
