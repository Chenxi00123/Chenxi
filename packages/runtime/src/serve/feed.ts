/**
 * 事件扇出内核（ADR-021）：**单全局订阅 + 每连接有界队列**。
 *
 * 参考 OpenCode 的背压形态（公开源码：`packages/server/src/event-feed.ts:8,64-68`，
 * 容量 `4096`、队列满即**只断该订阅者**）。三条不变量：
 *  1. **`publish` 绝不等待消费者**——背压只发生在每连接的队列上，绝不发生在发布者；
 *     否则一个慢客户端会把整个 harness 卡住。
 *  2. **队列满 = 只该订阅者出局**（`overflow`），其他连接**不受任何影响**；
 *  3. **编码失败 = 全体失败**——一条事件序列化不出来是**格式级 bug**，不能让"一个订阅者坏了"
 *     掩盖它，因此以**同一个**错误收尾全部订阅者。
 *
 * 本文件**零依赖、不碰 IO**，因此可在测试里精确构造"慢消费者"。
 */

/** 每连接队列容量（与 OpenCode 同一取值；导出以便测试与文档引用）。 */
export const SUBSCRIBER_CAPACITY = 4096;

export class SubscriberOverflowError extends Error {
	readonly code = "subscriber_overflow";
	readonly capacity: number;
	constructor(capacity: number) {
		super(
			`subscriber queue is full (capacity ${capacity}); this connection is dropped, others are unaffected`,
		);
		this.name = "SubscriberOverflowError";
		this.capacity = capacity;
	}
}

/** 事件源：任何"已记录事件"的序列（`persist` 的 append 回调即可接上）。 */
export type EventSource = (event: unknown) => void;

export interface EventSubscriber {
	/** 逐条取事件；被 `overflow` / `failAll` / `close` 收尾时结束或抛出。 */
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
	/** 主动解除订阅（连接断开时调用）。 */
	close(): void;
	/** 当前积压条数（供测试与可观测性）。 */
	readonly pending: number;
	/** 该订阅者是否已出局（overflow / 已关闭）。 */
	readonly dropped: boolean;
}

export interface EventFeed {
	/** 发布一条**已记录**事件（绝不 await 消费者）。 */
	publish(event: unknown): void;
	subscribe(): EventSubscriber;
	readonly subscriberCount: number;
}

interface Waiter {
	readonly resolve: () => void;
}

/** 一个有界队列 + 一个消费者：满即出局（丢弃该订阅者，而不是悄悄丢事件）。 */
function createSubscriber(
	capacity: number,
): EventSubscriber & { push(event: unknown): boolean; fail(error: unknown): void; finish(): void } {
	const buffer: unknown[] = [];
	let waiter: Waiter | undefined;
	let failure: unknown;
	let closed = false;

	const wake = (): void => {
		const current = waiter;
		waiter = undefined;
		current?.resolve();
	};

	return {
		get pending() {
			return buffer.length;
		},
		get dropped() {
			return closed;
		},
		close() {
			closed = true;
			buffer.length = 0;
			wake();
		},
		/** 入队：队列满 -> 返回 false（调用方据此让该订阅者出局）。 */
		push(event) {
			if (closed || failure !== undefined) return false;
			if (buffer.length >= capacity) return false;
			buffer.push(event);
			wake();
			return true;
		},
		fail(error) {
			failure = error;
			closed = true;
			buffer.length = 0;
			wake();
		},
		finish() {
			closed = true;
			wake();
		},
		[Symbol.asyncIterator]() {
			return {
				next: async (): Promise<IteratorResult<unknown>> => {
					for (;;) {
						if (buffer.length > 0) {
							return { done: false, value: buffer.shift() };
						}
						if (failure !== undefined) throw failure;
						if (closed) return { done: true, value: undefined };
						await new Promise<void>((resolve) => {
							waiter = { resolve };
						});
					}
				},
			};
		},
	};
}

export function createEventFeed(options: { readonly capacity?: number } = {}): EventFeed {
	const capacity = options.capacity ?? SUBSCRIBER_CAPACITY;
	const subscribers = new Set<ReturnType<typeof createSubscriber>>();

	/** 全体收尾（编码失败这类"格式级 bug"用；绝不让它只影响一个订阅者）。 */
	const failAll = (error: unknown): void => {
		const current = [...subscribers];
		subscribers.clear();
		for (const subscriber of current) subscriber.fail(error);
	};

	return {
		get subscriberCount() {
			return subscribers.size;
		},
		publish(event) {
			if (subscribers.size === 0) return;
			// 单全局"编码"：所有订阅者共享同一份序列化结果（OpenCode 同款）
			let encoded: string;
			try {
				encoded = JSON.stringify(event);
			} catch (error) {
				failAll(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			for (const subscriber of [...subscribers]) {
				// offer 失败（队列满）-> 只删掉这一个，并以 overflow 收尾
				if (subscriber.push(encoded)) continue;
				subscribers.delete(subscriber);
				subscriber.fail(new SubscriberOverflowError(capacity));
			}
		},
		subscribe() {
			const subscriber = createSubscriber(capacity);
			subscribers.add(subscriber);
			return {
				get pending() {
					return subscriber.pending;
				},
				get dropped() {
					return subscriber.dropped;
				},
				close() {
					subscribers.delete(subscriber);
					subscriber.close();
				},
				[Symbol.asyncIterator]: () => subscriber[Symbol.asyncIterator](),
			} satisfies EventSubscriber;
		},
	};
}
