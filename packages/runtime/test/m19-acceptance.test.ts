/**
 * M19 验收测试（ADR-037）：**录制一次真实流式会话，再完全离线回放**。
 *
 * 用 `node:http` 起本地 OpenAI-compatible SSE 服务器（与 llm.test.ts 同一模式）；
 * 录制会话 = 真实的 `runSessionRepl` + 真实 4 原语工具，工具闭环是 `read` 读临时 workspace 里的 note.txt。
 * 回放会话 = 同一 cwd / 同一 prompt / 同一工具集，只把 provider 换成 `createReplayProvider`。
 *
 * 断言：
 *  - 录制期间服务器恰好 2 次请求，回放期间 **0 次**（回放不发网络请求）；
 *  - 两个会话的事件序列（去掉 session/start、session/end，去掉每条 sessionId/at，
 *    tool/result 的 durationMs 归零）**逐字段深等**；
 *  - cassette 文本含 text-delta 分片 / usage / stopReason / toolCalls 的 input，且**不含测试密钥**。
 *
 * 全程 keyless / 不碰外网 / 不写 C 盘（临时目录走 `helpers/tmp.ts`）。
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { SessionEvent, SessionId } from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionRepl } from "../src/cli/repl.js";
import { createContext } from "../src/events/index.js";
import {
	type CassetteExchange,
	createCassetteHeader,
	createOpenAiCompatibleProvider,
	createRecordingProvider,
	createReplayProvider,
	loadCassette,
	serializeCassette,
} from "../src/llm/index.js";
import { selectShellProvider } from "../src/shell/index.js";
import { createDefaultToolset, createToolRegistry } from "../src/tools/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const API_KEY = "sk-chenxi-m19-LOCAL-ONLY-7f3a9c1d";
const MODEL = "m19-local";
const PROMPT = "read note.txt and summarize it";
const NOTE = "Chenxi M19 note.\nsecond line\n";

const servers: Server[] = [];
const temps: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

function sse(res: ServerResponse, payload: string): void {
	res.write(`data: ${payload}\n\n`);
}

/** 起本地 SSE 服务器：第 1 次请求回 tool_call(read)，第 2 次回带 usage 的正文；并统计请求数。 */
async function startSseServer(): Promise<{ baseUrl: string; requests: () => number }> {
	let count = 0;
	const server = createServer((_req, res) => {
		count += 1;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.flushHeaders();
		if (count === 1) {
			const args = JSON.stringify({ path: "note.txt", offset: 0, limit: 2 });
			sse(
				res,
				JSON.stringify({
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: "call_m19", function: { name: "read", arguments: args } },
								],
							},
						},
					],
				}),
			);
			sse(res, '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
		} else {
			sse(res, '{"choices":[{"delta":{"content":"The note says: "}}]}');
			sse(res, '{"choices":[{"delta":{"content":"hello M19."}}]}');
			sse(
				res,
				'{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
			);
			sse(res, '{"choices":[{"delta":{},"finish_reason":"stop"}]}');
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("expected a TCP address");
	return { baseUrl: `http://127.0.0.1:${address.port}`, requests: () => count };
}

/** 装配「真实 4 原语工具」的运行环境（**无权限系统**：REPL 不注入 beforeHooks）。 */
function makeTools() {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() }))
		registry.register(tool);
	return { ctx, registry };
}

function readEvents(home: string, sessionId: SessionId): SessionEvent[] {
	return readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

type LooseEvent = Record<string, unknown> & { type: string; payload: Record<string, unknown> };

/**
 * 比较口径：去掉会话起止与每条 `sessionId`/`at`（两次会话必然不同）；
 * `tool/result` 的 `durationMs` 是**本机时钟**测量，归零后比较结构与载荷。
 */
function normalize(events: readonly SessionEvent[]): LooseEvent[] {
	return events
		.filter((event) => event.type !== "session/start" && event.type !== "session/end")
		.map((event) => {
			const clone = JSON.parse(JSON.stringify(event)) as LooseEvent;
			delete clone.sessionId;
			delete clone.at;
			if (clone.type === "tool/result") clone.payload.durationMs = 0;
			return clone;
		});
}

describe("M19 验收：录制一次真实流式会话，再离线回放", () => {
	it("同一 cwd / prompt / 工具集：事件序列逐字段深等，回放期间 0 次网络请求", async () => {
		const workspace = newTemp("chenxi-m19-cwd-");
		const homeRecord = newTemp("chenxi-m19-home-record-");
		const homeReplay = newTemp("chenxi-m19-home-replay-");
		const cassettePath = join(newTemp("chenxi-m19-cassette-"), "session.cassette.jsonl");
		writeFileSync(join(workspace, "note.txt"), NOTE, "utf8");

		const server = await startSseServer();
		const provider = createOpenAiCompatibleProvider({
			baseUrl: server.baseUrl,
			apiKey: API_KEY,
			defaultModel: MODEL,
			fetchImpl: fetch,
		});

		// ---- 录制会话 ----
		const recorded: CassetteExchange[] = [];
		const recordingProvider = createRecordingProvider(provider, {
			onExchange: (exchange) => void recorded.push(exchange),
		});
		const recordingRun = await runSessionRepl({
			home: homeRecord,
			cwd: workspace,
			provider: recordingProvider,
			model: MODEL,
			tools: makeTools(),
			input: Readable.from([`${PROMPT}\n`, "/exit\n"]),
			output: { write: () => {} },
		});

		expect(server.requests()).toBe(2);
		expect(recorded).toHaveLength(2);

		const cassetteText = serializeCassette({
			header: createCassetteHeader({ providerId: provider.id, model: MODEL }),
			exchanges: recorded,
		});
		writeFileSync(cassettePath, cassetteText, "utf8");

		const recordingEvents = readEvents(homeRecord, recordingRun.sessionId);
		expect(normalize(recordingEvents).map((event) => event.type)).toEqual([
			"user/message",
			"turn/start",
			"assistant/message",
			"tool/result",
			"assistant/message",
			"turn/end",
		]);
		const toolResult = recordingEvents.find((event) => event.type === "tool/result");
		expect(toolResult?.type).toBe("tool/result");
		if (toolResult?.type === "tool/result") {
			expect(toolResult.payload.ok).toBe(true);
			expect((toolResult.payload.output as { content?: string }).content).toContain(
				"Chenxi M19 note.",
			);
		}

		// ---- 回放会话（完全不设模型环境变量；provider 只读文件，不发网络） ----
		const cassette = loadCassette(cassetteText);
		const replayProvider = createReplayProvider(cassette);
		expect(replayProvider.consumed).toBe(0);
		expect(replayProvider.remaining).toBe(2);

		const replayRun = await runSessionRepl({
			home: homeReplay,
			cwd: workspace,
			provider: replayProvider,
			model: cassette.header.model,
			tools: makeTools(),
			input: Readable.from([`${PROMPT}\n`, "/exit\n"]),
			output: { write: () => {} },
		});

		expect(server.requests()).toBe(2); // 回放没有新增请求
		expect(replayProvider.consumed).toBe(2);
		expect(replayProvider.remaining).toBe(0);

		const replayEvents = readEvents(homeReplay, replayRun.sessionId);
		expect(normalize(replayEvents)).toEqual(normalize(recordingEvents));

		// ---- cassette 内容：可审计且不含密钥 ----
		expect(cassetteText).toContain('"text-delta"');
		expect(cassetteText).toContain('"usage"');
		expect(cassetteText).toContain('"stopReason"');
		expect(cassetteText).toContain('"toolCalls"');
		expect(cassetteText).toContain('"input":{"path":"note.txt"');
		expect(cassetteText).not.toContain(API_KEY);
		expect(cassetteText).not.toContain("Authorization");
	});
});
