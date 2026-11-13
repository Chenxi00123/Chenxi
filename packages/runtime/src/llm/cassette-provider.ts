/**
 * `LlmProvider` 装饰器（M19 / ADR-037）：录制与回放。
 *
 * 为什么包在 provider 外层：主循环 `loop.ts` **一行不改**，模型上下文仍只来自
 * `deriveMessages` ⇒ 不新增任何写入路径；子代理共用同一 provider 实例，其调用也会被录制。
 *
 * 纪律：
 * - 录制 provider 的 `id` **保持 `inner.id`**（加 `--record` 不改变既有输出 / 日志）；
 * - 录制是**显式动作**：`onExchange`（落盘）抛错必须 fail-fast 向上抛，绝不静默吞掉；
 * - 回放是 **fail-closed**：未命中 / 队列耗尽一律 `CassetteError`，绝不伪造模型输出。
 */
import {
	type CassetteDocument,
	CassetteError,
	type CassetteExchange,
	type CassetteRequest,
	requestKeyOf,
} from "./cassette.js";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "./types.js";

/** 一次往返结束后的落盘回调（同步或异步均可；抛错即 fail-fast）。 */
export interface RecordingProviderOptions {
	readonly onExchange: (exchange: CassetteExchange) => void | Promise<void>;
}

/** 回放 provider 额外暴露的进度（仅测试与审计使用）。 */
export interface ReplayProvider extends LlmProvider {
	readonly consumed: number;
	readonly remaining: number;
}

/**
 * 快照一次请求（**去掉 `signal`**，其余字段按 JSON 语义归一化）。
 *
 * 用 JSON 往返复制：调用方后续若改动自己的对象，不会把"已发出的请求"改写成另一份事实；
 * 同时保证 cassette 里只出现可序列化字段（signal 等执行期能力天然被排除）。
 */
export function toCassetteRequest(request: LlmRequest): CassetteRequest {
	const base: Record<string, unknown> = { model: request.model, messages: request.messages };
	if (request.tools !== undefined) base.tools = request.tools;
	if (request.temperature !== undefined) base.temperature = request.temperature;
	return JSON.parse(JSON.stringify(base)) as CassetteRequest;
}

/**
 * 录制装饰器：事件**边收边 yield**（不缓冲后重放），结束后恰好调用一次 `onExchange`。
 *
 * 三种收尾都覆盖：
 * - 正常结束 ⇒ `complete: true`；
 * - 内层抛错 ⇒ 记 `error`（原始 message）并**原样重抛**；
 * - 消费者提前中止 ⇒ 记已收到的事件 + `complete: false`，**不伪造 error**。
 */
export function createRecordingProvider(
	inner: LlmProvider,
	options: RecordingProviderOptions,
): LlmProvider {
	let nextIndex = 0;

	async function* record(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
		const snapshot = toCassetteRequest(request);
		const index = nextIndex;
		nextIndex += 1;
		const events: LlmStreamEvent[] = [];
		let outcome: { complete: boolean; error?: string } | undefined;

		try {
			for await (const event of inner.stream(request)) {
				events.push(event);
				yield event;
			}
			outcome = { complete: true };
		} catch (error) {
			outcome = {
				complete: false,
				error: error instanceof Error ? error.message : String(error),
			};
			throw error;
		} finally {
			// 消费者提前中止时 `outcome` 仍是 undefined（generator 的 return 直接走到这里）。
			const finished = outcome ?? { complete: false };
			const exchange: CassetteExchange = {
				kind: "exchange",
				index,
				request: snapshot,
				requestKey: requestKeyOf(snapshot),
				events,
				complete: finished.complete,
				...(finished.error === undefined ? {} : { error: finished.error }),
			};
			await options.onExchange(exchange);
		}
	}

	return { id: inner.id, stream: (request) => record(request) };
}

/** 把最后一条消息压成一行预览（最多 80 字，可读错误里用来定位请求差异）。 */
function previewMessage(request: CassetteRequest): string {
	const last = request.messages.at(-1);
	if (last === undefined) return "(no messages)";
	const oneLine = last.content.replace(/\s+/g, " ").trim();
	const text = oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
	return `${last.role}: ${text}`;
}

function mismatchMessage(request: CassetteRequest, key: string, remaining: number): string {
	const toolNames = (request.tools ?? []).map((tool) => tool.function.name).join(", ");
	return (
		`cassette mismatch: no recorded exchange for request key ${key.slice(0, 12)} ` +
		`(messages=${request.messages.length}, last=${previewMessage(request)}, ` +
		`tools=[${toolNames}], ${remaining} exchange(s) remaining). ` +
		"回放需与录制相同的 cwd / mode / 工具配置"
	);
}

/**
 * 回放 provider：按 `requestKey` 建 **FIFO 队列**（同一 key 多次出现按记录顺序消费）。
 *
 * 命中 ⇒ 逐条 yield 与录制**完全相同**的事件；若该回合失败，yield 完已记录事件后
 * 抛 `new Error(原始 error message)`。未命中 / 队列耗尽 ⇒ `CassetteError`。
 */
export function createReplayProvider(cassette: CassetteDocument): ReplayProvider {
	const queues = new Map<string, CassetteExchange[]>();
	for (const exchange of cassette.exchanges) {
		const queue = queues.get(exchange.requestKey);
		if (queue === undefined) queues.set(exchange.requestKey, [exchange]);
		else queue.push(exchange);
	}
	const total = cassette.exchanges.length;
	let consumed = 0;

	async function* replay(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
		const snapshot = toCassetteRequest(request);
		const key = requestKeyOf(snapshot);
		const next = queues.get(key)?.shift();
		if (next === undefined)
			throw new CassetteError(mismatchMessage(snapshot, key, total - consumed));
		consumed += 1;
		for (const event of next.events) yield event;
		if (next.error !== undefined) throw new Error(next.error);
	}

	return {
		id: "cassette-replay",
		get consumed() {
			return consumed;
		},
		get remaining() {
			return total - consumed;
		},
		stream: (request) => replay(request),
	};
}
