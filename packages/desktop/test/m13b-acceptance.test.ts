/**
 * M13b 验收测试（总工程师独立编写）：桌面版从「只读」升级为「**可交互**」（ADR-029 增补）。
 *
 * 本机**能**跑 Electron（`--self-check` 冒烟会在真窗口 + 真 renderer 里断言 DOM 并**真的发一条 prompt**），
 * 但 `vitest` 里**不**该拉起 Electron ⇒ 这一层测的是"窗口与 IPC 之外"的一切（纯 Node 的 `src/session.ts`）：
 *  - **发 prompt 落 `user/message`**（会话在 main 进程内跑 `runSessionRepl`，**写入仍只经 persist 单一写入路径**）；
 *  - **审批通道**：`a`（本会话始终）放行且后续**不再提问**、`n` 拒绝且**文件不生成**，判定照旧落 `permission/decision`；
 *  - **模式切换**：`/mode build` 走既有命令路径 ⇒ `mode/changed` 事件（卡片带**结构化 `mode` 字段**）；
 *  - **窗口关闭 ≠ 中断回合**：`close()` 只给 EOF，等回合跑完再落 `session/end{exit}`；
 *  - **契约与纪律**（源码级断言，防漂移）：preload 窄接口只增、IPC 频道 main ↔ preload 一致、
 *    renderer **不嗅探文本**（模式取自卡片的 `mode` 字段）、CSP 仍在。
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cli } from "@chenxi/runtime";
import type { SessionEvent } from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { EventCard } from "../src/host.js";
import {
	type ApprovalView,
	createDesktopSessions,
	createLiveSession,
	type LiveSession,
} from "../src/session.js";
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

/** 轮询等待某个条件成立（确定性断言异步交互的顺序）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("waitFor: condition not met within timeout");
}

/** 用 **CLI 的装配链**（`cli/bootstrap.ts`）造一份会话运行时——桌面版走的就是这一份。 */
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

/** 收集推送（卡片 / 文本 / 审批 / 就绪）的测试桩。 */
function collector() {
	const cards: EventCard[] = [];
	const texts: string[] = [];
	const approvals: ApprovalView[] = [];
	const ready: string[] = [];
	return { cards, texts, approvals, ready };
}

describe("M13b 发 prompt（会话在 main 进程内跑 runSessionRepl）", () => {
	it("sendPrompt 真的落 user/message；且 trace:false ⇒ 已有事件的文本轨迹不再重复打印", async () => {
		const home = newTemp("chenxi-m13b-prompt-");
		const runtime = await bootstrap({ home, stub: "hi from stub", noTools: true });
		const seen = collector();
		const session = createLiveSession({
			runtime,
			home,
			mode: "plan",
			callbacks: {
				onReady: (id) => void seen.ready.push(id),
				onEvent: (card) => void seen.cards.push(card),
				onText: (text) => void seen.texts.push(text),
				onApproval: () => undefined,
			},
		});

		session.sendPrompt("hello from the desktop GUI");
		await waitFor(() => seen.cards.some((card) => card.type === "user/message"));
		const userCard = seen.cards.find((card) => card.type === "user/message");
		expect(userCard?.role).toBe("user");
		expect(userCard?.text).toBe("hello from the desktop GUI");

		session.close();
		const result = await session.done;
		await runtime.dispose();

		// 事实真的落进了 JSONL（同一份单一写入路径），且以 session/end 收尾
		const events = readEvents(home, result.sessionId);
		expect(events.some((event) => event.type === "user/message")).toBe(true);
		expect(events.at(-1)?.type).toBe("session/end");
		expect(result.sessionId).toBe(seen.ready[0]);

		// ADR-023 的同一纪律：`+ user/message#N` 这类"已有事件的文本轨迹"**不再**走文本通道
		expect(seen.texts.join("")).not.toContain("user/message#");
	});
});

describe("M13b 审批通道（IPC 弹审批 UI；语义与 M6 完全一致）", () => {
	/** build 模式下写**工作区之外**的路径 ⇒ 触发 `ask`（走审批通道）。 */
	function approveSetup() {
		const home = newTemp("chenxi-m13b-approve-home-");
		const cwd = newTemp("chenxi-m13b-approve-cwd-");
		const outside = join(newTemp("chenxi-m13b-approve-out-"), "out.txt");
		return { home, cwd, outside };
	}

	it("作答 a（本会话始终）⇒ 放行、文件真的写出，且同键**不再提问**（once/always 语义与 M6 一致）", async () => {
		const { home, cwd, outside } = approveSetup();
		const runtime = await bootstrap({ home, demoWrite: outside });
		const seen = collector();
		// 会话句柄要在**审批回调里**用到（回调在 createLiveSession 返回后才触发）⇒ 用一个小盒子回指
		const box: { session: LiveSession | null } = { session: null };
		const session = createLiveSession({
			runtime,
			home,
			cwd,
			mode: "build",
			callbacks: {
				onReady: () => undefined,
				onEvent: (card) => void seen.cards.push(card),
				onText: () => undefined,
				onApproval: (view) => {
					seen.approvals.push(view);
					box.session?.answerApproval("always"); // 选中「本次会话始终允许」
				},
			},
		});
		box.session = session;

		session.sendPrompt("please write outside the workspace");
		await waitFor(() => seen.cards.some((card) => card.type === "tool/result"));
		session.sendPrompt("again");
		await waitFor(() => seen.cards.filter((card) => card.type === "tool/result").length >= 2);
		session.close();
		const result = await session.done;
		await runtime.dispose();

		// 只问了**一次**（第二次同工具同作用域命中会话内规则）
		expect(seen.approvals).toHaveLength(1);
		expect(seen.approvals[0]?.toolName).toBe("write");
		expect(seen.approvals[0]?.scope).toBe("outside");
		// 提问正文与 CLI/TUI **同一份**（单一来源在 permission 模块）
		expect(seen.approvals[0]?.detail).toContain("allow? [y] once");

		// 判定照旧落 permission/decision（且是 allow）
		const decisions = readEvents(home, result.sessionId).filter(
			(event) => event.type === "permission/decision",
		);
		expect(decisions.length).toBe(2);
		for (const decision of decisions) {
			if (decision.type === "permission/decision") {
				expect(decision.payload.decision).toBe("allow");
				expect(decision.payload.reason).toContain("approved by user");
			}
		}
		expect(seen.cards.some((card) => card.type === "permission/decision")).toBe(true);
		// 放行是真的放行：文件确实被写出来了
		expect(existsSync(outside)).toBe(true);
	});

	it("作答 n（拒绝）⇒ 判定 deny 且**文件不生成**", async () => {
		const { home, cwd, outside } = approveSetup();
		const runtime = await bootstrap({ home, demoWrite: outside });
		const seen = collector();
		const box: { session: LiveSession | null } = { session: null };
		const session = createLiveSession({
			runtime,
			home,
			cwd,
			mode: "build",
			callbacks: {
				onReady: () => undefined,
				onEvent: (card) => void seen.cards.push(card),
				onText: () => undefined,
				onApproval: () => void box.session?.answerApproval("reject"),
			},
		});
		box.session = session;

		session.sendPrompt("please write outside the workspace");
		await waitFor(() => seen.cards.some((card) => card.type === "permission/decision"));
		session.close();
		const result = await session.done;
		await runtime.dispose();

		const decisions = readEvents(home, result.sessionId).filter(
			(event) => event.type === "permission/decision",
		);
		expect(decisions.length).toBeGreaterThan(0);
		if (decisions[0]?.type === "permission/decision") {
			expect(decisions[0].payload.decision).toBe("deny");
		}
		expect(existsSync(outside)).toBe(false);
	});

	it("无待决审批时 answerApproval 返回 false（不抛、不臆断）", async () => {
		const home = newTemp("chenxi-m13b-noapproval-");
		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const session = createLiveSession({
			runtime,
			home,
			callbacks: {
				onReady: () => undefined,
				onEvent: () => undefined,
				onText: () => undefined,
				onApproval: () => undefined,
			},
		});
		expect(session.answerApproval("always")).toBe(false);
		session.close();
		await session.done;
		await runtime.dispose();
	});
});

describe("M13b 模式切换 / 关窗语义", () => {
	it("setMode 走既有 `/mode` 命令路径 ⇒ 落 mode/changed 事件（卡片带结构化 mode 字段）", async () => {
		const home = newTemp("chenxi-m13b-mode-");
		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const seen = collector();
		const session = createLiveSession({
			runtime,
			home,
			mode: "plan",
			callbacks: {
				onReady: () => undefined,
				onEvent: (card) => void seen.cards.push(card),
				onText: () => undefined,
				onApproval: () => undefined,
			},
		});

		session.setMode("build");
		await waitFor(() => seen.cards.some((card) => card.type === "mode/changed"));
		session.close();
		const result = await session.done;
		await runtime.dispose();

		const modeCard = seen.cards.find((card) => card.type === "mode/changed");
		expect(modeCard?.role).toBe("mode");
		expect(modeCard?.text).toBe("plan → build");
		// 结构化字段 ⇒ renderer 不必解析 `format v1 | mode plan` 这种文本
		expect(modeCard?.mode).toBe("build");
		expect(readEvents(home, result.sessionId).some((event) => event.type === "mode/changed")).toBe(
			true,
		);
	});

	it("close() = EOF 收尾：**不中断回合**，等它跑完再落 session/end{exit}", async () => {
		const home = newTemp("chenxi-m13b-close-");
		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const session = createLiveSession({
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

		session.sendPrompt("hello");
		session.close();
		const result = await session.done;
		await runtime.dispose();

		const events = readEvents(home, result.sessionId);
		const last = events.at(-1);
		expect(last?.type).toBe("session/end");
		if (last?.type === "session/end") expect(last.payload.reason).toBe("exit");
		// 「关窗 ≠ 中断」的可证形态：没有任何 turn/end 被判成 error（那是 SIGINT 的结果）
		expect(
			events.some((event) => event.type === "turn/end" && event.payload.stopReason === "error"),
		).toBe(false);
	});
});

describe("M13b 当前会话管理（无活动会话时发话即开一条新会话）", () => {
	it("自动开新会话；reset() 摘掉当前会话后，下次发话开的是**另一条**（不串台）", async () => {
		const home = newTemp("chenxi-m13b-sessions-");
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

		// 空跑**不开会话**（不产生空写入）
		expect(sessions.activeSessionId()).toBeNull();

		sessions.sendPrompt("first");
		await waitFor(() => sessions.activeSessionId() !== null);
		const firstId = sessions.activeSessionId();

		sessions.reset();
		expect(sessions.activeSessionId()).toBeNull();

		sessions.sendPrompt("second");
		await waitFor(() => seen.ready.length >= 2);
		expect(sessions.activeSessionId()).not.toBe(firstId);

		sessions.sendPrompt("third"); // 有活动会话时不再开新的
		await waitFor(() => seen.cards.filter((card) => card.type === "user/message").length >= 3);
		expect(seen.ready).toHaveLength(2);

		await sessions.dispose();
		await runtime.dispose();
	});
});

describe("M13b 契约与纪律（源码级断言，防漂移）", () => {
	const mainSource = readFileSync(join(PKG, "src", "main.ts"), "utf8");
	const preloadSource = readFileSync(join(PKG, "preload.cjs"), "utf8");
	const htmlSource = readFileSync(join(PKG, "renderer", "index.html"), "utf8");
	const rendererSource = readFileSync(join(PKG, "renderer", "app.js"), "utf8");
	const sessionSource = readFileSync(join(PKG, "src", "session.ts"), "utf8");

	it("IPC 频道名 main ↔ preload **一致**（preload 是 CJS，故只能用源码比对钉住）", () => {
		const channels = [...mainSource.matchAll(/"(chenxi:[a-z:]+)"/g)].map((match) => match[1]);
		expect(channels.length).toBeGreaterThanOrEqual(8);
		for (const channel of new Set(channels)) expect(preloadSource).toContain(channel);
		// 交互面（只增不改）
		for (const api of ["sendPrompt:", "setMode:", "answerApproval:", "interrupt:", "newSession:"]) {
			expect(preloadSource).toContain(api);
		}
		// 推送面
		for (const api of ["onEvent:", "onText:", "onApproval:", "onReady:"]) {
			expect(preloadSource).toContain(api);
		}
	});

	it("会话复用既有语义：runSessionRepl + approvalChannel + trace:false（不新增写入路径）", () => {
		expect(sessionSource).toContain("runSessionRepl");
		expect(sessionSource).toContain("approvalChannel");
		expect(sessionSource).toContain("trace: false");
		// 关窗语义：EOF（push(null)）而不是 abort
		expect(sessionSource).toContain("input.push(null)");
		expect(sessionSource).not.toContain(".abort(");
	});

	it("renderer **不嗅探文本**、拿不到 Node：模式取自卡片的 `mode` 字段", () => {
		expect(rendererSource).not.toContain("require(");
		expect(rendererSource).not.toContain("ipcRenderer");
		expect(/\.innerHTML\s*=/.test(rendererSource)).toBe(false);
		expect(rendererSource).not.toContain("insertAdjacentHTML");
		// 模式取自**结构化字段**（而不是去解析 `session/start` 卡片的正文）
		expect(rendererSource).toContain("card.mode");
	});

	it("CSP 仍在（`default-src 'none'` ⇒ 连一次网络请求都发不出去）", () => {
		expect(htmlSource).toContain('http-equiv="Content-Security-Policy"');
		expect(htmlSource).toContain("default-src 'none'");
		expect(htmlSource).toContain("connect-src 'none'");
		expect(htmlSource).not.toContain("http://");
	});

	it("安全基线写死在 main 里（隔离开启 + 绝不碰 C 盘仍是把关）", () => {
		expect(mainSource).toContain("contextIsolation: true");
		expect(mainSource).toContain("nodeIntegration: false");
		expect(mainSource).toContain("sandbox: true");
		expect(mainSource).toContain("auditDesktopPaths");
		expect(mainSource).toContain("app.exit(2)");
		// 关窗接管 window-all-closed ⇒ 等会话收尾再退出（不中断回合）
		expect(mainSource).toContain("shutdown()");
	});
});
