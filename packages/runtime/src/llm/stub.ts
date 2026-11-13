/**
 * Keyless stub provider：不回显真实模型，只按脚本「回放」流式事件。
 *
 * 用途：本模块测试、loop 测试，以及将来 CI 的无网络快照回放。
 * **绝不发任何网络请求、绝不接触 apiKey**。
 */
import type { StopReason, ToolCallRef } from "@aster/schema";
import type { LlmProvider, LlmRequest, LlmStreamEvent, LlmUsage } from "./types.js";

/** 单次 `stream()` 的回放脚本。 */
export interface StubScript {
	/** 逐条 yield 的文本分片；缺省时把 `content` 一次性发出。 */
	readonly chunks?: readonly string[];
	/** 显式最终正文；缺省为 `chunks` 拼接。 */
	readonly content?: string;
	readonly toolCalls?: readonly ToolCallRef[];
	readonly stopReason?: StopReason;
	readonly usage?: LlmUsage;
}

/** stub provider：在 `LlmProvider` 之上额外暴露收到的请求，便于断言。 */
export interface StubProvider extends LlmProvider {
	readonly calls: LlmRequest[];
}

/**
 * 创建 stub provider。
 *
 * @param script 单个脚本（每次调用都回放它），或脚本数组（每次 `stream()` 取下一个，取尽抛错）。
 */
export function createStubProvider(script: StubScript | readonly StubScript[]): StubProvider {
	const scripts: readonly StubScript[] = Array.isArray(script)
		? (script as readonly StubScript[])
		: [script as StubScript];
	const calls: LlmRequest[] = [];
	let cursor = 0;

	async function* replay(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
		if (cursor >= scripts.length) {
			throw new Error(`stub provider script exhausted (${scripts.length} script(s) consumed)`);
		}
		const current = scripts[cursor] as StubScript;
		cursor += 1;
		calls.push(request);

		const chunks = current.chunks ?? (current.content !== undefined ? [current.content] : []);
		for (const text of chunks) {
			yield { kind: "text-delta", text };
		}

		if (current.usage !== undefined) {
			yield { kind: "usage", usage: current.usage };
		}

		yield {
			kind: "done",
			message: {
				content: current.content ?? chunks.join(""),
				toolCalls: current.toolCalls ?? [],
				stopReason: current.stopReason ?? "end_turn",
			},
		};
	}

	return {
		id: "stub",
		calls,
		stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
			return replay(request);
		},
	};
}
