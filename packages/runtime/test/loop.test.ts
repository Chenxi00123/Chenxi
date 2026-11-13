/**
 * loop（回合制主循环）单元测试。
 *
 * 刻意在测试内联一个桩 provider，避免与并行开发的 `../llm/stub.js` 耦合。
 */
import type {
	AssistantMessagePayload,
	EventDraft,
	EventType,
	SessionEvent,
	StopReason,
	ToolCallRef,
	TurnEndPayload,
	TurnStartPayload,
} from "@chenxi/schema";
import { describe, expect, it, vi } from "vitest";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "../src/llm/types.js";
import { type RunTurnParams, runTurn } from "../src/loop/index.js";
import {
	createEventLog,
	deriveMessages,
	type EventLog,
	newSessionId,
} from "../src/session/index.js";

/** 内联桩 provider：可脚本化 yield 任意 LlmStreamEvent 序列，或抛出指定错误。 */
class InlineStubProvider implements LlmProvider {
	readonly id = "inline-stub";
	readonly requests: LlmRequest[] = [];
	readonly #events: readonly LlmStreamEvent[];
	readonly #failure: Error | undefined;

	constructor(options: { events?: readonly LlmStreamEvent[]; failure?: Error } = {}) {
		this.#events = options.events ?? [];
		this.#failure = options.failure;
	}

	async *stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent, void, void> {
		this.requests.push(request);
		if (this.#failure !== undefined) throw this.#failure;
		for (const event of this.#events) {
			yield event;
		}
	}
}

function done(
	content: string,
	stopReason: StopReason,
	toolCalls: readonly ToolCallRef[] = [],
): LlmStreamEvent {
	return { kind: "done", message: { content, toolCalls, stopReason } };
}

function makeSession(): { log: EventLog; append: RunTurnParams["append"] } {
	const log = createEventLog({ sessionId: newSessionId() });
	const append: RunTurnParams["append"] = async <T extends EventType>(
		draft: EventDraft<T>,
	): Promise<SessionEvent> => log.append(draft);
	return { log, append };
}

interface LogSnapshot {
	readonly types: string[];
	readonly turnStarts: TurnStartPayload[];
	readonly turnEnds: TurnEndPayload[];
	readonly assistant: AssistantMessagePayload[];
}

function snapshot(log: EventLog): LogSnapshot {
	const snap: LogSnapshot = { types: [], turnStarts: [], turnEnds: [], assistant: [] };
	for (const event of log.events) {
		snap.types.push(event.type);
		switch (event.type) {
			case "turn/start":
				snap.turnStarts.push(event.payload);
				break;
			case "turn/end":
				snap.turnEnds.push(event.payload);
				break;
			case "assistant/message":
				snap.assistant.push(event.payload);
				break;
			default:
				break;
		}
	}
	return snap;
}

describe("runTurn 正常回合", () => {
	it("累积增量 + 落最终 assistant/message + 事件顺序正确", async () => {
		const provider = new InlineStubProvider({
			events: [
				{ kind: "text-delta", text: "Hello " },
				{ kind: "text-delta", text: "world" },
				done("Hello world", "end_turn"),
			],
		});
		const { log, append } = makeSession();
		const onTextDelta = vi.fn();

		const result = await runTurn({
			log,
			append,
			provider,
			model: "gpt-test",
			system: "SYS",
			onTextDelta,
		});

		expect(onTextDelta).toHaveBeenCalledTimes(2);
		expect(onTextDelta).toHaveBeenNthCalledWith(1, "Hello ");
		expect(onTextDelta).toHaveBeenNthCalledWith(2, "world");

		const snap = snapshot(log);
		expect(snap.types).toEqual(["turn/start", "assistant/message", "turn/end"]);
		expect(snap.assistant[0]?.content).toBe("Hello world");
		expect(snap.assistant[0]?.stopReason).toBe("end_turn");

		expect(result.turnId).toBe("turn_0");
		expect(result.stopReason).toBe("end_turn");
		expect(result.content).toBe("Hello world");

		// 请求消息严格来自 deriveMessages 投影（不旁路构造）
		expect(provider.requests[0]?.messages).toEqual([{ role: "system", content: "SYS" }]);
	});
});

describe("deriveMessages 投影", () => {
	it("回合后包含 assistant 消息且投影幂等", async () => {
		const { log, append } = makeSession();
		await append({ type: "user/message", payload: { content: "你好" } });

		const provider = new InlineStubProvider({
			events: [{ kind: "text-delta", text: "嗨" }, done("嗨", "end_turn")],
		});
		await runTurn({ log, append, provider, model: "m" });

		const first = deriveMessages(log.events);
		expect(first).toEqual([
			{ role: "user", content: "你好" },
			{ role: "assistant", content: "嗨" },
		]);
		// 幂等：再投影一次结果深等
		expect(deriveMessages(log.events)).toEqual(first);
	});
});

describe("确定性", () => {
	it("连续两回合的 index / turnId 递增且可预期", async () => {
		const { log, append } = makeSession();
		const provider = new InlineStubProvider({
			events: [{ kind: "text-delta", text: "a" }, done("a", "end_turn")],
		});

		const r1 = await runTurn({ log, append, provider, model: "m" });
		const r2 = await runTurn({ log, append, provider, model: "m" });

		const snap = snapshot(log);
		expect(snap.turnStarts.map((p) => p.index)).toEqual([0, 1]);
		expect(snap.turnStarts.map((p) => p.turnId)).toEqual(["turn_0", "turn_1"]);
		expect(r1.turnId).toBe("turn_0");
		expect(r2.turnId).toBe("turn_1");
	});
});

describe("stopReason 透传", () => {
	it("length 被原样透传到返回值与 turn/end", async () => {
		const { log, append } = makeSession();
		const provider = new InlineStubProvider({
			events: [{ kind: "text-delta", text: "截断" }, done("截断", "length")],
		});

		const result = await runTurn({ log, append, provider, model: "m" });

		expect(result.stopReason).toBe("length");
		const snap = snapshot(log);
		expect(snap.turnEnds[0]?.stopReason).toBe("length");
		expect(snap.turnStarts[0]?.turnId).toBe(result.turnId);
	});
});

describe("provider 抛错", () => {
	it("先补 turn/end（error）再抛出原错误", async () => {
		const { log, append } = makeSession();
		const boom = new Error("provider exploded");
		const provider = new InlineStubProvider({ failure: boom });

		let caught: unknown;
		try {
			await runTurn({ log, append, provider, model: "m" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBe(boom);

		const snap = snapshot(log);
		expect(snap.types).toEqual(["turn/start", "turn/end"]);
		expect(snap.turnEnds[0]?.stopReason).toBe("error");
		// 抛错回合不落 assistant/message
		expect(snap.assistant).toEqual([]);
	});
});

describe("可选回调", () => {
	it("未提供 onTextDelta 时不报错", async () => {
		const { log, append } = makeSession();
		const provider = new InlineStubProvider({
			events: [{ kind: "text-delta", text: "x" }, done("x", "end_turn")],
		});

		const result = await runTurn({ log, append, provider, model: "m" });

		expect(result.content).toBe("x");
		expect(result.stopReason).toBe("end_turn");
	});
});
