/**
 * M18b 验收测试（总工程师独立编写）：**ACP 最小通道**（ADR-036）。
 *
 * 测试策略：协议实现与传输解耦（`input` / `output` 注入）⇒ 用**内存双工流**驱动
 * **同一份**协议代码；不写"假服务端"来对着测。
 *
 * 覆盖：
 *  - `initialize`：协议版本 / 能力 / agentInfo；
 *  - `session/new`：交给 host 建会话，回 `sessionId`；
 *  - `session/prompt`：文本块拼接、**更新来自 host 回调**、`stopReason` 回传；
 *  - 参数错误 / 未知方法 / 同一会话并发 prompt（`-32000 busy`）；
 *  - `session/cancel`（通知）→ host.cancel；
 *  - 非 JSON 行忽略；EOF ⇒ `done` resolve 且 `close()` 调用了 host.close。
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type AcpSessionHost, type AcpSessionUpdate, createAcpServer } from "../src/acp/index.js";

interface Harness {
	readonly host: FakeHost;
	readonly server: ReturnType<typeof createAcpServer>;
	send(message: Record<string, unknown>): void;
	notify(method: string, params: unknown): void;
	/** 直接写一行原始文本（测试非 JSON 行的忽略行为）。 */
	raw(line: string): void;
	lines(): readonly Record<string, unknown>[];
	waitFor(predicate: () => boolean, what: string): Promise<void>;
	closeInput(): void;
}

class FakeHost implements AcpSessionHost {
	readonly updates: AcpSessionUpdate[] = [];
	readonly cancelled: string[] = [];
	closed = false;
	lastCwd?: string;
	lastPrompt?: { sessionId: string; text: string };
	block = false;
	private pending: ((value: { stopReason: "end_turn" }) => void) | undefined;

	async createSession(input: { cwd: string }): Promise<{ sessionId: string }> {
		this.lastCwd = input.cwd;
		return { sessionId: "sess-acp-1" };
	}

	async prompt(input: {
		sessionId: string;
		text: string;
		onUpdate: (update: AcpSessionUpdate) => void;
	}): Promise<{ stopReason: "end_turn" }> {
		this.lastPrompt = { sessionId: input.sessionId, text: input.text };
		const push = (update: AcpSessionUpdate): void => {
			this.updates.push(update);
			input.onUpdate(update);
		};
		push({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hello from acp" },
		});
		push({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", status: "in_progress" });
		if (this.block) {
			return new Promise((resolve) => {
				this.pending = resolve;
			});
		}
		return { stopReason: "end_turn" };
	}

	release(): void {
		this.pending?.({ stopReason: "end_turn" });
		this.pending = undefined;
	}

	cancel(sessionId: string): void {
		this.cancelled.push(sessionId);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

function harness(): Harness {
	const input = new PassThrough();
	const output = new PassThrough();
	const host = new FakeHost();
	const server = createAcpServer({ input, output, host });
	const received: Record<string, unknown>[] = [];

	output.setEncoding("utf8");
	let buffer = "";
	output.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const index = buffer.indexOf("\n");
			if (index < 0) break;
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line !== "") received.push(JSON.parse(line) as Record<string, unknown>);
		}
	});

	const send = (message: Record<string, unknown>): void => {
		input.write(`${JSON.stringify(message)}\n`);
	};

	return {
		host,
		server,
		send,
		notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
		raw: (line) => input.write(line),
		lines: () => received,
		async waitFor(predicate, what) {
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline) {
				if (predicate()) return;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(`timed out waiting for ${what}`);
		},
		closeInput: () => input.end(),
	};
}

describe("M18b ACP 最小通道（ADR-036）", () => {
	it("initialize：协议版本 / 能力 / agentInfo", async () => {
		const h = harness();
		h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await h.waitFor(() => h.lines().length === 1, "initialize response");
		expect(h.lines()[0]).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: 1,
				agentCapabilities: {
					loadSession: false,
					promptCapabilities: { image: false, audio: false, embeddedContext: false },
				},
				agentInfo: { name: "aster", version: "1.0.0" },
			},
		});
	});

	it("session/new：把 cwd 交给 host，回 sessionId", async () => {
		const h = harness();
		h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "d:\\work" } });
		await h.waitFor(() => h.lines().length === 1, "session/new response");
		expect(h.lines()[0]).toEqual({ jsonrpc: "2.0", id: 2, result: { sessionId: "sess-acp-1" } });
		expect(h.host.lastCwd).toBe("d:\\work");
	});

	it("session/prompt：只取 text 块、流式更新、回 stopReason", async () => {
		const h = harness();
		h.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "d:\\work" } });
		await h.waitFor(() => h.lines().length === 1, "new");
		h.send({
			jsonrpc: "2.0",
			id: 4,
			method: "session/prompt",
			params: {
				sessionId: "sess-acp-1",
				prompt: [
					{ type: "text", text: "look at " },
					{ type: "image", data: "ignored" },
					{ type: "text", text: "package.json" },
				],
			},
		});
		await h.waitFor(() => h.lines().some((line) => line.id === 4), "prompt response");
		expect(h.host.lastPrompt).toEqual({ sessionId: "sess-acp-1", text: "look at package.json" });

		const updates = h.lines().filter((line) => line.method === "session/update");
		expect(updates).toHaveLength(2);
		expect(updates[0]?.params).toEqual({
			sessionId: "sess-acp-1",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hello from acp" },
			},
		});
		expect(updates[1]?.params).toMatchObject({
			update: { sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" },
		});
		expect(h.lines().find((line) => line.id === 4)).toEqual({
			jsonrpc: "2.0",
			id: 4,
			result: { stopReason: "end_turn" },
		});
	});

	it("参数错误 / 未知方法 / 同会话并发 prompt", async () => {
		const h = harness();
		h.send({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId: "s" } });
		h.send({
			jsonrpc: "2.0",
			id: 6,
			method: "session/prompt",
			params: { sessionId: "s", prompt: [] },
		});
		h.send({ jsonrpc: "2.0", id: 7, method: "nope" });
		await h.waitFor(() => h.lines().length === 3, "errors");
		expect(h.lines().map((line) => (line.error as { code: number }).code)).toEqual([
			-32602, -32602, -32601,
		]);

		// 并发：第一条卡住，第二条必须快速被拒
		h.host.block = true;
		h.send({
			jsonrpc: "2.0",
			id: 8,
			method: "session/prompt",
			params: { sessionId: "s", prompt: [{ type: "text", text: "a" }] },
		});
		await h.waitFor(() => h.host.lastPrompt?.text === "a", "first prompt started");
		h.send({
			jsonrpc: "2.0",
			id: 9,
			method: "session/prompt",
			params: { sessionId: "s", prompt: [{ type: "text", text: "b" }] },
		});
		await h.waitFor(() => h.lines().some((line) => line.id === 9), "busy error");
		expect(h.lines().find((line) => line.id === 9)).toMatchObject({
			error: { code: -32000, message: "session s is busy" },
		});
		h.host.release();
		await h.waitFor(() => h.lines().some((line) => line.id === 8), "first prompt done");
	});

	it("session/cancel（通知）→ host.cancel；非 JSON 行忽略；EOF 触发 close", async () => {
		const h = harness();
		h.notify("session/cancel", { sessionId: "sess-acp-1" });
		await h.waitFor(() => h.host.cancelled.length === 1, "cancel");
		expect(h.host.cancelled).toEqual(["sess-acp-1"]);

		// 非 JSON 行：不该产生任何输出、也不该让协议循环死掉
		h.raw("this is not json\n");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.lines()).toHaveLength(0);
		// 仍在服务：再发一条合法请求必须能拿到响应
		h.send({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: 1 } });
		await h.waitFor(
			() => h.lines().some((line) => line.id === 10),
			"initialize after garbage line",
		);

		h.closeInput();
		await h.server.done;
		await h.server.close();
		expect(h.host.closed).toBe(true);
	});
});
