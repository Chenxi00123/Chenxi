/**
 * M13d-1 验收测试（总工程师独立编写）：桌面版**能续跑一条已记录会话**（ADR-029 增补）。
 *
 * 这是桌面版与 CLI/TUI 对齐的**功能缺口**之一（CLI 有 `--resume`，桌面此前只能只读回放）：
 *  - `resume(sessionId)` 之后，新 prompt 落进**同一条 JSONL**（同一 sessionId、seq 继续）；
 *  - 续跑前先把**当前**会话收掉（EOF，**不**中断），并**等它收尾**（一个会话一个写入者）；
 *  - 已经就是当前会话时**不做任何事**（绝不"关掉再重开"它）；
 *  - 真窗口侧由 `--self-check` 实测（`SELFCHECK.resumed`），冒烟脚本据此断言。
 *
 * `vitest` 里**不**拉 Electron ⇒ 这一层测的是纯 Node 的 `src/session.ts`。
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cli } from "@chenxi/runtime";
import type { SessionEvent } from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { EventCard } from "../src/host.js";
import { createDesktopSessions, createLiveSession, type LiveSession } from "../src/session.js";
import { makeTempDir } from "./helpers/tmp.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const temps: string[] = [];

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("waitFor: condition not met within timeout");
}

async function bootstrap(extra: Partial<cli.CliOptions>) {
	const options: cli.CliOptions = { list: false, rebuildIndex: false, doctor: false, ...extra };
	return cli.bootstrapSessionRuntime({ options, output: { write: () => undefined } });
}

function readEvents(home: string, sessionId: string): SessionEvent[] {
	return readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

function sessionIds(home: string): string[] {
	const dir = join(home, "sessions");
	if (!existsSync(dir)) return []; // 还没建过任何会话时目录不存在 ⇒ 空集（不是错误）
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => name.slice(0, -".jsonl".length));
}

function collector() {
	const cards: EventCard[] = [];
	const ready: string[] = [];
	return { cards, ready };
}

/** 录一条真实会话（stub provider；只用于制造"已记录的事实"）。 */
async function record(home: string, prompt: string): Promise<string> {
	const runtime = await bootstrap({ home, stub: "hi", noTools: true });
	const session: LiveSession = createLiveSession({
		runtime,
		home,
		mode: "plan",
		callbacks: {
			onReady: () => undefined,
			onEvent: () => undefined,
			onText: () => undefined,
			onApproval: () => undefined,
		},
	});
	session.sendPrompt(prompt);
	session.close();
	const result = await session.done;
	await runtime.dispose();
	return result.sessionId;
}

describe("M13d-1 续跑（resume）：接着跑同一条会话", () => {
	it("resume 后新 prompt 落进**同一条 JSONL**：同一 sessionId、seq 继续、两条 user/message 同文件", async () => {
		const home = newTemp("chenxi-m13d1-resume-");
		const recordedId = await record(home, "first message");
		const before = readEvents(home, recordedId);

		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const seen = collector();
		const sessions = createDesktopSessions({
			runtime,
			home,
			callbacks: {
				onReady: (id) => void seen.ready.push(id),
				onEvent: (card) => void seen.cards.push(card),
				onText: () => undefined,
				onApproval: () => undefined,
			},
		});

		await sessions.resume(recordedId);
		await waitFor(() => sessions.activeSessionId() === recordedId);
		sessions.sendPrompt("second message");
		await waitFor(() =>
			seen.cards.some((card) => card.type === "user/message" && card.text === "second message"),
		);
		await sessions.dispose();
		await runtime.dispose();

		// ① 会话 id 就是**被恢复的那条**（onReady 回传同一个 id）
		expect(seen.ready[0]).toBe(recordedId);
		// ② 没有新开会话：数据根里仍然只有这一条会话文件
		expect(sessionIds(home)).toEqual([recordedId]);
		// ③ 两条 prompt 落在**同一个文件**里，且 seq 严格连续（旧事实在前、新事实续上）
		const after = readEvents(home, recordedId);
		expect(after.length).toBeGreaterThan(before.length);
		const prompts = after.filter((event) => event.type === "user/message");
		if (prompts[0]?.type === "user/message" && prompts[1]?.type === "user/message") {
			expect(prompts[0].payload.content).toBe("first message");
			expect(prompts[1].payload.content).toBe("second message");
		} else {
			throw new Error("expected two user/message events");
		}
		// ④ seq **紧接其后**继续（无空洞、无重置）——这才是"接着跑同一条会话"的要害
		const maxBefore = Math.max(...before.map((event) => event.seq));
		const resumedSeqs = after.map((event) => event.seq).filter((seq) => seq > maxBefore);
		expect(resumedSeqs).toHaveLength(after.length - before.length);
		expect(Math.min(...resumedSeqs)).toBe(maxBefore + 1);
	});

	it("resume 会先收掉**当前**会话（EOF，不中断），新活动会话改成被恢复的那条", async () => {
		const home = newTemp("chenxi-m13d1-switch-");
		const recordedId = await record(home, "recorded only");
		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const seen = collector();
		const sessions = createDesktopSessions({
			runtime,
			home,
			callbacks: {
				onReady: (id) => void seen.ready.push(id),
				onEvent: (card) => void seen.cards.push(card),
				onText: () => undefined,
				onApproval: () => undefined,
			},
		});

		// 先开一条**新**会话并让它成为活动会话
		sessions.sendPrompt("on the new session");
		await waitFor(() => sessions.activeSessionId() !== null);
		const freshId = sessions.activeSessionId();
		expect(freshId).not.toBe(recordedId);

		// 再恢复那条已记录的会话 ⇒ 旧的被收尾（session/end{exit}），活动会话换成 recordedId
		await sessions.resume(recordedId);
		await waitFor(() => sessions.activeSessionId() === recordedId);

		await sessions.dispose();
		await runtime.dispose();

		if (freshId === null) throw new Error("expected a fresh session id");
		const freshEvents = readEvents(home, freshId);
		const last = freshEvents.at(-1);
		expect(last?.type).toBe("session/end");
		if (last?.type === "session/end") expect(last.payload.reason).toBe("exit");
		// 「关窗/退出 ≠ 中断」的同一杠：没有任何回合被判 error
		expect(
			freshEvents.some(
				(event) => event.type === "turn/end" && event.payload.stopReason === "error",
			),
		).toBe(false);
		expect(seen.ready).toContain(recordedId);
	});

	it("已经就是当前会话 ⇒ no-op（**不**关掉再重开：不产生多余的 session/end）", async () => {
		const home = newTemp("chenxi-m13d1-noop-");
		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const sessions = createDesktopSessions({
			runtime,
			home,
			callbacks: {
				onReady: () => undefined,
				onEvent: () => undefined,
				onText: () => undefined,
				onApproval: () => undefined,
			},
		});

		sessions.sendPrompt("alpha");
		await waitFor(() => sessions.activeSessionId() !== null);
		const id = sessions.activeSessionId();
		if (id === null) throw new Error("expected an active session");
		await sessions.resume(id); // 已是当前会话 ⇒ 什么都不做
		sessions.sendPrompt("beta");
		await sessions.dispose();
		await runtime.dispose();

		const events = readEvents(home, id);
		// 只有 dispose 时那一条 session/end（若 resume 真的"关掉再重开"，这里会出现两条）
		expect(events.filter((event) => event.type === "session/end")).toHaveLength(1);
		const prompts = events.filter((event) => event.type === "user/message");
		expect(prompts).toHaveLength(2);
	});

	it("**先 reset 再 resume 同一条**（真窗口自检就是这个顺序）⇒ 绝不出现两个写入者：seq 严格递增、无重复", async () => {
		const home = newTemp("chenxi-m13d1-reset-resume-");
		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const sessions = createDesktopSessions({
			runtime,
			home,
			callbacks: {
				onReady: () => undefined,
				onEvent: () => undefined,
				onText: () => undefined,
				onApproval: () => undefined,
			},
		});

		sessions.sendPrompt("one");
		await waitFor(() => sessions.activeSessionId() !== null);
		const id = sessions.activeSessionId();
		if (id === null) throw new Error("expected an active session");

		// `reset()` 把当前会话摘掉并让它 EOF 收尾；紧接着 `resume` **同一条**——
		// 若不等它收尾，就会有第二个句柄同时写这条事实源（实测会写出重复 seq）。
		sessions.reset();
		await sessions.resume(id);
		sessions.sendPrompt("two");
		await waitFor(() => sessions.activeSessionId() === id);
		await sessions.dispose();
		await runtime.dispose();

		const seqs = readEvents(home, id).map((event) => event.seq);
		const sorted = [...seqs].sort((a, b) => a - b);
		expect(seqs).toEqual(sorted); // 单调
		expect(new Set(seqs).size).toBe(seqs.length); // 无重复
	});

	it("恢复不存在的会话 ⇒ 快速失败（可读错误），且不产生半条写入", async () => {
		const home = newTemp("chenxi-m13d1-missing-");
		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const sessions = createDesktopSessions({
			runtime,
			home,
			callbacks: {
				onReady: () => undefined,
				onEvent: () => undefined,
				onText: () => undefined,
				onApproval: () => undefined,
			},
		});

		// 起不来就**抛出去**（而不是留一条"死会话"在活动位上）：错误来自 persist 的 resume
		await expect(sessions.resume("ses_does_not_exist")).rejects.toThrow(/not found/i);
		await sessions.dispose();
		await runtime.dispose();
		expect(sessionIds(home)).toEqual([]);
	});
});

describe("M13d-1 契约（源码级断言，防漂移）", () => {
	const mainSource = readFileSync(join(PKG, "src", "main.ts"), "utf8");
	const preloadSource = readFileSync(join(PKG, "preload.cjs"), "utf8");
	const rendererSource = readFileSync(join(PKG, "renderer", "app.js"), "utf8");
	const sessionSource = readFileSync(join(PKG, "src", "session.ts"), "utf8");

	it("IPC 频道只增：main 的 `chenxi:resume` 在 preload 里有对应方法", () => {
		expect(mainSource).toContain('"chenxi:resume"');
		expect(preloadSource).toContain("chenxi:resume");
		expect(preloadSource).toContain("resume:");
	});

	it("续跑复用 CLI 的 resume 语义（不是新写入路径）", () => {
		expect(sessionSource).toContain("resume");
		expect(sessionSource).toContain("runSessionRepl");
		// 收尾用 EOF（close）而不是中断
		expect(sessionSource).toContain(".close()");
	});

	it("renderer 的「恢复」是结构化动作：只调 narrow API，不嗅探文本", () => {
		expect(rendererSource).toContain("window.chenxi.resume");
		expect(rendererSource).not.toContain("require(");
		expect(rendererSource).not.toContain("ipcRenderer");
		expect(/\.innerHTML\s*=/.test(rendererSource)).toBe(false);
	});
});
