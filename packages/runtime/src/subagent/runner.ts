/**
 * 子代理 runner（ADR-017 / ADR-018）。
 *
 * 设计要点：
 *  - **子代理 = 独立会话**：每次派发都新建一份 JSONL（`store.create`），父会话里
 *    只留该次派发的 `tool/call` 与 `tool/result` —— 隔离是**结构性**的（不同日志），
 *    不变量 1「模型可见 <=> 已记录」因此天然成立；
 *  - **复用既有语义**：子会话用同一套 `loop` / `persist` / `permission` / `tools`，
 *    主循环一行不改（ADR-004「主循环不写策略」）；
 *  - **结构性防递归**：仅当 `depth + 1 < maxDepth` 才把 `task` 工具注册进**子**注册表；
 *    靠**工具不存在**来挡递归，而不是靠提示模型；
 *  - **子代理内无审批通道**：`createPermissionHook` **不传** `approve`，
 *    因此 `ask` 一律 fail-closed → deny（ADR-017 / ADR-007 的同一条规则）；
 *  - **模式继承父会话**：子会话的 mode 取 `request.mode ?? options.mode`，
 *    父会话切换模式后子代理立即跟随（ADR-017）；
 *  - **父子关系取当次调用**：子会话的 `parentSessionId` 取
 *    `request.parentSessionId ?? options.parentSessionId`——`task` 工具会把
 *    `ToolCallContext.sessionId` 作为 `request.parentSessionId` 传入；
 *  - **`fork`（ADR-018）**：写 `prompt` 之前先落 `subagent/context-imported`，payload 是
 *    **父会话当时的投影**（逐条记录在案），投影时再展开 —— 「导入即记录」；缺父会话访问权
 *    （`sessionLog`）时**快速失败**，绝不静默降级成 `fresh`；
 *  - **`background`（ADR-018）**：只等"建好子会话"就立刻返回 `status:"running"`；
 *    子代理在后台继续跑，结束后把 `subagent/result` 落**父会话**（复用父句柄的 `append`，
 *    因此 seq / JSONL / 索引始终由同一个写入者维护）。
 */
import type {
	AgentMode,
	SessionEndReason,
	SessionId,
	SessionLogAccess,
	StopReason,
	SubagentKind,
	SubagentResultPayload,
} from "@aster/schema";
import type { ContextBuilder } from "../context/index.js";
import { createContext } from "../events/index.js";
import type { LlmProvider } from "../llm/types.js";
import type { ToolRuntime } from "../loop/index.js";
import { runTurn } from "../loop/index.js";
import type { PermissionSystem } from "../permission/index.js";
import { createPermissionHook } from "../permission/index.js";
import type { SessionHandle } from "../persist/index.js";
import { createSessionStore } from "../persist/index.js";
import { deriveMessages } from "../session/index.js";
import { selectShellProvider } from "../shell/index.js";
import { createDefaultToolset, createToolRegistry } from "../tools/index.js";
import { createTaskTool } from "./tool.js";

/** 缺省最大深度（父 = 0）。 */
const DEFAULT_MAX_DEPTH = 2;

/**
 * 进程内在跑的 background 子代理（ADR-018）。
 *
 * **故意放在模块级**：`drain()` 是**进程级**关切（"父进程退出前收尾"），
 * 且嵌套派发（子代理内部再 background）时，孙代理的 promise 不在父 runner 的局部集合里；
 * 共享一个集合能让**任一** runner 的 `drain()` 覆盖整棵派发树，绝不漏掉在跑的子孙。
 */
const BACKGROUND_TASKS = new Set<Promise<void>>();

export interface SubagentRunnerOptions {
	/** 数据根（子会话写到 `<home>/sessions`）。 */
	readonly home: string;
	readonly cwd: string;
	/** 子代理**继承**父会话的模式（ADR-017）；可被 `request.mode` 逐次覆盖。 */
	readonly mode: AgentMode;
	readonly model: string;
	readonly provider: LlmProvider;
	/** 与父会话**同一个**权限系统实例（元数据驱动，不新增判定分支）。 */
	readonly permission: PermissionSystem;
	/** 子会话 system 提示的来源（由 CLI 传 `createContextBuilder()` 产物；可选）。 */
	readonly contextBuilder?: ContextBuilder;
	/** 该子代理所属的会话 id（写进 `session/start.parentSessionId`；可选）。 */
	readonly parentSessionId?: SessionId;
	/** 当前深度（父 = 0）。缺省 0。 */
	readonly depth?: number;
	/** 最大深度（缺省 2）。当 `depth + 1 >= maxDepth` 时子会话**不再注册** `task` 工具。 */
	readonly maxDepth?: number;
}

export interface SubagentRequest {
	readonly prompt: string;
	/** 派发方式：`fresh`（默认，从零开始）/ `fork`（先导入父会话投影）。 */
	readonly kind?: SubagentKind;
	/** `true` 时立刻返回句柄，结果稍后落父会话（ADR-018）。 */
	readonly background?: boolean;
	/** **当次调用**的模式（缺省用 `SubagentRunnerOptions.mode`）。 */
	readonly mode?: AgentMode;
	/** **当次调用**所属的会话 id（缺省用 `SubagentRunnerOptions.parentSessionId`）。 */
	readonly parentSessionId?: SessionId;
	/** **当次调用**的父会话日志访问权（`fork` / `background` **必需**）。 */
	readonly sessionLog?: SessionLogAccess;
}

export interface CompletedSubagentResult {
	readonly childSessionId: SessionId;
	readonly kind: SubagentKind;
	readonly status: "completed";
	readonly summary: string;
	readonly steps: number;
	readonly stopReason: StopReason;
}

export interface RunningSubagentResult {
	readonly childSessionId: SessionId;
	readonly kind: SubagentKind;
	readonly status: "running";
}

export type SubagentResult = CompletedSubagentResult | RunningSubagentResult;

export interface SubagentRunner {
	readonly depth: number;
	readonly maxDepth: number;
	dispatch(request: SubagentRequest): Promise<SubagentResult>;
	/** 等待**进程内**全部在跑的 background 子代理收尾（退出前调用；绝不丢弃已派发的结果）。 */
	drain(): Promise<void>;
	/** 当前在跑的 background 子代理数（供调用方给出可读提示）。 */
	inflight(): number;
}

/** 由父 runner 的选项派生下一层（只覆盖 depth 与 parentSessionId）。 */
function deriveChildOptions(
	base: SubagentRunnerOptions,
	childDepth: number,
	childParentSessionId: SessionId,
): SubagentRunnerOptions {
	return { ...base, depth: childDepth, parentSessionId: childParentSessionId };
}

/** 准备阶段的产物：子会话已建好（`prompt` 已落），但回合**尚未**跑。 */
interface PreparedDispatch {
	readonly childSessionId: SessionId;
	readonly kind: SubagentKind;
	run(): Promise<CompletedSubagentResult>;
}

/** 把后台结果落父会话；**失败即静默丢弃**（父句柄已关闭 / 已封禁时绝不抛出未处理异常）。 */
function deliver(access: SessionLogAccess, payload: SubagentResultPayload): Promise<void> {
	return access.append({ type: "subagent/result", payload }).then(
		() => undefined,
		() => undefined,
	);
}

/** `fork` / `background` 缺父会话访问权时的**可读**原因（绝不静默降级成 fresh）。 */
function parentAccessRequired(kind: SubagentKind, background: boolean): string {
	return (
		`"${kind}"${background ? " + background" : ""} subagent requires parent session access ` +
		"(sessionLog), but this tool call context did not provide it"
	);
}

/** 取父会话访问权（仅供类型收窄；缺失时的错误已由调用方**早于建子会话**抛出）。 */
function requireSessionLog(
	access: SessionLogAccess | undefined,
	kind: SubagentKind,
	background: boolean,
): SessionLogAccess {
	if (access === undefined) throw new Error(parentAccessRequired(kind, background));
	return access;
}

/**
 * 创建一个子代理 runner。
 *
 * `dispatch` 的收尾（`session/end` + `handle.close()` + `store.dispose()`）写在 `finally` 里，
 * **无论成功失败都执行**，绝不泄漏句柄；出错则照常抛出，让工具层把它变成可读的 `tool/result`。
 */
export function createSubagentRunner(options: SubagentRunnerOptions): SubagentRunner {
	const depth = options.depth ?? 0;
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

	/**
	 * 建子会话 + 落 `subagent/context-imported`（fork）+ 落 `prompt`，返回「能跑」的闭包。
	 * 中途任何一步抛错都**完整收尾**（close + dispose），绝不泄漏句柄。
	 */
	async function prepare(
		request: SubagentRequest,
		kind: SubagentKind,
		mode: AgentMode,
		parentSessionId: SessionId | undefined,
		access: SessionLogAccess | undefined,
	): Promise<PreparedDispatch> {
		const store = createSessionStore({ home: options.home });
		let handle: SessionHandle | undefined;
		try {
			handle = await store.create({
				cwd: options.cwd,
				mode,
				model: options.model,
				...(parentSessionId === undefined ? {} : { parentSessionId }),
			});
			const childSessionId = handle.sessionId;

			// 子会话**自己的**工具运行时：4 原语 + 权限钩子（无审批通道）
			const ctx = createContext();
			const registry = createToolRegistry(ctx);
			for (const tool of createDefaultToolset({ shell: selectShellProvider() })) {
				registry.register(tool);
			}
			const permissionHook = createPermissionHook({ system: options.permission });
			const tools: ToolRuntime = { ctx, registry, beforeHooks: [permissionHook] };

			// 递归注册：未达深度上限才注册 task（靠工具不存在来防递归）
			if (depth + 1 < maxDepth) {
				const childRunner = createSubagentRunner(
					deriveChildOptions(options, depth + 1, childSessionId),
				);
				registry.register(createTaskTool(childRunner));
			}

			// ADR-018 `fork`：**导入即记录**——先把父会话当时的投影逐条记下，再落 prompt
			if (kind === "fork") {
				const parent = requireSessionLog(access, kind, false);
				await handle.append({
					type: "subagent/context-imported",
					payload: { messages: deriveMessages(parent.events) },
				});
			}

			// prompt 落成子会话的 user/message（模型可见 <=> 已记录）
			await handle.append({ type: "user/message", payload: { content: request.prompt } });

			const system =
				options.contextBuilder === undefined
					? undefined
					: options.contextBuilder.buildSystem({ mode, cwd: options.cwd, registry });

			const child: SessionHandle = handle;
			const run = async (): Promise<CompletedSubagentResult> => {
				// 收尾用的 session/end 原因：正常结束 = exit；异常 = error
				let endReason: SessionEndReason = "error";
				try {
					const result = await runTurn({
						log: child.log,
						append: child.append,
						provider: options.provider,
						model: options.model,
						mode,
						cwd: options.cwd,
						tools,
						...(system === undefined ? {} : { system }),
					});
					const trimmed = result.content.trim();
					endReason = "exit";
					return {
						childSessionId,
						kind,
						status: "completed",
						summary: trimmed === "" ? "(subagent produced no text)" : trimmed,
						steps: result.steps,
						stopReason: result.stopReason,
					};
				} finally {
					try {
						await child.append({ type: "session/end", payload: { reason: endReason } });
					} catch {
						// 收尾落事件是**尽力而为**：绝不让它挡住 close()/dispose()
					}
					await child.close();
					await store.dispose();
				}
			};

			return { childSessionId, kind, run };
		} catch (error) {
			if (handle !== undefined) {
				try {
					await handle.close();
				} catch {
					// 收尾尽力而为
				}
			}
			await store.dispose();
			throw error;
		}
	}

	async function dispatch(request: SubagentRequest): Promise<SubagentResult> {
		const kind: SubagentKind = request.kind ?? "fresh";
		const background = request.background === true;
		// 模式取**当次调用**（父会话切换模式后子代理立即跟随）
		const mode: AgentMode = request.mode ?? options.mode;
		// 父会话 id 同样取**当次调用**（缺省回落到建 runner 时给的）
		const parentSessionId = request.parentSessionId ?? options.parentSessionId;

		// fork / background 都要"父会话访问权"：缺了**建子会话之前**就快速失败，绝不静默降级
		if ((kind === "fork" || background) && request.sessionLog === undefined) {
			throw new Error(parentAccessRequired(kind, background));
		}

		const prepared = await prepare(request, kind, mode, parentSessionId, request.sessionLog);

		if (!background) return await prepared.run();

		const access = requireSessionLog(request.sessionLog, kind, true);
		// 后台 flow：绝不 reject（失败也落成 ok=false 的 subagent/result），故 drain 永不炸
		const settled: Promise<void> = prepared.run().then(
			(result) =>
				deliver(access, {
					childSessionId: result.childSessionId,
					kind: result.kind,
					ok: true,
					summary: result.summary,
					steps: result.steps,
					stopReason: result.stopReason,
				}),
			(error: unknown) =>
				deliver(access, {
					childSessionId: prepared.childSessionId,
					kind,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}),
		);
		BACKGROUND_TASKS.add(settled);
		void settled.then(() => {
			BACKGROUND_TASKS.delete(settled);
		});

		return { childSessionId: prepared.childSessionId, kind, status: "running" };
	}

	async function drain(): Promise<void> {
		// 可能边等边新增（子代理内部再派发 background），故循环到真空为止
		while (BACKGROUND_TASKS.size > 0) {
			await Promise.all([...BACKGROUND_TASKS]);
		}
	}

	return { depth, maxDepth, dispatch, drain, inflight: () => BACKGROUND_TASKS.size };
}
