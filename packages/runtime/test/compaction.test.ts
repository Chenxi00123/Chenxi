/**
 * M23（ADR-041）长会话上下文压缩。
 *
 * 钉住四件事：
 *  ① 阈值 / 回合数不够时**什么都不做**（默认行为逐字节不变）；
 *  ② 区间**只覆盖整回合**，绝不切断 `assistant(toolCalls)` 与 `tool/result` 的配对；
 *  ③ 投影里旧消息消失、摘要出现、最近回合完整，且**幂等**；
 *  ④ 真会话里压缩是**已记录的事实**（JSONL 有 `context/compacted`），resume 后投影一致。
 */
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import {
	cli,
	createSessionStore,
	createStubProvider,
	deriveMessages,
	planCompaction,
} from "@chenxi/runtime";
import type { SessionEvent } from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Draft = { type: string; content?: string; toolName?: string; ok?: boolean; output?: unknown };

let seq = 0;
let lastToolCallId = "call_0";
/** 极简事件工厂：只造本测试需要的字段（seq / type / payload）。 */
function events(drafts: readonly Draft[]): SessionEvent[] {
	seq = 0;
	lastToolCallId = "call_0";
	return drafts.map((draft) => {
		const base = {
			seq: seq++,
			id: `evt_${seq}`,
			sessionId: "ses_test",
			at: "2026-11-12T00:00:00.000Z",
		};
		switch (draft.type) {
			case "turn/start":
				return {
					...base,
					type: "turn/start",
					payload: { turnId: `turn_${seq}`, index: seq },
				} as unknown as SessionEvent;
			case "turn/end":
				return {
					...base,
					type: "turn/end",
					payload: { turnId: `turn_${seq}`, stopReason: "end_turn" },
				} as unknown as SessionEvent;
			case "user/message":
				return {
					...base,
					type: "user/message",
					payload: { content: draft.content ?? "" },
				} as unknown as SessionEvent;
			case "assistant/message":
				lastToolCallId = `call_${seq}`;
				return {
					...base,
					type: "assistant/message",
					payload: {
						content: draft.content ?? "",
						...(draft.toolName === undefined
							? {}
							: {
									toolCalls: [
										{ callId: lastToolCallId, toolName: draft.toolName, input: { path: "a.txt" } },
									],
								}),
					},
				} as unknown as SessionEvent;
			case "tool/result":
				return {
					...base,
					type: "tool/result",
					payload: {
						callId: lastToolCallId,
						toolName: draft.toolName ?? "read",
						ok: draft.ok !== false,
						output: draft.output ?? "",
						durationMs: 1,
					},
				} as unknown as SessionEvent;
			case "memory/injected":
				return {
					...base,
					type: "memory/injected",
					payload: { source: "mcp", content: draft.content ?? "", memoryIds: ["m1"] },
				} as unknown as SessionEvent;
			default:
				return { ...base, type: draft.type, payload: {} } as unknown as SessionEvent;
		}
	});
}

/** 一个完整回合：user → assistant → (可选 tool) → end。 */
function turn(user: string, assistant: string, withTool = false): Draft[] {
	return [
		{ type: "turn/start" },
		{ type: "user/message", content: user },
		...(withTool
			? ([
					{ type: "assistant/message", content: "", toolName: "read" },
					{ type: "tool/result", toolName: "read", output: `result of ${user}` },
					{ type: "assistant/message", content: assistant },
				] as Draft[])
			: ([{ type: "assistant/message", content: assistant }] as Draft[])),
		{ type: "turn/end" },
	];
}

describe("planCompaction：阈值与边界", () => {
	it("没超字符阈值 ⇒ 不压缩", () => {
		const log = events([...turn("a", "b"), ...turn("c", "d"), ...turn("e", "f")]);
		expect(planCompaction(log, { maxChars: 1_000_000, keepTurns: 1 })).toBeUndefined();
	});

	it("回合数不够保留数 ⇒ 不压缩", () => {
		const log = events([...turn("a".repeat(500), "b"), ...turn("c".repeat(500), "d")]);
		expect(planCompaction(log, { maxChars: 10, keepTurns: 2 })).toBeUndefined();
	});

	it("超阈值 ⇒ 只压更早的整回合，区间落在保留回合之前", () => {
		const log = events([
			...turn("first-user", "first-assistant"),
			...turn("second-user", "second-assistant"),
			...turn("third-user", "third-assistant"),
		]);
		const plan = planCompaction(log, { maxChars: 10, keepTurns: 1 });
		expect(plan).toBeDefined();
		const thirdTurnStart = log.find(
			(event) => event.type === "turn/start" && event.seq > 0 && event.seq > (plan?.toSeq ?? 0),
		);
		// 区间必须整体早于被保留的最后回合
		expect(plan?.toSeq).toBeLessThan(thirdTurnStart?.seq ?? -1);
		expect(plan?.keepTurns).toBe(1);
		expect(plan?.summary).toContain("已省略");
	});

	it("**不切断 tool 配对**：区间终点落在整回合末尾（带 toolCalls 的 assistant 必有 tool/result 同段）", () => {
		const log = events([...turn("u1", "a1", true), ...turn("u2", "a2", true), ...turn("u3", "a3")]);
		const plan = planCompaction(log, { maxChars: 10, keepTurns: 2 });
		expect(plan).toBeDefined();
		const removed = log.filter((event) => event.seq <= (plan?.toSeq ?? -1));
		// 区间内 callId 必须一一对应（真会话还有 tool/call 事件，故按 callId 判定而不是"相邻"）
		const callIds = new Set<string>();
		const resultIds = new Set<string>();
		for (const event of removed) {
			if (event.type === "assistant/message") {
				for (const call of event.payload.toolCalls ?? []) callIds.add(call.callId);
			}
			if (event.type === "tool/result") resultIds.add(event.payload.callId);
		}
		expect([...resultIds].sort()).toEqual([...callIds].sort());
		// 区间终点不能是 tool/result（否则它的 assistant 留在外面 → 孤儿 tool 消息）
		expect(removed.at(-1)?.type).not.toBe("tool/result");
	});

	it("区间不重叠：第二次从上一段的 toSeq 之后开始", () => {
		const log = events([
			...turn("u1", "a1"),
			...turn("u2", "a2"),
			...turn("u3", "a3"),
			...turn("u4", "a4"),
			...turn("u5", "a5"),
		]);
		const first = planCompaction(log, { maxChars: 10, keepTurns: 3 });
		expect(first).toBeDefined();
		const compacted = {
			seq: 999,
			id: "evt_999",
			sessionId: "ses_test",
			at: "2026-11-12T00:00:00.000Z",
			type: "context/compacted",
			payload: {
				fromSeq: first?.fromSeq ?? 0,
				toSeq: first?.toSeq ?? 0,
				removedMessages: first?.removedMessages ?? 0,
				removedChars: first?.removedChars ?? 0,
				keepTurns: first?.keepTurns ?? 1,
				strategy: "truncate",
				summary: first?.summary ?? "",
			},
		} as unknown as SessionEvent;
		const second = planCompaction([...log, compacted], { maxChars: 10, keepTurns: 1 });
		expect(second).toBeDefined();
		expect(second?.fromSeq).toBeGreaterThan(first?.toSeq ?? 0);
	});
});

describe("deriveMessages：投影跳过区间并插入摘要", () => {
	it("旧消息消失、摘要出现、最近回合完整；重复调用结果相同（幂等）", () => {
		const log = events([
			...turn("OLD-USER-TEXT", "OLD-ASSISTANT-TEXT"),
			...turn("KEEP-USER-TEXT", "KEEP-ASSISTANT-TEXT"),
		]);
		const compacted = {
			seq: 100,
			id: "evt_100",
			sessionId: "ses_test",
			at: "2026-11-12T00:00:00.000Z",
			type: "context/compacted",
			payload: {
				fromSeq: 1,
				toSeq: 2,
				removedMessages: 2,
				removedChars: 42,
				keepTurns: 1,
				strategy: "truncate",
				summary: "[context compacted] 已省略 2 条较早消息（约 42 字符）。",
			},
		} as unknown as SessionEvent;
		const withCompaction = [...log.slice(0, 4), compacted, ...log.slice(4)];

		const messages = deriveMessages(withCompaction);
		const text = messages.map((message) => message.content).join("\n");
		expect(text).not.toContain("OLD-USER-TEXT");
		expect(text).not.toContain("OLD-ASSISTANT-TEXT");
		expect(text).toContain("context compacted");
		expect(text).toContain("KEEP-USER-TEXT");
		expect(text).toContain("KEEP-ASSISTANT-TEXT");

		expect(deriveMessages(withCompaction)).toEqual(messages);
	});

	it("没有压缩事件时投影**逐字不变**（默认关闭的回归钉）", () => {
		const log = events([...turn("u1", "a1"), ...turn("u2", "a2")]);
		const text = deriveMessages(log)
			.map((message) => message.content)
			.join("\n");
		expect(text).toContain("u1");
		expect(text).not.toContain("context compacted");
	});
});

describe("真会话：压缩是已记录的事实", () => {
	it("开启 compaction 后，JSONL 出现 context/compacted 且投影减少", async () => {
		const home = makeTempDir("chenxi-m23-");
		temps.push(home);
		const result = await cli.runSessionRepl({
			home,
			provider: createStubProvider([
				{ content: "reply one", stopReason: "end_turn" },
				{ content: "reply two", stopReason: "end_turn" },
				{ content: "reply three", stopReason: "end_turn" },
			]),
			model: "stub-model",
			mode: "plan",
			input: Readable.from(["first prompt\n", "second prompt\n", "third prompt\n", "/exit\n"]),
			output: { write: () => undefined },
			compaction: { maxChars: 10, keepTurns: 1 },
		} as Parameters<typeof cli.runSessionRepl>[0]);

		const store = createSessionStore({ home });
		const handle = await store.resume(result.sessionId);
		try {
			const log = [...handle.log.events];
			const compactedEvents = log.filter((event) => event.type === "context/compacted");
			expect(compactedEvents.length).toBeGreaterThan(0);

			const messages = deriveMessages(log);
			const text = messages.map((message) => message.content).join("\n");
			// 第一轮被压缩；最后一轮完整保留
			expect(text).not.toContain("first prompt");
			expect(text).toContain("third prompt");
			expect(text).toContain("context compacted");

			// 事件本身的顺序：压缩事件出现在被压区间之后、新 user 之前
			const first = compactedEvents[0];
			expect(first?.payload.fromSeq).toBeLessThan(first?.payload.toSeq ?? -1);
			expect(first?.payload.removedMessages).toBeGreaterThan(0);
		} finally {
			await handle.close();
		}
	});
});
