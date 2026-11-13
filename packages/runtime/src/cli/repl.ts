/**
 * REPL：接入 LLM（M2）、工具闭环（M3）、权限（M4）后的主交互入口，M6 起支持：
 *   - **`ask` 可交互审批**（`y` 本次 / `a` 本会话始终 / `n` 拒绝）；
 *   - **SIGINT 优雅中断**（一次：中止当前回合或拒绝审批；二次：退出并落 `session/end`）；
 *   - `--resume latest`、`/approvals` 查看已沉淀的审批规则、`/policy` 查看生效的「模式 → 权限」表。
 *
 * 主循环**不做策略**（ADR-004）：本文件只负责交互与接线；权限判定在 `permission`、
 * 工具执行在 `tools`、回合推进在 `loop`，横切能力经缝插入。
 */
import { createInterface } from "node:readline";
import type { AgentMode, SessionEvent, SessionId } from "@chenxi/schema";
import { AGENT_MODES, DEFAULT_AGENT_MODE, SESSION_FORMAT_VERSION } from "@chenxi/schema";
import type { CompactionConfig, ContextBuilder } from "../context/index.js";
import type { LlmProvider } from "../llm/types.js";
import type { ToolRuntime } from "../loop/index.js";
import type { MemorySeam } from "../memory/index.js";
import type { PermissionSystem } from "../permission/index.js";
import {
	type ApprovalChannel,
	type ApprovalRules,
	createApprovalGate,
} from "../permission/index.js";
import type { SessionStore } from "../persist/index.js";
import { createSessionStore } from "../persist/index.js";
import type { SubagentRunner } from "../subagent/index.js";
import { describePermissionRule, formatHistory } from "./present.js";
import { createTraceAppender, executeTurn } from "./session-loop.js";

export interface Output {
	write(text: string): void;
}

/** `--resume` 的取值：具体会话 id，或 `"latest"`（最近更新的会话）。 */
export type ResumeTarget = SessionId | "latest";

// 审批类型 / 正文格式 / `/policy` 短标签 / 历史打印都在 `./present.js`（供非终端前端复用；见该文件头）

/**
 * **输入适配器约定**（ADR-025）：TUI 的输入适配器是"按行投递"的 `Readable`，而 readline 按 `\n`
 * 切行——因此**多行草稿**必须先把换行编码成这个哨兵，再由本层解码回 `\n`，才能作为**一条**
 * `user/message` 提交（否则会被 readline 拆成多条消息、跑多个回合）。
 *
 * 选 `U+0000` 的理由：它**不是**空白（`trim()` 不会吃掉它），键盘也输不出来（朴素 REPL 里
 * 粘贴多行仍是 readline 的原行为：多行分别提交——**本约定只服务 TUI**）。
 */
export const NEWLINE_ESCAPE = "\u0000";

/** REPL 内置命令（供 TUI 的 **Tab 补全**使用，ADR-024）。
 *
 * 刻意与真实处理逻辑放在**同一文件**（`handleLine` 就在下面）：补全列表与命令实现**不各自
 * 维护一份**，降低漂移风险。`args` 是参数候选（`/mode` → `plan|build`，直接引用 `AGENT_MODES`）。
 */
export const REPL_COMMANDS: readonly {
	readonly name: string;
	readonly args?: readonly string[];
}[] = [
	{ name: "/exit" },
	{ name: "/history" },
	{ name: "/approvals" },
	{ name: "/policy" },
	{ name: "/mode", args: AGENT_MODES },
];

export interface RunReplOptions {
	readonly home?: string;
	readonly resume?: ResumeTarget;
	readonly mode?: AgentMode;
	readonly cwd?: string;
	readonly input: NodeJS.ReadableStream;
	readonly output: Output;
	/** 已解析好的 provider；缺省表示「仅记录」模式（不调用模型）。 */
	readonly provider?: LlmProvider;
	readonly model?: string;
	/** 显式 system 提示（优先级低于 `contextBuilder`）。 */
	readonly system?: string;
	/**
	 * 分节提示词构造器（ADR-011 / ADR-013）。
	 * 提供时**每回合**都用当前模式重建 system prompt（模式对账：压缩/回滚后约束仍生效）。
	 */
	readonly contextBuilder?: ContextBuilder;
	/** 长会话上下文压缩（M23，ADR-041）；缺省不做（默认行为逐字节不变）。 */
	readonly compaction?: CompactionConfig;
	/** 工具运行环境（M3+）；缺省表示无工具。 */
	readonly tools?: ToolRuntime;
	/** 权限系统（M4）；提供时以 `beforeToolCall` 钩子形式接入，**不改主循环**（ADR-004）。 */
	readonly permission?: PermissionSystem;
	/**
	 * **结构化审批通道**（ADR-029 增补，M13b）：桌面版经 IPC 弹审批 UI 并回传三档选择。
	 * 提供时**取代**"下一行输入即答案"的朴素通道（但语义完全一致：`always` 仍是**会话内**规则、
	 * 解析失败/抛错一律 reject）；**缺省 ⇒ 既有 CLI/TUI 行为逐字节不变**。
	 */
	readonly approvalChannel?: ApprovalChannel;
	/**
	 * **本会话内沉淀的审批规则**（ADR-029 增补 M13d-3）：闸门建好后**回调一次**，把它交给前端；
	 * 该对象是**活的**（`always` 会继续写进去）⇒ 前端可以随时 `rules.list()` 读**当前**规则。
	 * **缺省不回调** ⇒ 既有 CLI/TUI 行为逐字节不变。
	 */
	readonly onApprovalRules?: (rules: ApprovalRules) => void;
	/**
	 * 记忆注入缝工厂（ADR-016）。按 `sessionId` 构造（作用域里的 `session` 键必须来自真实会话）。
	 * 由本层在 `runTurn` **之前**调用 `beforeTurn`——`loop` 一行不改（ADR-004）。
	 */
	readonly memory?: (sessionId: SessionId) => MemorySeam;
	/**
	 * 子代理 runner（ADR-017 / ADR-018）。本层只用它的 `drain()`：
	 * 退出前等待未完成的 `background` 子代理收尾（结果落父会话，**绝不丢弃**）。
	 */
	readonly subagents?: SubagentRunner;
	/**
	 * 每条**已记录**事件记完之后的回调（ADR-021）：`--serve` 用它把事件喂给 SSE 扇出。
	 * **不是**新的写入路径——事件已经落进 JSONL/索引，这里只是"顺手让订阅者看到"。
	 */
	readonly onEvent?: (event: SessionEvent) => void;
	/**
	 * 会话句柄就绪后的回调（ADR-022）：`--serve` 用它把**本进程正在驱动的会话**登记进
	 * live 集合，远端 `POST /prompt` 据此对同一会话返回 409（**一个会话一个写入者**）。
	 */
	readonly onSessionReady?: (sessionId: SessionId) => void;
	/**
	 * 是否打印"**已有事件**的文本事实"（`+ user/message#N`、tool_call / tool_result 轨迹、
	 * `/mode` 的 `mode: A -> B`、`~ memory: injected`）。**缺省 true**（朴素 REPL）。
	 * 结构化前端（TUI，ADR-023）传 `false`：同一事实由**事件**渲染，绝不出现两遍
	 * （`(exit)` / `[assistant stopped: …]` / 审批提问 等**没有事件**的提示**不受影响**）。
	 */
	readonly trace?: boolean;
	/**
	 * 沙箱说明（ADR-027）：**仅在显式启用 best-effort 时**给出，REPL 打一行横幅
	 * （TUI 会把它显示在转录区首屏）。缺省 `undefined` ⇒ **不打印**（默认 off 的一切照旧）。
	 */
	readonly sandboxLabel?: string;
}

export interface RunReplResult {
	readonly sessionId: SessionId;
	readonly eventCount: number;
}

/** 解析 `--resume`：`"latest"` -> 最近更新的会话。 */
async function resolveResumeTarget(store: SessionStore, target: ResumeTarget): Promise<SessionId> {
	if (target !== "latest") return target;
	const metas = await store.list();
	const latest = [...metas].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
	if (latest === undefined) {
		throw new Error("no recorded session found to resume (run a session first)");
	}
	return latest.sessionId;
}

/**
 * 跑一个会话 REPL。返回 sessionId 与最终事件数。
 * 内置命令：`/history`、`/mode <plan|build>`、`/approvals`、`/policy`、`/exit`。
 */
export async function runSessionRepl(options: RunReplOptions): Promise<RunReplResult> {
	const store = createSessionStore(options.home === undefined ? {} : { home: options.home });
	let currentMode: AgentMode = options.mode ?? DEFAULT_AGENT_MODE;
	const cwd = options.cwd ?? process.cwd();

	const resumedId =
		options.resume === undefined ? undefined : await resolveResumeTarget(store, options.resume);
	const handle =
		resumedId === undefined
			? await store.create({ cwd, mode: currentMode })
			: await store.resume(resumedId);

	// 记忆缝按真实 sessionId 构造（作用域三键必须来自会话上下文，模型无法覆盖）
	const memorySeam = options.memory?.(handle.sessionId);
	// ADR-022：把"本进程正在驱动的会话"登记出去（远端 prompt 据此拒写同一会话）
	options.onSessionReady?.(handle.sessionId);

	options.output.write(`session: ${handle.sessionId}\n`);
	if (resumedId !== undefined) {
		options.output.write(`resumed with ${handle.log.length} recorded event(s)\n`);
		formatHistory(handle.log.events, options.output);
	}
	options.output.write(`format v${SESSION_FORMAT_VERSION} | mode ${currentMode} | cwd ${cwd}\n`);
	// ADR-027：沙箱**默认关**——只有显式启用 best-effort 时才多这一行（口径：experimental + 非隔离）
	if (options.sandboxLabel !== undefined) {
		options.output.write(`sandbox: ${options.sandboxLabel}\n`);
	}
	if (options.provider === undefined) {
		options.output.write(
			"no model endpoint configured — recording only. " +
				"set CHENXI_BASE_URL / CHENXI_API_KEY / CHENXI_MODEL to enable streaming.\n",
		);
	} else {
		options.output.write(
			`llm provider: ${options.provider.id} | model ${options.model} | tools: ` +
				`${options.tools === undefined ? 0 : options.tools.registry.size()}\n`,
		);
	}

	/**
	 * 追加事件并打印工具轨迹（tool_call / tool_result），不改动主循环。
	 *
	 * ⚠️ **本层所有 append 都必须走这里**（`/mode`、记忆缝、`permission/decision`、
	 * `session/end` 也不例外）：`options.onEvent`（ADR-021 的 SSE 生产者）挂在**这一个**出口上，
	 * 否则订阅者会漏事件——这是 M11a 冒烟抓到的真 bug（M11b 又发现 `permission/decision`
	 * 曾绕过它，已一并收敛）。编排本身在 `cli/session-loop.ts`，与 server 共用同一份。
	 */
	const appendWithTrace = createTraceAppender({
		handle,
		output: options.output,
		...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
		trace: options.trace !== false,
	});

	const rl = createInterface({ input: options.input, terminal: false });

	/** 审批提示等待答案时，**下一行输入**即答案（同一 stdin，无需第二个 readline）。 */
	let pendingAnswer: ((answer: string) => void) | null = null;
	const askLine = (question: string): Promise<string> =>
		new Promise((resolve) => {
			pendingAnswer = (answer) => resolve(answer);
			options.output.write(question);
		});

	// 审批闸门（M6）：`ask` -> 现场询问用户；`always` 沉淀为**本会话内**规则。
	// ADR-029 增补：前端若给了结构化通道（桌面版），取代朴素通道；语义一致（同一条 createApprovalGate）。
	const approvalGate =
		options.permission === undefined
			? undefined
			: createApprovalGate(
					options.approvalChannel === undefined
						? { ask: askLine }
						: { ask: askLine, channel: options.approvalChannel },
				);
	// ADR-029 增补 M13d-3：把**活的**规则对象交给前端（桌面版的「规则」面板据此显示当前会话的 `always`）
	if (approvalGate !== undefined) options.onApprovalRules?.(approvalGate.rules);

	let abortController: AbortController | null = null;
	let exitRequested = false;

	const onSigint = (): void => {
		if (pendingAnswer !== null) {
			const resolve = pendingAnswer;
			pendingAnswer = null;
			options.output.write("\n  (approval interrupted — treated as reject)\n");
			resolve("n");
			return;
		}
		if (abortController !== null) {
			options.output.write("\n  (interrupting current turn… press Ctrl+C again to exit)\n");
			abortController.abort();
			return;
		}
		options.output.write("\n  (exit)\n");
		exitRequested = true;
		rl.close();
	};
	process.on("SIGINT", onSigint);

	const handleLine = async (line: string): Promise<void> => {
		if (line === "/exit") {
			exitRequested = true;
			rl.close();
			return;
		}
		if (line === "/history") {
			formatHistory(handle.log.events, options.output);
			return;
		}
		if (line === "/approvals") {
			const rules = approvalGate?.rules.list() ?? [];
			options.output.write(
				rules.length === 0
					? "  approvals: (none; `always` answers will be remembered for this session)\n"
					: `  approvals: ${rules.map((r) => `${r.toolName}@${r.scope}`).join(", ")}\n`,
			);
			return;
		}
		if (line === "/policy") {
			// ADR-014：让「配置文件覆盖模式→权限」这件事**当场看得见**
			const policy = options.permission?.policy();
			if (policy === undefined) {
				options.output.write("  policy: (no permission system in this session)\n");
				return;
			}
			for (const mode of AGENT_MODES) {
				options.output.write(
					`  policy ${mode}: ${policy[mode].map(describePermissionRule).join(" | ") || "(no rule: everything denied)"}\n`,
				);
			}
			return;
		}
		if (line === "/mode" || line.startsWith("/mode ")) {
			const target = line.slice("/mode".length).trim() as AgentMode;
			if (!AGENT_MODES.includes(target)) {
				options.output.write(`usage: /mode ${AGENT_MODES.join("|")}\n`);
				return;
			}
			if (target !== currentMode) {
				const from = currentMode;
				currentMode = target;
				await appendWithTrace({
					type: "mode/changed",
					payload: { from, to: target, reason: "user command" },
				});
				// `mode/changed` 是**事实**：结构化前端（TUI）按事件渲染，本层不重复打印（ADR-023）
				if (options.trace !== false) options.output.write(`  mode: ${from} -> ${target}\n`);
			}
			return;
		}

		// 一个回合的编排（`user/message` 落盘、记忆缝、权限钩子、模式对账、`runTurn`）
		// 与 server 的远端写路径**共用**同一份实现（ADR-022：一处实现、两处外观）。
		// 中止能力（SIGINT）仍由本层持有：只把 `signal` 交出去。
		const controller = options.provider === undefined ? undefined : new AbortController();
		abortController = controller ?? null;
		try {
			await executeTurn(
				{
					appendWithTrace,
					output: options.output,
					log: handle.log,
					...(options.provider === undefined ? {} : { provider: options.provider }),
					...(options.model === undefined ? {} : { model: options.model }),
					mode: currentMode,
					cwd,
					...(options.tools === undefined ? {} : { tools: options.tools }),
					...(options.permission === undefined ? {} : { permission: options.permission }),
					// 审批通道只在**交互**前端存在；缺省即 fail-closed（ADR-007）
					...(approvalGate === undefined ? {} : { approve: approvalGate.approve }),
					...(memorySeam === undefined ? {} : { memorySeam }),
					...(options.contextBuilder === undefined
						? {}
						: { contextBuilder: options.contextBuilder }),
					...(options.compaction === undefined ? {} : { compaction: options.compaction }),
					...(options.system === undefined ? {} : { system: options.system }),
					...(controller === undefined ? {} : { signal: controller.signal }),
					trace: options.trace !== false,
				},
				line,
			);
		} finally {
			abortController = null;
		}
	};

	// 顺序化：同一时刻只处理一条输入（审批提示期间除外，那一行会作为答案）
	let chain: Promise<void> = Promise.resolve();
	const closed = new Promise<void>((resolve) => rl.once("close", () => resolve()));

	rl.on("line", (rawLine: string) => {
		// 解码"输入适配器约定"：TUI 的多行草稿以哨兵编码换行（见 `NEWLINE_ESCAPE`）
		const line = rawLine.trim().split(NEWLINE_ESCAPE).join("\n");
		if (pendingAnswer !== null) {
			const resolve = pendingAnswer;
			pendingAnswer = null;
			resolve(line);
			return;
		}
		if (line === "") return;
		chain = chain
			.then(() => handleLine(line))
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				options.output.write(`  [error] ${message}\n`);
			});
	});

	try {
		await closed;
		await chain;
	} finally {
		process.off("SIGINT", onSigint);
		rl.close();
		// ADR-018：退出前等待未完成的 background 子代理收尾——其结果**照常落父会话**，绝不丢弃
		if (options.subagents !== undefined) {
			const pending = options.subagents.inflight();
			if (pending > 0) {
				options.output.write(`  (waiting for ${pending} background subagent(s) to finish…)\n`);
			}
			await options.subagents.drain();
		}
		// 每次运行都以 `session/end` 收尾（含 resume 的续跑）：JSONL 追加可见，投影不受影响
		// 也走 `appendWithTrace`：收尾事件同样要让订阅者看到（ADR-021）
		await appendWithTrace({
			type: "session/end",
			payload: { reason: exitRequested ? "interrupted" : "exit" },
		});
		await handle.close();
		await store.dispose();
	}

	return { sessionId: handle.sessionId, eventCount: handle.log.length };
}
