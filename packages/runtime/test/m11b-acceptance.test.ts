/**
 * M11b 验收测试（总工程师独立编写）：client/server 双向（ADR-022）。
 *
 * 覆盖：
 *  - **结构化帧 → 行**（纯函数）：`hello` 显示协议版本 + `resume`；各事件类型按 `type` 直接映射；
 *    **未知事件类型回退 `[event]`**（镜像**不丢事实**）；错误帧区分可续 / 不可续；
 *  - **SSE 解码**（纯函数 + 假 fetch）：跨分片、`\r\n`、多行 data、注释、坏 JSON → `bad_frame`；
 *  - **`--attach` 镜像**：hello / 事件 / 断线提示（含"重放 /api/sessions/<id>"）；TUI 模式进出 alt screen；
 *  - **`POST /api/sessions/:id/prompt` 真 http 端到端**：真的落 `user/message` + 跑出 `assistant/message`，
 *    seq 连续（**只经 persist 的单一写入路径**）、事件被喂进 SSE 扇出；
 *  - **服务端无审批通道** → `ask` **fail-closed deny**（越界写被拒、文件未生成、判定事件可审计）；
 *  - 边界与围栏：501 / 404 / 409（live 会话）/ 413 / 422 / 400 / 405。
 */
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent, SessionId, ToolCallId } from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { runAttachSession } from "../src/cli/attach.js";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import type { ToolRuntime } from "../src/loop/index.js";
import { createPermissionSystem } from "../src/permission/index.js";
import { createSessionStore } from "../src/persist/index.js";
import {
	connectEventStream,
	createEventFeed,
	createEventProducer,
	createPromptDriver,
	createSseDecoder,
	DEFAULT_MAX_BODY_BYTES,
	type EventSubscriber,
	isLoopbackHost,
	startServer,
} from "../src/serve/index.js";
import { selectShellProvider } from "../src/shell/index.js";
import { createDefaultToolset, createToolRegistry } from "../src/tools/index.js";
import { createTheme, describeEvent, describeFrame } from "../src/tui/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];
const plain = createTheme({ disabled: true });

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

/** 造一条事件（仅供纯函数断言，不落盘）。 */
function ev(type: string, payload: unknown, seq = 0): SessionEvent {
	return { seq, id: `evt_${seq}`, sessionId: "ses_test", type, at: "at", payload } as SessionEvent;
}

/** 建一个已落盘的会话。 */
async function seedSession(home: string, cwd: string, mode: "plan" | "build"): Promise<SessionId> {
	const store = createSessionStore({ home });
	const handle = await store.create({ cwd, mode });
	try {
		return handle.sessionId;
	} finally {
		await handle.close();
		await store.dispose();
	}
}

/** 读 JSONL 事实源（逐行 parse）。 */
function readEvents(home: string, sessionId: SessionId): SessionEvent[] {
	return readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

/** 真实工具运行时（4 原语），供权限 / 写工具端到端使用。 */
function buildTools(): ToolRuntime {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() }))
		registry.register(tool);
	return { ctx, registry };
}

/** 「一次写调用 + 一次收尾」的桩脚本。 */
function writeScript(target: string) {
	return [
		{
			content: "",
			toolCalls: [
				{
					callId: "call_write" as ToolCallId,
					toolName: "write",
					input: { path: target, content: "x" },
				},
			],
			stopReason: "tool_call" as const,
		},
		{ content: "done", toolCalls: [], stopReason: "end_turn" as const },
	];
}

/** 统一 POST 形状（省去多处重复的 fetch 样板）。 */
function postPrompt(url: string, sessionId: string, body: string): Promise<Response> {
	return fetch(`${url}/api/sessions/${sessionId}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

type Frame = Parameters<typeof describeFrame>[0];

/** 假 SSE 流（注入 `connect`）。 */
function fakeStream(frames: readonly Frame[]): {
	[Symbol.asyncIterator]: () => AsyncIterator<Frame>;
	close: () => void;
} {
	return {
		[Symbol.asyncIterator]: async function* () {
			for (const frame of frames) yield frame;
		},
		close: () => undefined,
	};
}

class FakeStdout extends EventEmitter {
	columns = 70;
	rows = 12;
	readonly chunks: string[] = [];
	write(text: string): void {
		this.chunks.push(text);
	}
	get text(): string {
		return this.chunks.join("");
	}
}

class FakeStdin extends EventEmitter {
	setRawMode(): void {}
}

/** 从订阅者按顺序取帧，直到满足条件（或超时）。 */
async function collectFrames(
	iterator: AsyncIterator<unknown>,
	done: (frames: Frame[]) => boolean,
	timeoutMs = 2000,
): Promise<Frame[]> {
	const frames: Frame[] = [];
	const started = Date.now();
	while (!done(frames)) {
		if (Date.now() - started > timeoutMs)
			throw new Error(`timed out after ${frames.length} frame(s)`);
		const next = await Promise.race([iterator.next(), delay(20).then(() => undefined)]);
		if (next === undefined || next.done) continue;
		frames.push(JSON.parse(String(next.value)) as Frame);
	}
	return frames;
}

describe("M11b 结构化帧 → 屏幕行（纯函数，消掉前缀嗅探）", () => {
	it("hello 帧显示协议版本与 resume；error 帧区分可续 / 不可续", () => {
		const hello = describeFrame(
			{ kind: "hello", protocolVersion: 1, resume: "replay-only" },
			plain,
		).join("\n");
		expect(hello).toContain("protocol v1");
		expect(hello).toContain("resume replay-only");
		expect(hello).toContain("no resume");

		const soft = describeFrame(
			{ kind: "error", code: "subscriber_overflow", message: "queue full", retryable: true },
			plain,
		).join("\n");
		expect(soft).toContain("[subscriber_overflow]");
		expect(soft).toContain("retryable: replay");

		const hard = describeFrame(
			{ kind: "error", code: "stream_failed", message: "b", retryable: false },
			plain,
		);
		expect(hard.join("\n")).toContain("not retryable");
	});

	it("按事件 type 直接映射（用户 / 助手 / 工具 / 模式 / 记忆 / 审批 / 子代理 / 收尾）", () => {
		const cases: [SessionEvent, string[]][] = [
			[ev("user/message", { content: "hi" }), ["› hi"]],
			[
				ev("assistant/message", {
					content: "a1",
					toolCalls: [{ callId: "c", toolName: "read", input: { path: "p" } }],
				}),
				["a1", '  → tool_call: read {"path":"p"}'],
			],
			[
				ev("tool/result", { callId: "c", toolName: "bash", ok: true, durationMs: 1 }),
				["  ← tool_result: bash ok"],
			],
			[
				ev("tool/result", {
					callId: "c",
					toolName: "write",
					ok: false,
					error: { code: "permission_denied", message: "no\nway", retryable: false },
					durationMs: 1,
				}),
				["  ← tool_result: write error(permission_denied): no"],
			],
			[ev("mode/changed", { from: "plan", to: "build", reason: "u" }), ["  mode: plan -> build"]],
			[
				ev("memory/injected", {
					target: "user-prefix",
					source: "s",
					content: "c",
					memoryIds: ["a", "b"],
				}),
				["  ~ memory: injected 2 record(s)"],
			],
			[
				ev("permission/decision", {
					callId: "c",
					toolName: "write",
					decision: "deny",
					reason: "r",
				}),
				["  ! permission: write -> deny"],
			],
			[
				ev("subagent/result", { childSessionId: "ses_c", kind: "fresh", ok: true, summary: "s" }),
				["  · subagent fresh: s (child ses_c)"],
			],
			[ev("turn/end", { turnId: "t", stopReason: "end_turn" }), ["  [turn stopped: end_turn]"]],
			[ev("session/end", { reason: "exit" }), ["  [session ended: exit]"]],
			// **未知事件类型不丢事实**：回退为 `[event] <type>`
			[ev("future/thing", { whatever: 1 }), ["  [event] future/thing"]],
		];
		for (const [event, expected] of cases) expect(describeEvent(event, plain)).toEqual(expected);

		// 上色只是包装：给定主题决定 SGR，且行内自闭合不渗行
		const colored = createTheme({ colorTerm: "truecolor" });
		const line = describeEvent(
			ev("permission/decision", { callId: "c", toolName: "w", decision: "deny", reason: "r" }),
			colored,
		)[0] as string;
		expect(line).toContain("\u001b[38;2;224;175;104m"); // warn 色
		expect(line.endsWith("\u001b[0m")).toBe(true);
	});
});

describe("M11b SSE 解码（纯函数 + 真实 fetch 形状）", () => {
	it("跨分片 / CRLF / 多行 data / 注释；坏 JSON → bad_frame", () => {
		const decoder = createSseDecoder();
		expect(decoder.push('data: {"kind":"hello","proto')).toEqual([]); // 半帧不吐
		const frames = decoder.push('colVersion":1,"resume":"replay-only"}\r\n\r\n');
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ kind: "hello" });

		// 多行 data 以 \n 拼回；注释行忽略
		const multi = createSseDecoder().push(
			': keep-alive\ndata: {"kind":"session","sessionId":\ndata: "ses_x"}\n\n',
		);
		expect(multi).toEqual([{ kind: "session", sessionId: "ses_x" }]);

		expect(createSseDecoder().push("data: {oops}\n\n")[0]).toMatchObject({
			kind: "error",
			code: "bad_frame",
			retryable: false,
		});
	});

	it("connectEventStream：200 时逐帧产出；非 200 回一条可读 error 帧", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode('data: {"kind":"event","event":{"type":"user/message"}}\n\n'),
				);
				controller.close();
			},
		});
		const okFetch = (async () => ({ status: 200, body })) as unknown as typeof fetch;
		const frames: Frame[] = [];
		for await (const frame of connectEventStream("http://127.0.0.1:1/", { fetch: okFetch }))
			frames.push(frame);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ kind: "event" });

		const failFetch = (async () => ({ status: 500, body: null })) as unknown as typeof fetch;
		const failed: Frame[] = [];
		for await (const frame of connectEventStream("http://127.0.0.1:1", { fetch: failFetch }))
			failed.push(frame);
		expect(failed[0]).toMatchObject({ kind: "error", code: "connect_failed", retryable: false });
	});
});

describe("M11b `--attach` 只读镜像（假流；非 TTY 逐行）", () => {
	it("镜像 hello + 事件；断线提示「重放 /api/sessions/<id>」", async () => {
		const sink = new FakeStdout();
		const result = await runAttachSession({
			url: "http://127.0.0.1:8787/",
			tui: false,
			theme: plain,
			sink: sink as never,
			connect: () =>
				fakeStream([
					{ kind: "hello", protocolVersion: 1, resume: "replay-only" },
					{ kind: "event", event: ev("user/message", { content: "remote hi" }, 0) },
					{ kind: "event", event: ev("assistant/message", { content: "remote reply" }, 1) },
				]) as never,
		});

		expect(sink.text).toContain("(read-only mirror)");
		expect(sink.text).toContain("protocol v1");
		expect(sink.text).toContain("› remote hi");
		expect(sink.text).toContain("remote reply");
		// 断线 = 明示契约：重连并**整段回放**（SSE 不做续传）
		expect(sink.text).toContain(
			"disconnected — replay http://127.0.0.1:8787/api/sessions/ses_test",
		);
		// 会话身份随**第一条 event 帧**到达（`session/start` 不进流）
		expect(result.sessionId).toBe("ses_test");
		expect(result.frames).toBe(3);
	});

	it("overflow（可续）后提示重放；不可续错误帧即收尾（不再吃后续帧）", async () => {
		const overflowSink = new FakeStdout();
		await runAttachSession({
			url: "http://h",
			tui: false,
			theme: plain,
			sink: overflowSink as never,
			connect: () =>
				fakeStream([
					{ kind: "event", event: ev("user/message", { content: "x" }, 0) },
					{ kind: "error", code: "subscriber_overflow", message: "queue full", retryable: true },
				]) as never,
		});
		expect(overflowSink.text).toContain("subscriber_overflow");
		expect(overflowSink.text).toContain("disconnected — replay http://h/api/sessions/ses_test");

		const hardSink = new FakeStdout();
		const hard = await runAttachSession({
			url: "http://h",
			tui: false,
			theme: plain,
			sink: hardSink as never,
			connect: () =>
				fakeStream([
					{ kind: "error", code: "stream_failed", message: "boom", retryable: false },
					{ kind: "event", event: ev("user/message", { content: "never" }, 0) },
				]) as never,
		});
		expect(hardSink.text).toContain("not retryable");
		expect(hard.frames).toBe(1); // 不可续 → 立即收尾
	});

	it("TUI 模式复用 M10 渲染内核：进 / 出 alt screen（严格还原）", async () => {
		const sink = new FakeStdout();
		await runAttachSession({
			url: "http://h",
			tui: true,
			intervalMs: 0,
			theme: plain,
			sink: sink as never,
			keys: new FakeStdin() as never,
			connect: () =>
				fakeStream([
					{ kind: "hello", protocolVersion: 1, resume: "replay-only" },
					{ kind: "event", event: ev("user/message", { content: "hi" }, 0) },
				]) as never,
		});
		expect(sink.text).toContain("\u001b[?1049h");
		expect(sink.text).toContain("\u001b[?1049l");
		expect(sink.text).toContain("attach"); // 状态条
	});

	it("参数与围栏：`--attach` 必须有 url；写路径只在回环提供", () => {
		expect(parseArgs(["--attach", "http://127.0.0.1:8787"])).toMatchObject({
			attach: "http://127.0.0.1:8787",
		});
		expect(() => parseArgs(["--attach"])).toThrowError(/--attach requires/);
		expect(() => parseArgs(["--attach", " "])).toThrowError(/--attach requires/);

		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("192.168.1.5")).toBe(false);
		expect(DEFAULT_MAX_BODY_BYTES).toBe(65536);
	});
});

describe("M11b POST /api/sessions/:id/prompt（真 http：单一写入者 + 事件进流）", () => {
	it("真的落 user/message 并跑出 assistant/message；seq 连续可重放；事件喂进 SSE 扇出", async () => {
		const home = newTemp("chenxi-m11b-prompt-");
		const cwd = newTemp("chenxi-m11b-prompt-cwd-");
		const sessionId = await seedSession(home, cwd, "build");
		const before = readEvents(home, sessionId).length;

		const feed = createEventFeed();
		const subscriber: EventSubscriber = feed.subscribe();
		const iterator = subscriber[Symbol.asyncIterator]();
		const published: SessionEvent[] = [];
		const driver = createPromptDriver({
			home,
			provider: createStubProvider([
				{ content: "REMOTE REPLY", toolCalls: [], stopReason: "end_turn" },
			]),
			model: "stub",
			permission: createPermissionSystem(),
			onEvent: (event) => {
				published.push(event);
				createEventProducer(feed)(event);
			},
		});
		const server = await startServer({ home, feed, port: 0, driver });
		try {
			const response = await postPrompt(
				server.url,
				sessionId,
				JSON.stringify({ prompt: "remote hi" }),
			);
			expect(response.status).toBe(200);
			const result = (await response.json()) as {
				kind: string;
				content: string;
				stopReason: string;
				eventCount: number;
			};
			expect(result).toMatchObject({
				kind: "prompt-result",
				content: "REMOTE REPLY",
				stopReason: "end_turn",
			});

			// 事实源：真的落了两条模型可见事实，且 **seq 连续**（出现第二个写入者 → seq 打架）
			const events = readEvents(home, sessionId);
			expect(result.eventCount).toBe(4);
			expect(events.slice(before).map((event) => event.seq)).toEqual([
				before,
				before + 1,
				before + 2,
				before + 3,
			]);
			expect(events.find((event) => event.type === "user/message")).toMatchObject({
				payload: { content: "remote hi" },
			});
			expect(events.find((event) => event.type === "assistant/message")).toMatchObject({
				payload: { content: "REMOTE REPLY" },
			});

			// 可重放：seq 重复会让 `createEventLog` hydrate 抛错 ⇒ "能 resume"即证明单一写入路径
			const verify = createSessionStore({ home });
			await expect(verify.resume(sessionId)).resolves.toBeDefined();
			await verify.dispose();

			// 事件被喂进 SSE 扇出（镜像端能看见远端 prompt 的整个回合）
			expect(published.map((event) => event.type)).toEqual([
				"user/message",
				"turn/start",
				"assistant/message",
				"turn/end",
			]);
			const frames = await collectFrames(iterator, (f) => f.length >= 4);
			expect(
				frames.map((frame) => (frame.kind === "event" ? frame.event.type : frame.kind)),
			).toEqual(published.map((event) => event.type));
		} finally {
			subscriber.close();
			await server.close();
		}
	});

	it("服务端**无审批通道**：越界写 ask → fail-closed deny；文件未生成；判定经 trace 出口可审计", async () => {
		const home = newTemp("chenxi-m11b-deny-");
		const cwd = newTemp("chenxi-m11b-deny-cwd-");
		const target = join(newTemp("chenxi-m11b-deny-out-"), "outside.txt");
		const sessionId = await seedSession(home, cwd, "build");

		const published: SessionEvent[] = [];
		const driver = createPromptDriver({
			home,
			provider: createStubProvider(writeScript(target)),
			model: "stub",
			tools: buildTools(),
			permission: createPermissionSystem(),
			onEvent: (event) => published.push(event),
		});
		const server = await startServer({ home, feed: createEventFeed(), port: 0, driver });
		try {
			const response = await postPrompt(
				server.url,
				sessionId,
				JSON.stringify({ prompt: "write outside" }),
			);
			expect(response.status).toBe(200);

			const events = readEvents(home, sessionId);
			const decision = events.find((event) => event.type === "permission/decision");
			expect(decision?.payload).toMatchObject({ toolName: "write", decision: "deny" });
			expect(String((decision?.payload as { reason: string }).reason)).toContain(
				"no approval channel",
			);

			const toolResult = events.find((event) => event.type === "tool/result");
			expect(toolResult?.payload).toMatchObject({
				ok: false,
				error: { code: "permission_denied", retryable: false },
			});
			expect(existsSync(target)).toBe(false); // 越界写**真的没有发生**
			// 回归（M11b 收敛的漏挂）：审批判定**经 trace 出口**，订阅者看得到
			expect(published.map((event) => event.type)).toContain("permission/decision");
		} finally {
			await server.close();
		}
	});

	it("边界与围栏：501（无 driver）/ 405 / 400 / 422 / 413 / 404 / 409（live）", async () => {
		const home = newTemp("chenxi-m11b-edges-");
		const cwd = newTemp("chenxi-m11b-edges-cwd-");
		const sessionId = await seedSession(home, cwd, "build");
		const feed = createEventFeed();

		// 未注入 driver：写路径**不存在**（501）
		const bare = await startServer({ home, feed, port: 0 });
		try {
			const promptUrl = `${bare.url}/api/sessions/${sessionId}/prompt`;
			const post = await fetch(promptUrl, {
				method: "POST",
				body: JSON.stringify({ prompt: "x" }),
			});
			expect(post.status).toBe(501);
			expect(await post.json()).toMatchObject({ code: "prompt_unavailable" });
			expect((await fetch(promptUrl)).status).toBe(405); // 该路由只允许 POST
		} finally {
			await bare.close();
		}

		const driver = createPromptDriver({
			home,
			provider: createStubProvider([{ content: "ok", toolCalls: [], stopReason: "end_turn" }]),
			model: "stub",
			onEvent: () => undefined,
			// 该会话"正在被本进程驱动" → 一律 409（一个会话一个写入者）
			isLive: (id) => id === sessionId,
		});
		const served = await startServer({ home, feed, port: 0, driver, maxBodyBytes: 32 });
		try {
			const post = (body: string) => postPrompt(served.url, sessionId, body);
			expect((await post("{")).status).toBe(400); // invalid_json
			expect((await post(JSON.stringify({ prompt: "   " }))).status).toBe(422); // invalid_prompt
			expect((await post(JSON.stringify({ prompt: "x".repeat(200) }))).status).toBe(413); // 超上限

			const missing = await postPrompt(served.url, "ses_nope", JSON.stringify({ prompt: "x" }));
			expect(missing.status).toBe(404); // 不存在
			expect(await missing.json()).toMatchObject({ code: "session_not_found" });

			const live = await post(JSON.stringify({ prompt: "x" }));
			expect(live.status).toBe(409); // 本进程正在驱动 → 拒写
			expect(await live.json()).toMatchObject({ code: "session_live" });
		} finally {
			await served.close();
		}
	});
});
