/**
 * M7b-2 验收测试（总工程师独立编写）：记忆注入缝与投影（ADR-011 / ADR-016）。
 *
 * 重点守的是**不变量 1**（模型可见 ⟺ 已记录）与 ADR-016 的「只投影最新一次」：
 *  - 投影：前缀挂在**最后一条** user/message；两条注入只有**后者**生效；注入早于用户消息则不投影；
 *    幂等 / 确定性；
 *  - 缝：注入**先落事件**；空查询不注入；适配器报错 → `failed` 且**不落事件**（失败不阻塞）；
 *    条数与长度上限生效；
 *  - MCP 外挂适配器：请求形状、宽容解析（`{records}` 或裸数组、缺 id 兜底、坏 JSON 视为无记忆）、
 *    没配 `addTool` 时 `add` **显式拒绝**（ADR-033 起写入另由配置开启）；
 *  - 配置：`memory.server` 必须指向已声明的 MCP 服务器（否则 fail-fast）；
 *  - 端到端：REPL 里 provider 收到的用户消息**真的**带上了记忆前缀。
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
	EventDraft,
	EventType,
	MemoryAdapter,
	MemoryRecord,
	MemoryScope,
	MemorySearchRequest,
	SessionEvent,
} from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionRepl } from "../src/cli/repl.js";
import { configFileSchema, loadConfig } from "../src/config/index.js";
import { createStubProvider } from "../src/llm/index.js";
import { createMcpMemoryAdapter, createMemorySeam } from "../src/memory/index.js";
import { createEventLog, deriveMessages, type EventLog } from "../src/session/index.js";
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

function collector() {
	const chunks: string[] = [];
	return {
		output: { write: (text: string) => void chunks.push(text) },
		text: () => chunks.join(""),
	};
}

const SCOPE: MemoryScope = { user: "tester", agent: "aster", session: "ses_m7b2" };

/** 固定返回给定记录的假适配器；`throwError` 用于验证失败不阻塞。 */
function fakeAdapter(options: {
	records?: readonly MemoryRecord[];
	throwError?: string;
	shape?: unknown;
	onSearch?: (req: MemorySearchRequest) => void;
}): MemoryAdapter {
	return {
		search(req) {
			options.onSearch?.(req);
			if (options.throwError !== undefined) return Promise.reject(new Error(options.throwError));
			if (options.shape !== undefined) return Promise.resolve(options.shape as never);
			return Promise.resolve({ records: options.records ?? [] });
		},
		getSessionMemories: () => Promise.resolve({ records: [] }),
		add: () => Promise.reject(new Error("not used in this test")),
	};
}

function appenderFor(log: EventLog) {
	return async <T extends EventType>(draft: EventDraft<T>): Promise<SessionEvent> =>
		log.append(draft);
}

function memoryEvent(content: string, source = "mcp:mem/search"): EventDraft<"memory/injected"> {
	return {
		type: "memory/injected",
		payload: { target: "user-prefix", source, content, memoryIds: ["m1"] },
	};
}

describe("M7b-2 投影：只投影最新一次，且挂最后一条用户消息（ADR-016）", () => {
	it("注入晚于最后一条用户消息 -> 前缀挂在**那条**上，更早的用户消息不变", () => {
		const log = createEventLog({ sessionId: "ses_p1" as never });
		log.append({ type: "user/message", payload: { content: "first" } });
		log.append({ type: "assistant/message", payload: { content: "ok", stopReason: "end_turn" } });
		log.append({ type: "user/message", payload: { content: "second" } });
		log.append(memoryEvent("R1=R2", "mcp:mem/search"));

		const messages = deriveMessages(log.events);
		const users = messages.filter((message) => message.role === "user");
		expect(users).toHaveLength(2);
		expect(users[0]?.content).toBe("first"); // 更早的回合不被回溯修改
		expect(users[1]?.content).toBe('<memory source="mcp:mem/search">\nR1=R2\n</memory>\n\nsecond');
	});

	it("两条注入 -> **只有最后一条**生效（旧的被取代，不堆积）", () => {
		const log = createEventLog({ sessionId: "ses_p2" as never });
		log.append({ type: "user/message", payload: { content: "q" } });
		log.append(memoryEvent("OLD"));
		log.append(memoryEvent("NEW"));

		const messages = deriveMessages(log.events);
		const user = messages.find((message) => message.role === "user");
		expect(user?.content).toContain("NEW");
		expect(user?.content).not.toContain("OLD");
	});

	it("注入**早于**最后一条用户消息 -> 不投影（它属于更早的回合，已被取代）", () => {
		const log = createEventLog({ sessionId: "ses_p3" as never });
		log.append({ type: "user/message", payload: { content: "first" } });
		log.append(memoryEvent("STALE"));
		log.append({ type: "user/message", payload: { content: "second" } });

		const messages = deriveMessages(log.events);
		expect(messages.map((message) => message.content).join("\n")).not.toContain("STALE");
	});

	it("没有 user/message -> 注入不进入消息列表", () => {
		const log = createEventLog({ sessionId: "ses_p4" as never });
		log.append(memoryEvent("NOTHING-TO-ATTACH"));
		expect(deriveMessages(log.events)).toEqual([]);
	});

	it("幂等 / 确定性：同一事件序列多次投影深等", () => {
		const log = createEventLog({ sessionId: "ses_p5" as never });
		log.append({ type: "user/message", payload: { content: "q" } });
		log.append(memoryEvent("X"));
		expect(deriveMessages(log.events)).toEqual(deriveMessages(log.events));
	});
});

describe("M7b-2 注入缝：先落事件、失败不阻塞", () => {
	it("正常注入 -> 落 `memory/injected`（target=user-prefix）并回报 memoryIds", async () => {
		const log = createEventLog({ sessionId: "ses_s1" as never });
		const seam = createMemorySeam({
			adapter: fakeAdapter({
				records: [
					{ id: "a", content: "Alice likes tea" },
					{ id: "b", content: "Bob is in Tokyo" },
				],
			}),
			source: "mcp:mem/search",
			scope: SCOPE,
		});

		const outcome = await seam.beforeTurn("where is bob", appenderFor(log));
		expect(outcome).toEqual({ kind: "injected", memoryIds: ["a", "b"] });

		const event = log.events.find((candidate) => candidate.type === "memory/injected");
		expect(event?.type).toBe("memory/injected");
		if (event?.type === "memory/injected") {
			expect(event.payload.target).toBe("user-prefix");
			expect(event.payload.source).toBe("mcp:mem/search");
			expect(event.payload.memoryIds).toEqual(["a", "b"]);
			expect(event.payload.content).toContain("Alice likes tea");
			expect(event.payload.content).toContain("Bob is in Tokyo");
		}
	});

	it("检索请求带上完整作用域三键与 limit", async () => {
		const seen: MemorySearchRequest[] = [];
		const seam = createMemorySeam({
			adapter: fakeAdapter({
				records: [{ id: "a", content: "x" }],
				onSearch: (req) => seen.push(req),
			}),
			source: "s",
			scope: SCOPE,
			limit: 3,
		});
		await seam.beforeTurn("q", appenderFor(createEventLog({ sessionId: "ses_s2" as never })));
		// ADR-033：检索**跨会话**（`session: "*"`），写入才用真实 session id
		expect(seen[0]).toEqual({ query: "q", scope: { ...SCOPE, session: "*" }, limit: 3 });
	});

	it("空查询 -> `none`，且**不落事件**", async () => {
		const log = createEventLog({ sessionId: "ses_s3" as never });
		const seam = createMemorySeam({
			adapter: fakeAdapter({ records: [] }),
			source: "s",
			scope: SCOPE,
		});
		expect(await seam.beforeTurn("   ", appenderFor(log))).toEqual({
			kind: "none",
			reason: "empty query",
		});
		expect(log.events).toHaveLength(0);
	});

	it("适配器报错 -> `failed` 且**不落事件**（绝不阻塞对话）", async () => {
		const log = createEventLog({ sessionId: "ses_s4" as never });
		const seam = createMemorySeam({
			adapter: fakeAdapter({ throwError: "upstream 500" }),
			source: "s",
			scope: SCOPE,
		});
		const outcome = await seam.beforeTurn("q", appenderFor(log));
		expect(outcome).toEqual({ kind: "failed", reason: "upstream 500" });
		expect(log.events).toHaveLength(0);
	});

	it("形状不符（records 非数组）-> 视为无记忆", async () => {
		const log = createEventLog({ sessionId: "ses_s5" as never });
		const seam = createMemorySeam({
			adapter: fakeAdapter({ shape: { records: "not-an-array" } }),
			source: "s",
			scope: SCOPE,
		});
		expect(await seam.beforeTurn("q", appenderFor(log))).toEqual({
			kind: "none",
			reason: "no memory matched",
		});
	});

	it("条数上限与单条长度上限生效", async () => {
		const log = createEventLog({ sessionId: "ses_s6" as never });
		const seam = createMemorySeam({
			adapter: fakeAdapter({
				records: [
					{ id: "1", content: "x".repeat(100) },
					{ id: "2", content: "second" },
					{ id: "3", content: "third" },
				],
			}),
			source: "s",
			scope: SCOPE,
			limit: 2,
			maxContentLength: 10,
		});
		const outcome = await seam.beforeTurn("q", appenderFor(log));
		expect(outcome.kind).toBe("injected");
		if (outcome.kind === "injected") expect(outcome.memoryIds).toEqual(["1", "2"]); // 第 3 条被裁
		const event = log.events.find((candidate) => candidate.type === "memory/injected");
		if (event?.type === "memory/injected") {
			expect(event.payload.content).toContain("xxxxxxxxxx…"); // 截断标记
			expect(event.payload.content).not.toContain("second\nthird");
		}
	});
});

describe("M7b-2 MCP 外挂适配器：契约与宽容解析", () => {
	it("请求形状与服务端契约一致；`{records:[…]}` 与裸数组都接受", async () => {
		const calls: { name: string; args: unknown }[] = [];
		const callTool = (name: string, args: unknown) => {
			calls.push({ name, args });
			return Promise.resolve({
				content: [
					{
						type: "text",
						text: JSON.stringify({ records: [{ id: "r1", content: "hi", score: 0.9 }] }),
					},
				],
			});
		};
		const adapter = createMcpMemoryAdapter({ callTool, searchTool: "search_memory" });

		const result = await adapter.search({ query: "q", scope: SCOPE, limit: 4 });
		expect(calls[0]?.name).toBe("search_memory");
		expect(calls[0]?.args).toEqual({
			query: "q",
			limit: 4,
			user: SCOPE.user,
			agent: SCOPE.agent,
			session: SCOPE.session,
		});
		expect(result.records).toEqual([{ id: "r1", content: "hi", score: 0.9 }]);

		const bare = createMcpMemoryAdapter({
			callTool: () =>
				Promise.resolve({
					content: [{ type: "text", text: JSON.stringify([{ id: "x", content: "y" }]) }],
				}),
			searchTool: "s",
		});
		expect((await bare.search({ query: "q", scope: SCOPE })).records).toEqual([
			{ id: "x", content: "y" },
		]);
	});

	it("坏 JSON / 缺 content / 缺 id：丢弃或兜底，绝不抛错", async () => {
		const adapter = createMcpMemoryAdapter({
			callTool: () =>
				Promise.resolve({
					content: [
						{
							type: "text",
							text: JSON.stringify([
								{ content: "no-id" },
								{ id: "only" },
								{ id: "ok", content: "keep" },
							]),
						},
					],
				}),
			searchTool: "s",
		});
		const result = await adapter.search({ query: "q", scope: SCOPE });
		expect(result.records).toEqual([
			{ id: "record-0", content: "no-id" },
			{ id: "ok", content: "keep" },
		]);

		const broken = createMcpMemoryAdapter({
			callTool: () => Promise.resolve({ content: [{ type: "text", text: "{ not json" }] }),
			searchTool: "s",
		});
		expect((await broken.search({ query: "q", scope: SCOPE })).records).toEqual([]);

		const noText = createMcpMemoryAdapter({
			callTool: () => Promise.resolve({ content: [] }),
			searchTool: "s",
		});
		expect((await noText.search({ query: "q", scope: SCOPE })).records).toEqual([]);
	});

	it("没配 `addTool` 时 `add` 显式拒绝（不静默空操作；ADR-033 之前的既有行为）", async () => {
		const adapter = createMcpMemoryAdapter({
			callTool: () => Promise.resolve({ content: [] }),
			searchTool: "s",
		});
		await expect(adapter.add({ content: "x", scope: SCOPE })).rejects.toThrow(/not configured/);
	});
});

describe("M7b-2 配置：memory.server 必须指向已声明的 MCP 服务器", () => {
	it("未声明或指向不存在的服务器 -> fail-fast 且提示已声明清单", () => {
		expect(configFileSchema.safeParse({ memory: { server: "m", searchTool: "s" } }).success).toBe(
			true,
		);
		expect(configFileSchema.safeParse({ memory: { server: "", searchTool: "s" } }).success).toBe(
			false,
		);
		expect(
			configFileSchema.safeParse({ memory: { server: "m", searchTool: "s", oops: 1 } }).success,
		).toBe(false);
		expect(
			configFileSchema.safeParse({ memory: { server: "m", searchTool: "s", limit: 99 } }).success,
		).toBe(false);

		const cwd = newTemp("aster-m7b2-cfg-");
		writeFileSync(
			join(cwd, "aster.config.json"),
			JSON.stringify({ memory: { server: "ghost", searchTool: "s" } }),
			"utf8",
		);
		expect(() => loadConfig({ home: newTemp("h-"), cwd, env: {} })).toThrow(/memory\.server/);
		expect(() => loadConfig({ home: newTemp("h-"), cwd, env: {} })).toThrow(/declared: \(none\)/);

		writeFileSync(
			join(cwd, "aster.config.json"),
			JSON.stringify({
				mcp: { servers: [{ name: "mem", command: "node" }] },
				memory: { server: "mem", searchTool: "search_memory", limit: 3 },
			}),
			"utf8",
		);
		const loaded = loadConfig({ home: newTemp("h-"), cwd, env: {} });
		expect(loaded.memory).toEqual({ server: "mem", searchTool: "search_memory", limit: 3 });
	});
});

describe("M7b-2 端到端：REPL 里模型**真的**看到记忆前缀", () => {
	it("provider 收到的用户消息以 `<memory …>` 开头，且输出提示了注入", async () => {
		const home = newTemp("aster-m7b2-home-");
		const provider = createStubProvider([{ content: "ok", stopReason: "end_turn" }]);
		const collected = collector();

		await runSessionRepl({
			home,
			provider,
			model: "stub-model",
			memory: () =>
				createMemorySeam({
					adapter: fakeAdapter({
						records: [{ id: "m1", content: "The user prefers metric units." }],
					}),
					source: "mcp:mem/search",
					scope: { user: "t", agent: "aster", session: "ses_e2e" },
				}),
			input: Readable.from(["how far is it?\n", "/exit\n"]),
			output: collected.output,
		});

		expect(provider.calls, collected.text()).toHaveLength(1);
		const user = provider.calls[0]?.messages.find((message) => message.role === "user");
		expect(user?.content).toContain('<memory source="mcp:mem/search">');
		expect(user?.content).toContain("The user prefers metric units.");
		expect(user?.content).toContain("how far is it?");
		expect(collected.text()).toContain("~ memory: injected 1 record(s)");
	});
});
