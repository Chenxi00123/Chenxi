/**
 * SSE 客户端（ADR-022）：把 `GET <url>/api/event` 的文本流解成 `StreamFrame`。
 *
 * 分工：
 *  - `createSseDecoder()`：**纯解码**（不碰 IO）——按空行分帧、只取 `data:` 字段、
 *    **容忍跨分片**与 `\r\n` 行尾；
 *  - `connectEventStream(url)`：`fetch` + `AbortController`，返回一个可 `close()` 的异步迭代器。
 *
 * 坏 JSON 的处理是**显式**的：在**客户端本地**合成为一条可读 `error` 帧（`code: "bad_frame"`）
 * 交给镜像渲染——既不静默吞掉，也不让一帧坏数据把整条流打死。
 */
import type { StreamFrame } from "@aster/protocol";

/** SSE 增量解码器：喂进任意分片，吐出**已完整**的帧。 */
export function createSseDecoder(): { push(chunk: string): StreamFrame[] } {
	let buffer = "";
	const decoded: StreamFrame[] = [];

	/** 解一个 SSE 事件块（`field: value` 行组成），只关心 `data`；空块不产生帧。 */
	const decodeBlock = (block: string): void => {
		const data: string[] = [];
		for (const rawLine of block.split("\n")) {
			if (rawLine === "" || rawLine.startsWith(":")) continue; // 空行 / 注释
			const colon = rawLine.indexOf(":");
			const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
			if (field !== "data") continue; // 只关心 data 字段（event/id/retry 未使用）
			let value = colon === -1 ? "" : rawLine.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			data.push(value);
		}
		if (data.length === 0) return;
		const payload = data.join("\n");
		try {
			decoded.push(JSON.parse(payload) as StreamFrame);
		} catch (error) {
			decoded.push({
				kind: "error",
				code: "bad_frame",
				message: `malformed frame payload (${error instanceof Error ? error.message : String(error)}): ${payload.slice(0, 120)}`,
				retryable: false,
			});
		}
	};

	return {
		push(chunk: string): StreamFrame[] {
			// 归一化 CRLF（对整段缓冲做，因此**跨分片**的 \r\n 也能被正确拼回）
			buffer = `${buffer}${chunk}`.replace(/\r\n/g, "\n");
			for (;;) {
				const end = buffer.indexOf("\n\n");
				if (end === -1) break;
				const block = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				decodeBlock(block);
			}
			return decoded.splice(0, decoded.length);
		},
	};
}

/** 可关闭的事件流（`close()` 会中止底层请求）。 */
export interface EventStream extends AsyncIterable<StreamFrame> {
	close(): void;
}

export interface ConnectOptions {
	/** `fetch` 注入（测试用；缺省全局 `fetch`）。 */
	readonly fetch?: typeof fetch;
}

/** 连上 `GET <url>/api/event`：逐条产出帧，直到流结束或被 `close()`。 */
export function connectEventStream(url: string, options: ConnectOptions = {}): EventStream {
	const endpoint = `${url.replace(/\/+$/, "")}/api/event`;
	const doFetch = options.fetch ?? fetch;
	const abort = new AbortController();

	async function* iterate(): AsyncGenerator<StreamFrame> {
		const response = await doFetch(endpoint, {
			headers: { accept: "text/event-stream" },
			signal: abort.signal,
		});
		if (response.status !== 200 || response.body === null) {
			yield {
				kind: "error",
				code: "connect_failed",
				message: `unexpected HTTP ${response.status} from ${endpoint}`,
				retryable: false,
			} satisfies StreamFrame;
			return;
		}
		const reader = response.body.getReader();
		const textDecoder = new TextDecoder();
		const sse = createSseDecoder();
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				for (const frame of sse.push(textDecoder.decode(chunk.value, { stream: true }))) {
					yield frame;
				}
			}
		} finally {
			// 无论是正常结束还是被 close() 中止，都释放底层 reader
			await reader.cancel().catch(() => undefined);
		}
	}

	return {
		[Symbol.asyncIterator]: () => iterate(),
		close: () => abort.abort(),
	};
}
