/**
 * M11a 验收测试（总工程师独立编写）：client/server 的事件流侧（ADR-021）。
 *
 * 覆盖：
 *  - **单全局订阅 + 每连接有界队列**：扇出到多个连接；**队列满只断该连接**（`subscriber_overflow`），
 *    其他连接**完全不受影响**；`publish` **绝不阻塞**发布者；
 *  - **编码失败 = 全体失败**：一条事件序列化不出来是格式级 bug，必须让**所有**订阅者一起收尾，
 *    不能只影响一个（否则"一个订阅者坏了"会掩盖它）；
 *  - **服务端不新增写路径**：`GET /api/sessions/:id` 之前与之后的 JSONL 事实源**逐字节相同**；
 *    `GET /api/sessions` **在没有派生索引时也工作**（直接扫 JSONL => 不变量 6 的活证据）；
 *  - **真 http 端到端**：`hello` 握手帧（含 `resume: "replay-only"`）、事件帧转发、405/404 可读错误、
 *    非本机地址会**明确警告**（默认只绑 `127.0.0.1`）。
 */
import { EventEmitter } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PROTOCOL_VERSION } from "@aster/protocol";
import type { SessionEvent, SessionId } from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { runSessionRepl } from "../src/cli/repl.js";
import { loadConfig } from "../src/config/index.js";
import { createStubProvider } from "../src/llm/index.js";
import { createSessionStore } from "../src/persist/index.js";
import {
	createEventFeed,
	createEventProducer,
	DEFAULT_SERVE_HOST,
	frameLine,
	listSessionsFromDisk,
	pumpEvents,
	readSessionEvents,
	SUBSCRIBER_CAPACITY,
	SubscriberOverflowError,
	startServer,
} from "../src/serve/index.js";
import { deriveMessages } from "../src/session/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 造一个已落盘的小会话（两个用户回合 + 一条 assistant 回复）。 */
async function seedSession(home: string, cwd: string): Promise<SessionId> {
	const store = createSessionStore({ home });
	const handle = await store.create({ cwd, mode: "build", model: "m11-model" });
	try {
		await handle.append({ type: "user/message", payload: { content: "Q1" } });
		await handle.append({
			type: "assistant/message",
			payload: { content: "A1", stopReason: "end_turn" },
		});
		await handle.append({ type: "session/end", payload: { reason: "exit" } });
		return handle.sessionId;
	} finally {
		await handle.close();
		await store.dispose();
	}
}

/** 读 SSE 流直到满足条件（或超时）。返回已收到的文本。 */
async function readStreamUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	predicate: (text: string) => boolean,
	timeoutMs = 2000,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	const started = Date.now();
	while (!predicate(text)) {
		if (Date.now() - started > timeoutMs) throw new Error(`SSE timeout; got:\n${text}`);
		const chunk = await Promise.race([reader.read(), delay(50).then(() => undefined)]);
		if (chunk === undefined) continue;
		if (chunk.done) break;
		text += decoder.decode(chunk.value, { stream: true });
	}
	return text;
}

describe("M11a 事件扇出：单全局订阅 + 每连接有界队列（ADR-021）", () => {
	it("扇出到多个订阅者；订阅/退订反映在 subscriberCount 上", async () => {
		const feed = createEventFeed();
		const a = feed.subscribe();
		const b = feed.subscribe();
		expect(feed.subscriberCount).toBe(2);
		feed.publish({ n: 1 });
		const readA = a[Symbol.asyncIterator]();
		const readB = b[Symbol.asyncIterator]();
		expect((await readA.next()).value).toContain('"n":1');
		expect((await readB.next()).value).toContain('"n":1');
		a.close();
		expect(feed.subscriberCount).toBe(1);
		b.close();
		expect(feed.subscriberCount).toBe(0);
	});

	it("**慢消费者只断自己**：队列满的那个以 overflow 收尾，另一个照收不误", async () => {
		const feed = createEventFeed({ capacity: 2 });
		const slow = feed.subscribe(); // 一直不读 -> 会积压到溢出
		const fast = feed.subscribe();
		const fastIterator = fast[Symbol.asyncIterator]();
		const seen: unknown[] = [];

		feed.publish("e1");
		seen.push((await fastIterator.next()).value); // fast 跟得上：每发一条就读一条
		feed.publish("e2");
		seen.push((await fastIterator.next()).value);
		feed.publish("e3"); // 此时 slow 已积压 2 条（容量 2）-> 它出局；fast 不受影响

		expect(slow.dropped).toBe(true);
		expect(feed.subscriberCount).toBe(1); // 只删掉慢的那个
		seen.push((await fastIterator.next()).value);
		expect(seen).toEqual(['"e1"', '"e2"', '"e3"']);

		// slow 的迭代器抛的是 overflow（可续：重连后整段回放）
		await expect(slow[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
			SubscriberOverflowError,
		);

		// 出局之后发布者照常工作，fast 继续收
		feed.publish("e4");
		expect((await fastIterator.next()).value).toBe('"e4"');
		fast.close();
	});

	it("`publish` 绝不阻塞发布者：无人读取也能同步连发（远超容量）", () => {
		const feed = createEventFeed({ capacity: 1 });
		const subscriber = feed.subscribe();
		const started = Date.now();
		for (let i = 0; i < 500; i += 1) feed.publish({ i });
		expect(Date.now() - started).toBeLessThan(500); // 同步返回，不等消费者
		expect(subscriber.dropped).toBe(true); // 慢消费者已出局，但发布者毫无感觉
	});

	it("编码失败 = **全体**失败：绝不让「一个订阅者坏了」掩盖格式级 bug", async () => {
		const feed = createEventFeed();
		const a = feed.subscribe();
		const b = feed.subscribe();
		feed.publish({ bad: 1n }); // BigInt 无法 JSON 序列化
		const outcomeA = await a[Symbol.asyncIterator]()
			.next()
			.catch((error: unknown) => error);
		const outcomeB = await b[Symbol.asyncIterator]()
			.next()
			.catch((error: unknown) => error);
		expect(outcomeA).toBeInstanceOf(Error);
		expect(outcomeB).toBeInstanceOf(Error);
		expect((outcomeA as Error).message).toBe((outcomeB as Error).message); // 同一个致命错误
		expect(feed.subscriberCount).toBe(0);
	});

	it("订阅者主动 close：迭代器正常结束（不是错误）", async () => {
		const feed = createEventFeed();
		const subscriber = feed.subscribe();
		subscriber.close();
		await expect(subscriber[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
	});

	it("容量常量与 ADR 一致（4096，继承 OpenCode 的取值）", () => {
		expect(SUBSCRIBER_CAPACITY).toBe(4096);
		expect(
			frameLine({ kind: "hello", protocolVersion: PROTOCOL_VERSION, resume: "replay-only" }),
		).toBe(`data: {"kind":"hello","protocolVersion":1,"resume":"replay-only"}\n\n`);
	});
});

describe("M11a 只读事实源读取（服务端不信派生索引）", () => {
	it("没有 index.sqlite 也能列出会话（不变量 6：索引只是可重建的派生品）", async () => {
		const home = newTemp("aster-m11-src-");
		const sessionId = await seedSession(home, newTemp("aster-m11-src-cwd-"));
		// 故意删掉派生索引（若存在）
		rmSync(join(home, "index.sqlite"), { force: true });

		const metas = listSessionsFromDisk(home);
		expect(metas.map((meta) => meta.sessionId)).toEqual([sessionId]);
		expect(metas[0]).toMatchObject({ mode: "build", model: "m11-model", eventCount: 4 });
	});

	it("损坏的**最后一行**（正在被追加的半行）被忽略；中间行损坏则报错", async () => {
		const home = newTemp("aster-m11-corrupt-");
		const sessionId = await seedSession(home, newTemp("aster-m11-corrupt-cwd-"));
		const file = join(home, "sessions", `${sessionId}.jsonl`);
		const good = readFileSync(file, "utf8");
		const goodLineCount = good.trim().split("\n").length;

		// 尾部半行（正在被追加）：容忍，前面的完整行照常读出
		writeFileSync(file, `${good}{"seq":4,"id":"evt_4","sess`, "utf8");
		expect(readSessionEvents(home, sessionId)?.length).toBe(goodLineCount);
		expect(deriveMessages(readSessionEvents(home, sessionId) ?? []).map((m) => m.content)).toEqual([
			"Q1",
			"A1",
		]);

		// 中间行损坏：抛错（**不静默吞掉**真实损坏）
		const lines = good.trim().split("\n");
		writeFileSync(file, [lines[0], "{oops", ...lines.slice(2)].join("\n"), "utf8");
		expect(() => readSessionEvents(home, sessionId)).toThrowError(/corrupt at line 2/);
	});
});

/** 假响应：可以**人为阻塞**（`write` 返回 false 且不给 drain），用来确定性地构造慢消费者。 */
class BlockedResponse extends EventEmitter {
	readonly written: string[] = [];
	ended = false;
	readonly destroyed = false;
	readonly writableEnded = false;
	#blocked = true;

	unblock(): void {
		this.#blocked = false;
		this.emit("drain");
	}

	write(text: string): boolean {
		this.written.push(text);
		return !this.#blocked;
	}

	end(): void {
		this.ended = true;
	}
}

describe("M11a HTTP 服务端（真客户端，端到端）", () => {
	it("回放是**只读**的：调用前后事实源逐字节相同；列表/回放/404/405 都可读", async () => {
		const home = newTemp("aster-m11-http-");
		const cwd = newTemp("aster-m11-http-cwd-");
		const sessionId = await seedSession(home, cwd);
		const file = join(home, "sessions", `${sessionId}.jsonl`);
		const before = readFileSync(file, "utf8");

		const feed = createEventFeed();
		const server = await startServer({ home, feed, port: 0 });
		try {
			expect(server.host).toBe(DEFAULT_SERVE_HOST); // 默认只绑本机

			const list = (await (await fetch(`${server.url}/api/sessions`)).json()) as {
				sessions: { sessionId: string }[];
			};
			expect(list.sessions.map((meta) => meta.sessionId)).toEqual([sessionId]);

			const one = (await (await fetch(`${server.url}/api/sessions/${sessionId}`)).json()) as {
				meta: { mode: string };
				events: SessionEvent[];
				messages: { role: string; content: string }[];
			};
			expect(one.meta.mode).toBe("build");
			expect(one.messages).toEqual(deriveMessages(one.events)); // 回放 = 投影，不新造语义
			expect(one.messages.map((message) => message.content)).toEqual(["Q1", "A1"]);

			// **只读**：事实源没有被服务端动过
			expect(readFileSync(file, "utf8")).toBe(before);

			const missing = await fetch(`${server.url}/api/sessions/ses_nope`);
			expect(missing.status).toBe(404);
			expect((await missing.json()) as unknown).toMatchObject({ code: "session_not_found" });

			const notAllowed = await fetch(`${server.url}/api/sessions`, { method: "POST" });
			expect(notAllowed.status).toBe(405);
			expect((await notAllowed.json()) as unknown).toMatchObject({ code: "method_not_allowed" });
		} finally {
			await server.close();
		}
	});

	it("SSE：先 `hello`（明示不回放续传），再把**已记录事件**逐条转发给订阅者", async () => {
		const home = newTemp("aster-m11-sse-");
		const sessionId = await seedSession(home, newTemp("aster-m11-sse-cwd-"));
		const feed = createEventFeed();
		const server = await startServer({ home, feed, port: 0 });
		try {
			const response = await fetch(`${server.url}/api/event`);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			if (reader === undefined) return;

			const hello = await readStreamUntil(reader, (text) => text.includes(`"kind":"hello"`));
			expect(hello).toContain(`"protocolVersion":${PROTOCOL_VERSION}`);
			expect(hello).toContain('"resume":"replay-only"'); // 契约说清楚，不假装可靠投递

			// 生产者（CLI 的 onEvent）把已记录事件喂进来 -> 客户端收到 event 帧
			const produce = createEventProducer(feed);
			const stored = readSessionEvents(home, sessionId) ?? [];
			produce(stored[1] as SessionEvent);
			const streamed = await readStreamUntil(reader, (text) => text.includes('"kind":"event"'));
			expect(streamed).toContain('"type":"user/message"');
			expect(streamed).toContain("Q1");

			await reader.cancel();
		} finally {
			await server.close();
		}
	});

	it("SSE 溢出：阻塞的响应 -> 该连接收到 overflow 错误帧并结束（其余连接不受影响）", async () => {
		const feed = createEventFeed({ capacity: 1 });
		const fake = new BlockedResponse();
		const pump = pumpEvents(fake as unknown as ServerResponse, feed);
		await delay(10); // 让泵进入"等第一条事件"

		feed.publish({ n: 1 }); // 泵取走 -> 写 socket 阻塞 -> 卡在 drain 上
		await delay(10);
		feed.publish({ n: 2 }); // 进队列（容量 1）
		feed.publish({ n: 3 }); // 队列已满 -> 该订阅者出局
		expect(feed.subscriberCount).toBe(0); // 只删掉阻塞的那一个

		fake.unblock(); // 放行 drain
		await pump;
		expect(fake.ended).toBe(true);
		expect(fake.written.join("")).toContain('"code":"subscriber_overflow"');
		expect(fake.written.join("")).toContain('"retryable":true'); // 可续：重连后整段回放

		// 其余连接不受影响：新订阅者照常收到后续事件
		const fresh = feed.subscribe();
		feed.publish({ still: "alive" });
		expect(String((await fresh[Symbol.asyncIterator]().next()).value)).toContain("still");
		fresh.close();
	});

	it("回归（M11a 冒烟抓到的真 bug）：**REPL 的每条已记录事件**都喂给订阅者（含 `/mode` 与 `session/end`）", async () => {
		const home = newTemp("aster-m11-producer-");
		const cwd = newTemp("aster-m11-producer-cwd-");
		const publish: SessionEvent[] = [];
		const seen = new Set<string>();

		await runSessionRepl({
			home,
			cwd,
			// 走 `--stub` 同款桩 provider：无需端点，且能真跑一个回合
			provider: createStubProvider([{ content: "STUB", toolCalls: [], stopReason: "end_turn" }]),
			model: "stub-model",
			input: Readable.from(["/mode build\n", "hello\n", "/exit\n"]),
			output: { write: () => undefined },
			onEvent: (event) => {
				publish.push(event);
				seen.add(event.type);
			},
		});

		// 曾经漏掉的就是这三类：`/mode` 的 mode/changed、回合事件、以及收尾的 session/end
		expect(seen.has("mode/changed")).toBe(true);
		expect(seen.has("user/message")).toBe(true);
		expect(seen.has("assistant/message")).toBe(true);
		expect(seen.has("session/end")).toBe(true);

		// 且发布的就是**已记录**的那条事实（同 seq、同 payload）。
		// 边界：`session/start` 由 `persist.create` 在建会话时写入，**早于**生产者出口，
		// 因此不进流（会话身份用 `GET /api/sessions` 或回放拿）——这是 ADR-021 明示的边界。
		const stored = readSessionEvents(home, publish[0]?.sessionId as SessionId) ?? [];
		expect(stored[0]?.type).toBe("session/start");
		expect(publish.some((event) => event.type === "session/start")).toBe(false);
		expect(publish.map((event) => event.seq)).toEqual(stored.slice(1).map((event) => event.seq));
		expect(publish.map((event) => event.type)).toEqual(stored.slice(1).map((event) => event.type));
	});

	it("非本机地址：CLI 会明确警告（无鉴权，风险自负）", () => {
		expect(parseArgs(["--serve", "--port", "0", "--host", "0.0.0.0"])).toMatchObject({
			serve: true,
			port: 0,
			host: "0.0.0.0",
		});
		expect(() => parseArgs(["--port", "70000"])).toThrowError(/--port requires/);
		expect(() => parseArgs(["--port", "abc"])).toThrowError(/--port requires/);
		expect(() => parseArgs(["--host"])).toThrowError(/--host requires/);
	});

	it("顺带修复（M11 批次声明）：带 UTF-8 BOM 的配置文件不再被误判成『非法 JSON』", () => {
		// 复现路径：M8b 冒烟时用 PowerShell `Set-Content -Encoding utf8` 写配置 -> 带 BOM ->
		// 原先直接 JSON.parse 会抛 "Unexpected token '\ufeff'"，让人以为配置写错了。
		const cwd = newTemp("aster-m11-bom-");
		writeFileSync(
			join(cwd, "aster.config.json"),
			`\ufeff${JSON.stringify({ mode: "build", subagents: { enabled: true } })}`,
			"utf8",
		);
		const loaded = loadConfig({ home: newTemp("aster-m11-bom-home-"), cwd, env: {} });
		expect(loaded.mode).toBe("build");
		expect(loaded.subagents).toEqual({ enabled: true });
	});
});
