/**
 * 交互式会话宿主（ADR-029 增补，M13b）——**纯 Node、不依赖 Electron**：因此 `vitest` 能直测，
 * 而 Electron 那一层（窗口 / IPC）保持**薄**。
 *
 * 「一次活动会话」= 在 main 进程内跑一遍 `runSessionRepl`（与 CLI/TUI **同一份实现**）：
 *  - **输入适配器** = 自建 `Readable`：`sendPrompt` 往它推一行（多行先编码成 `NEWLINE_ESCAPE`，
 *    与 TUI 同法 ⇒ 一段多行文本仍是**一条** `user/message`）；
 *  - **输出适配器** = 文本通道 → `onText`（`trace:false`：已有事件的文本轨迹不再重复打印，ADR-023）；
 *  - **`onEvent`** → 结构化卡片（`host.ts` 的**唯一映射**），推给 renderer；
 *  - **`approvalChannel`** → 结构化审批请求，等 renderer 回传三档选择（`answerApproval`）。
 *
 * 纪律：
 *  - **会话的写入仍只经 `persist` 的单一写入路径**（本文件**不 append** 任何事件）；
 *  - **「窗口关闭 ≠ 中断回合」**：`close()` 只给输入流 EOF（`runSessionRepl` 会**等当前回合跑完**再落
 *    `session/end`），`interrupt()` 才合成 `process.emit("SIGINT")`；
 *  - 关窗 / 中断时若**正卡在审批上**，按既有语义**判为 reject**（绝不悬挂：审批的 `approve` 是
 *    `await` 的，没人回答就会把回合卡死）。
 */
import { Readable } from "node:stream";
import { cli } from "@aster/runtime";
import type { AgentMode } from "@aster/schema";
import { type EventCard, toEventCard } from "./host.js";

/** 审批请求的**结构化视图**（renderer 据此画审批卡；不嗅探任何文本）。 */
export interface ApprovalView {
	readonly toolName: string;
	readonly scope: string;
	readonly mode: string;
	readonly reason: string;
	/** `renderApprovalPrompt` 的完整多行文本——**格式单一来源在 `permission` 模块**，此处不重算。 */
	readonly detail: string;
}

/** 会话把事实推给外层（main）的全部出口。 */
export interface LiveSessionCallbacks {
	/** 会话句柄就绪（拿到真实 sessionId）。 */
	onReady(sessionId: string): void;
	/** 一条**已记录**事件的结构化卡片。 */
	onEvent(card: EventCard): void;
	/** 文本通道（横幅 / 流式正文 / `[assistant stopped]` / 错误）——经受 `trace:false` 裁剪。 */
	onText(text: string): void;
	/** 需要用户审批（结构化）。 */
	onApproval(view: ApprovalView): void;
	/**
	 * **本会话内的审批规则**（ADR-029 增补 M13d-3）：闸门建好后交给外层**一次**，且该对象是**活的**
	 * （`always` 会继续写进去）⇒ 界面随时 `list()` 都能读到**当前**规则。
	 */
	onApprovalRules?(rules: cli.ApprovalRules): void;
}

export interface LiveSession {
	/**
	 * **会话就绪**（拿到 sessionId）；若 `runSessionRepl` 在就绪前就失败（如 `resume` 的 id 不存在）
	 * 则 **reject** ⇒ 调用方（`resume`）据此报错，绝不把一个"起不来的会话"留在活动位上。
	 */
	readonly ready: Promise<string>;
	/** 会话收尾（`runSessionRepl` 的返回值）；`close()` 之后 resolve。 */
	readonly done: Promise<cli.RunReplResult>;
	/** 发一条 prompt（一段多行文本 = 一条消息）。 */
	sendPrompt(text: string): void;
	/** 切换模式（走既有 `/mode` 命令路径 ⇒ 落 `mode/changed` 事件）。 */
	setMode(mode: AgentMode): void;
	/** 作答当前审批；无待决审批时返回 `false`（不抛）。 */
	answerApproval(choice: string): boolean;
	/** 中断当前回合（合成 SIGINT，与 TUI 同法）；待决审批则判为 reject。 */
	interrupt(): void;
	/** 优雅收尾：EOF（等当前回合跑完），**不**中断。 */
	close(): void;
}

export interface LiveSessionOptions {
	readonly runtime: cli.SessionRuntime;
	readonly home: string;
	readonly cwd?: string;
	readonly mode?: AgentMode;
	/**
	 * **续跑一条已记录会话**（M13d-1，与 CLI 的 `--resume <sessionId>` **同一份语义**）：
	 * 给出 sessionId 时该会话被**接着跑**（同一 JSONL、seq 继续），而不是新开一条。
	 */
	readonly resume?: string;
	readonly callbacks: LiveSessionCallbacks;
}

/** 只接受三档选择；其余（含 renderer 传来的非法值）一律按 `reject`（fail-closed）。 */
function normalizeChoice(choice: string): cli.ApprovalChoice {
	return choice === "once" || choice === "always" || choice === "reject" ? choice : "reject";
}

/** 审批上下文 → 结构化视图（正文格式仍来自 `permission` 模块的 `renderApprovalPrompt`）。 */
export function toApprovalView(prompt: cli.ApprovalPrompt): ApprovalView {
	return {
		toolName: prompt.request.metadata.name,
		scope: prompt.scope,
		mode: prompt.request.mode,
		reason: prompt.verdict.reason,
		detail: cli.renderApprovalPrompt(prompt),
	};
}

/** 开一次**活动会话**（同步返回句柄；`runSessionRepl` 在后台推进）。 */
export function createLiveSession(options: LiveSessionOptions): LiveSession {
	// 输入适配器：`read()` 由 `push` 驱动（与 TUI 的 `createLineStream` 同一形状）
	const input = new Readable({ read() {} });
	let pendingApproval: ((choice: cli.ApprovalChoice) => void) | null = null;

	const settleApproval = (choice: cli.ApprovalChoice): boolean => {
		if (pendingApproval === null) return false;
		const resolve = pendingApproval;
		pendingApproval = null;
		resolve(choice);
		return true;
	};

	const approvalChannel: cli.ApprovalChannel = (prompt) =>
		new Promise<cli.ApprovalChoice>((resolve) => {
			pendingApproval = resolve;
			options.callbacks.onApproval(toApprovalView(prompt));
		});

	let resolveReady: (sessionId: string) => void = () => undefined;
	let rejectReady: (error: unknown) => void = () => undefined;
	const ready = new Promise<string>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const done = cli
		.runSessionRepl({
			home: options.home,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			// M13d-1：给出 `resume` 时**接着跑**该会话（同一 JSONL、seq 继续）——CLI 的 `--resume <id>` 同一条路径
			// 上层只给"非空字符串"（id 或 "latest"）；语义合法性由 persist 的 resume 判定
			...(options.resume === undefined ? {} : { resume: options.resume as cli.ResumeTarget }),
			mode: options.mode ?? options.runtime.defaultMode,
			...(options.runtime.provider === undefined ? {} : { provider: options.runtime.provider }),
			...(options.runtime.model === undefined ? {} : { model: options.runtime.model }),
			...(options.runtime.tools === undefined ? {} : { tools: options.runtime.tools }),
			permission: options.runtime.permission,
			contextBuilder: options.runtime.contextBuilder,
			...(options.runtime.compaction === undefined
				? {}
				: { compaction: options.runtime.compaction }),
			...(options.runtime.memory === undefined ? {} : { memory: options.runtime.memory }),
			...(options.runtime.subagents === undefined ? {} : { subagents: options.runtime.subagents }),
			approvalChannel,
			// M13d-3：把**活的**审批规则对象转交给外层（桌面版的「规则」面板据此显示当前会话的 always）
			...(options.callbacks.onApprovalRules === undefined
				? {}
				: { onApprovalRules: options.callbacks.onApprovalRules }),
			// 界面语义：既有事实由卡片表达，本层不重复打印（ADR-023 的同一纪律）
			trace: false,
			input,
			output: { write: (text: string) => options.callbacks.onText(text) },
			onEvent: (event) => options.callbacks.onEvent(toEventCard(event)),
			onSessionReady: (sessionId) => {
				resolveReady(sessionId);
				options.callbacks.onReady(sessionId);
			},
		})
		.catch((error: unknown) => {
			rejectReady(error);
			throw error;
		});
	// 就绪前的失败**已经**由 `ready` 报告；这里挂一个"已消费"的 catch 只为**消除 unhandled rejection**
	// （`done` 本身照旧会 reject —— 调用方仍可 `await` 观察它）
	done.catch(() => undefined);

	return {
		ready,
		done,
		sendPrompt(text: string): void {
			input.push(`${text.split("\n").join(cli.NEWLINE_ESCAPE)}\n`);
		},
		setMode(mode: AgentMode): void {
			input.push(`/mode ${mode}\n`);
		},
		answerApproval(choice: string): boolean {
			return settleApproval(normalizeChoice(choice));
		},
		interrupt(): void {
			// 待决审批：按既有语义判为 reject（REPL 的 SIGINT 处理就是这么做的）
			if (settleApproval("reject")) return;
			process.emit("SIGINT");
		},
		close(): void {
			settleApproval("reject"); // 关窗不悬挂审批
			input.push(null); // EOF ⇒ readline 关闭 ⇒ 等当前回合跑完再 `session/end`
		},
	};
}

/** 桌面的"当前会话"管理：**无活动会话时发话即开一条新会话**（空跑不开会话、不产生空写入）。 */
export interface DesktopSessions {
	activeSessionId(): string | null;
	sendPrompt(text: string): void;
	setMode(mode: AgentMode): void;
	answerApproval(choice: string): boolean;
	interrupt(): void;
	/**
	 * **续跑**一条已记录会话（M13d-1）：先收掉当前会话（EOF，**不**中断）并**等它收尾**，
	 * 再把该 sessionId 交给 `runSessionRepl` 的 `resume` 语义接着跑——于是新 prompt 落进**同一条 JSONL**、seq 继续。
	 * 已经就是当前会话时**不做任何事**（绝不"关掉再重开"它）。
	 */
	resume(sessionId: string): Promise<void>;
	/**
	 * **当前会话已沉淀的审批规则**（M13d-3）：形如 `[{ toolName, scope }]`——即 `/approvals` 看到的那份。
	 * 读的是**活的**规则对象，所以刚答过 `always` 就立刻能读到。没有活动会话时返回空数组。
	 */
	approvalRules(): readonly { readonly toolName: string; readonly scope: string }[];
	/** 收掉当前会话（EOF 收尾，**不**中断）；下次发话再开新的。 */
	reset(): void;
	/** 应用退出：收掉全部会话并等它们收尾。 */
	dispose(): Promise<void>;
}

export interface DesktopSessionsOptions {
	readonly runtime: cli.SessionRuntime;
	readonly home: string;
	readonly cwd?: string;
	readonly mode?: AgentMode;
	readonly callbacks: LiveSessionCallbacks;
}

export function createDesktopSessions(options: DesktopSessionsOptions): DesktopSessions {
	/** 令牌：`current === token` 才把事实推给外层 ⇒ **切会话后旧会话的事实自动丢弃**（不串台）。 */
	interface Token {
		id: string | null;
		session: LiveSession;
		/** 本会话的审批规则（**活的**对象；`always` 会继续写进去）。 */
		rules: cli.ApprovalRules | null;
	}
	let current: Token | null = null;
	const all: LiveSession[] = [];
	/**
	 * **退出中的**会话（已 `close()`、尚未收尾）——`reset()` 把 `current` 摘掉了，但它可能还在写
	 * `session/end`。如果不记着它，紧接着的 `resume()` 就会在**同一条事实源**上开出**第二个写入者**
	 * （实测抓到：同一会话里出现两个 seq=2，`EventLogError: breaks monotonic order`）。
	 */
	let closing: Promise<void> | null = null;
	let disposed = false;

	/** 关掉一个会话并**记下它在收尾**（后续 `resume` 必须等它，绝不两个写入者并存）。 */
	const closeAndTrack = (session: LiveSession): void => {
		session.close();
		closing = session.done.then(
			() => undefined,
			() => undefined,
		);
	};

	const start = (resumeId?: string): LiveSession => {
		const token: Token = { id: null, session: undefined as unknown as LiveSession, rules: null };
		const callbacks: LiveSessionCallbacks = {
			onReady: (sessionId) => {
				token.id = sessionId;
				if (current === token) options.callbacks.onReady(sessionId);
			},
			// M13d-3：记在**自己的** token 上（不论是不是当前会话）——切走再切回来时仍然读得到
			onApprovalRules: (rules) => {
				token.rules = rules;
				if (current === token) options.callbacks.onApprovalRules?.(rules);
			},
			onEvent: (card) => {
				if (current === token) options.callbacks.onEvent(card);
			},
			onText: (text) => {
				if (current === token) options.callbacks.onText(text);
			},
			onApproval: (view) => {
				if (current === token) options.callbacks.onApproval(view);
			},
		};
		const session = createLiveSession({
			runtime: options.runtime,
			home: options.home,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			...(options.mode === undefined ? {} : { mode: options.mode }),
			...(resumeId === undefined ? {} : { resume: resumeId }),
			callbacks,
		});
		token.session = session;
		current = token;
		all.push(session);
		return session;
	};

	const ensure = (): LiveSession => current?.session ?? start();

	return {
		activeSessionId: () => current?.id ?? null,
		sendPrompt: (text) => {
			if (!disposed) ensure().sendPrompt(text);
		},
		setMode: (mode) => {
			if (!disposed) ensure().setMode(mode);
		},
		answerApproval: (choice) => current?.session.answerApproval(choice) ?? false,
		approvalRules: () => current?.rules?.list() ?? [],
		interrupt: () => current?.session.interrupt(),
		async resume(sessionId: string): Promise<void> {
			if (disposed || current?.id === sessionId) return;
			const old = current;
			current = null; // 先摘掉 ⇒ 旧会话后续事实被丢弃（不串台）
			if (old !== null) closeAndTrack(old.session); // EOF 收尾（**不**中断）
			// 等**所有退出中的**会话收尾（含刚被 `reset()` 摘掉的那条）：否则两个句柄会同时往
			// **同一条事实源**写（一个会话一个写入者），实测会写出重复 seq
			if (closing !== null) {
				await closing;
				closing = null;
			}
			const session = start(sessionId);
			try {
				await session.ready; // 起不来（如 id 不存在）就**抛出去**，由 IPC 报错给界面
			} catch (error) {
				current = null; // 起不来的会话**不留在活动位上**（否则下次发话会往一条死流里写）
				throw error;
			}
		},
		reset: () => {
			const old = current;
			current = null; // 先摘掉 ⇒ 旧会话后续事实被丢弃
			if (old !== null) closeAndTrack(old.session); // 但要**记着它在收尾**（见 `closing` 的注释）
		},
		async dispose(): Promise<void> {
			disposed = true;
			for (const session of all) session.close();
			await Promise.allSettled(all.map((session) => session.done));
		},
	};
}
