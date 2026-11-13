/**
 * 会话运行时装配（ADR-029 增补，M13b）——**从 `cli/main.ts` 抽出**，供**两种外壳共用**：
 *  ① `cli/main.ts`（CLI / TUI / --serve 的本地 REPL 路径）；② 桌面版 main 进程（`@chenxi/desktop`）。
 *
 * 为什么抽出来而不是把 `@chenxi/runtime` 根入口摊成"什么都能 import"：
 * 桌面版真正需要的是"**一份配好的会话运行时**"（provider / 工具 / 权限 / 上下文构造器 / 记忆缝 / 子代理），
 * 而不是散落各处的 `tools` / `shell` / `context` / `sandbox` 内部模块。⇒ 装配留在这里（runtime 包内），
 * 只经**已有的 `cli` 命名空间**暴露（`bootstrapSessionRuntime`）。
 *
 * 纪律：本文件**只做装配**，不做交互（不做输入/输出通道、不建会话、不写事件）——
 * 会话的建立与唯一写入路径仍归 `runSessionRepl` / `persist`。
 */
import type { AgentMode, SessionId } from "@chenxi/schema";
import { type LoadedConfig, loadConfig, resolveDefaultMode } from "../config/index.js";
import {
	type CompactionConfig,
	type ContextBuilder,
	createContextBuilder,
	DEFAULT_COMPACTION_KEEP_TURNS,
	DEFAULT_COMPACTION_MAX_CHARS,
} from "../context/index.js";
import { createContext } from "../events/index.js";
import {
	createExtensionHost,
	createExtensionTimeout,
	createShortCircuitExtension,
} from "../extensions/index.js";
import type { LlmProvider } from "../llm/types.js";
import type { ToolRuntime } from "../loop/index.js";
import { type BridgedMcpServer, bridgeMcpServer } from "../mcp/index.js";
import {
	createMcpMemoryAdapter,
	createMemorySeam,
	createMemoryWriter,
	type MemorySeam,
} from "../memory/index.js";
import {
	createPermissionSystem,
	type PermissionSystem,
	resolveModePolicy,
} from "../permission/index.js";
import { resolveHome } from "../persist/index.js";
import type { Sandbox } from "../sandbox/index.js";
import { createSandbox, SANDBOX_MODES, SandboxModeError } from "../sandbox/index.js";
import { selectShellProvider } from "../shell/index.js";
import { createSubagentRunner, createTaskTool, type SubagentRunner } from "../subagent/index.js";
import { createDefaultToolset, createToolRegistry } from "../tools/index.js";
import type { CliOptions } from "./args.js";
import { resolveProvider } from "./provider.js";
import type { Output } from "./repl.js";

/** 未知 / 不可用的 `--sandbox` 取值（快速失败，绝不静默退回 off）——由调用方据此设退出码 2。
 *  **复用 sandbox 模块的那一个类**（同一份实现、同一个 `instanceof`），不另立一个同名类。 */
export { SandboxModeError } from "../sandbox/index.js";

/** 装配好的会话运行时（前端只需把它交给 `runSessionRepl` 的对应字段）。 */
export interface SessionRuntime {
	/** 解析后的默认模式（CLI > env > 配置文件 > 内置）——前端不再自己算。 */
	readonly defaultMode: AgentMode;
	/** 缺省表示"仅记录"（不调用模型）。 */
	readonly provider?: LlmProvider;
	readonly model?: string;
	/** 缺省表示无工具（`--no-tools`）。 */
	readonly tools?: ToolRuntime;
	readonly permission: PermissionSystem;
	readonly contextBuilder: ContextBuilder;
	/**
	 * 长会话上下文压缩（M23，ADR-041）：**缺省不存在** ⇒ 不压缩（默认行为逐字节不变）。
	 * 前端把它原样传给 `executeTurn` 的 `compaction`。
	 */
	readonly compaction?: CompactionConfig;
	/** 记忆注入缝工厂（ADR-016）；缺省表示不注入。 */
	readonly memory?: (sessionId: SessionId) => MemorySeam;
	readonly subagents?: SubagentRunner;
	/** 沙箱说明（ADR-027）；`undefined` ⇒ 未启用（默认 off，不打印）。 */
	readonly sandboxLabel?: string;
	/** 收尾：关闭全部已桥接的 MCP 子进程（**绝不留下孤儿进程**）。 */
	dispose(): Promise<void>;
}

export interface BootstrapOptions {
	readonly options: CliOptions;
	/** 装配过程的可读提示（`config:` / `mcp:` / `memory:` / `subagents:` 行）；桌面版可传空实现。 */
	readonly output: Output;
}

/** 装配默认工具运行时（M3）：`events` 上下文 + 工具注册表 + 4 原语工具（bash 经 shell provider 抽象，ADR-009）。 */
async function createToolRuntime(options: CliOptions, sandbox?: Sandbox): Promise<ToolRuntime> {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	// ADR-027：沙箱**缺省不接线**（两个 provider 行为与 M3 起逐字节相同）
	const shell = selectShellProvider(sandbox === undefined ? {} : { sandbox });
	for (const tool of createDefaultToolset({ shell })) registry.register(tool);

	// 扩展缝（判据 #6）：加载中间件即可改变工具行为，**主循环一行不改**（ADR-004）
	const host = createExtensionHost(ctx, registry);
	if (options.extTimeout !== undefined) {
		await host.load(createExtensionTimeout({ timeoutMs: options.extTimeout }));
	}
	if (options.extShortCircuit !== undefined) {
		await host.load(
			createShortCircuitExtension({
				toolName: options.extShortCircuit,
				value: { shortCircuited: true, by: "builtin.extension-short-circuit" },
			}),
		);
	}
	return { ctx, registry };
}

/**
 * 按配置桥接 MCP 服务器（ADR-015）。
 *
 * 纪律：MCP 是**增强**而非依赖——单个服务器启动失败只打印可读原因并继续
 * （绝不因为外部进程起不来就拒绝启动本工具）。桥接结果打印出来，保证**可审计**。
 */
async function bridgeConfiguredMcpServers(
	tools: ToolRuntime | undefined,
	servers: LoadedConfig["mcpServers"],
	output: Output,
): Promise<BridgedMcpServer[]> {
	const bridgedServers: BridgedMcpServer[] = [];
	if (servers === undefined || servers.length === 0) return bridgedServers;
	if (tools === undefined) {
		output.write(
			`mcp: ${servers.length} server(s) declared, but tools are disabled (--no-tools)\n`,
		);
		return bridgedServers;
	}
	for (const server of servers) {
		try {
			// ADR-035：声明形状二选一——`url`（Streamable HTTP）或 `command`（stdio）
			const transport =
				"url" in server
					? {
							url: server.url,
							...(server.headers === undefined ? {} : { headers: server.headers }),
						}
					: {
							command: server.command,
							...(server.args === undefined ? {} : { args: server.args }),
							...(server.env === undefined ? {} : { env: server.env }),
						};
			const bridged = await bridgeMcpServer({
				serverName: server.name,
				transport,
				registry: tools.registry,
				ctx: tools.ctx,
			});
			bridgedServers.push(bridged);
			output.write(
				`mcp: ${server.name} bridged (${"url" in server ? "http" : "stdio"}) — ` +
					`${bridged.toolNames.length} tool(s): ${bridged.toolNames.join(", ")}\n`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			output.write(`mcp: ${server.name} unavailable — ${message}\n`);
		}
	}
	return bridgedServers;
}

/**
 * 按配置装配记忆注入缝（ADR-016）。
 *
 * 适配器走 **MCP 外挂**（ADR-010）：复用已桥接的那条 stdio 连接，**不**另开进程。
 * 若声明的服务器没桥接成功，则**明确报告并禁用记忆**（fail-open，绝不阻塞对话）。
 */
function createMemorySeamFactory(
	bridgedServers: readonly BridgedMcpServer[],
	memory: LoadedConfig["memory"],
	output: Output,
): ((sessionId: SessionId) => MemorySeam) | undefined {
	if (memory === undefined) return undefined;
	const bridged = bridgedServers.find((server) => server.serverName === memory.server);
	if (bridged === undefined) {
		output.write(
			`memory: declared server "${memory.server}" is not bridged — memory injection disabled\n`,
		);
		return undefined;
	}
	// ADR-033：写入路径**默认关闭**；只有 `memory.write.enabled: true` 才装配（并已校验 addTool 存在）
	const write = memory.write?.enabled === true ? memory.write : undefined;
	const adapter = createMcpMemoryAdapter({
		callTool: bridged.callTool,
		searchTool: memory.searchTool,
		...(write?.addTool === undefined ? {} : { addTool: write.addTool }),
		...(write?.invalidateTool === undefined ? {} : { invalidateTool: write.invalidateTool }),
	});
	const source = `mcp:${memory.server}/${memory.searchTool}`;
	const user = process.env.CHENXI_USER ?? process.env.USER ?? process.env.USERNAME ?? "local";
	if (write !== undefined) {
		output.write(
			`memory: write path ON (add=${write.addTool ?? "(missing)"}` +
				`${write.invalidateTool === undefined ? ", no invalidate tool" : `, invalidate=${write.invalidateTool}`}) ` +
				"— rule-based extraction from user messages only\n",
		);
	}
	return (sessionId: SessionId) => {
		const scope = { user, agent: "chenxi", session: sessionId };
		// 写入缝用**真实** session id；检索（注入 / 去重）在 `seam.ts` 里补成 `session: "*"`（跨会话）
		const writer =
			write?.addTool === undefined
				? undefined
				: createMemoryWriter({
						adapter,
						scope,
						source,
						...(write.maxCandidates === undefined ? {} : { maxCandidates: write.maxCandidates }),
						...(write.minLength === undefined ? {} : { minLength: write.minLength }),
						...(write.maxLength === undefined ? {} : { maxLength: write.maxLength }),
					});
		return createMemorySeam({
			adapter,
			source,
			scope,
			...(memory.limit === undefined ? {} : { limit: memory.limit }),
			...(writer === undefined ? {} : { writer }),
		});
	};
}

/**
 * 按配置注册子代理 `task` 工具（ADR-017）。
 *
 * 纪律：
 *  - **默认不注册**（`subagents.enabled` 缺省即关闭）——保持默认工具集**恰好 4 原语**的可声明性；
 *  - 没有模型端点时也不注册（子代理本身要跑一个回合，注册了只会得到一个必然失败的工具）；
 *  - 模式**不由此处固化**：`task` 工具执行时从 `ToolCallContext.mode` 取**当次**模式。
 */
function registerSubagentTool(deps: {
	readonly subagents: LoadedConfig["subagents"];
	readonly tools: ToolRuntime | undefined;
	readonly provider: LlmProvider | undefined;
	readonly model: string | undefined;
	readonly mode: AgentMode;
	readonly permission: PermissionSystem;
	readonly contextBuilder: ContextBuilder;
	readonly home: string;
	readonly output: Output;
}): SubagentRunner | undefined {
	const declaration = deps.subagents;
	if (declaration?.enabled !== true) return undefined;
	if (deps.tools === undefined) {
		deps.output.write(
			"subagents: enabled, but tools are disabled (--no-tools) — `task` not registered\n",
		);
		return undefined;
	}
	if (deps.provider === undefined || deps.model === undefined) {
		deps.output.write(
			"subagents: enabled, but no model endpoint is configured — `task` not registered\n",
		);
		return undefined;
	}
	const runner = createSubagentRunner({
		home: deps.home,
		cwd: process.cwd(),
		mode: deps.mode, // 仅作缺省；实际以当次调用的 context.mode 为准
		model: deps.model,
		provider: deps.provider,
		permission: deps.permission,
		contextBuilder: deps.contextBuilder,
		...(declaration.maxDepth === undefined ? {} : { maxDepth: declaration.maxDepth }),
	});
	deps.tools.registry.register(createTaskTool(runner));
	deps.output.write(
		`subagents: \`task\` registered (maxDepth=${runner.maxDepth}; sub-agent sessions are isolated)\n`,
	);
	return runner;
}

/**
 * M23（ADR-041）：把配置里的 `context.compaction` 解析成运行时配置。
 * **只有显式 `enabled: true` 才返回**（不设缺省 ⇒ 不配置等于关，默认行为逐字节不变）。
 */
function resolveCompactionConfig(loaded: LoadedConfig): CompactionConfig | undefined {
	const declared = loaded.context?.compaction;
	if (declared === undefined || declared.enabled !== true) return undefined;
	return {
		maxChars: declared.maxChars ?? DEFAULT_COMPACTION_MAX_CHARS,
		keepTurns: declared.keepTurns ?? DEFAULT_COMPACTION_KEEP_TURNS,
	};
}

/** 装配一份会话运行时（详见文件头）。未知 `--sandbox` 取值抛 `SandboxModeError`。 */ export async function bootstrapSessionRuntime(
	input: BootstrapOptions,
): Promise<SessionRuntime> {
	const { options, output } = input;

	// ADR-014：本地配置（优先级 CLI > env > 配置文件 > 内置默认）
	const loaded = loadConfig({
		...(options.home === undefined ? {} : { home: options.home }),
		...(options.config === undefined ? {} : { explicitPath: options.config }),
	});
	const defaultMode = resolveDefaultMode({
		...(options.mode === undefined ? {} : { cliMode: options.mode }),
		config: loaded,
	});
	// 可审计：明确告诉用户本次到底读进了哪些配置文件（或 none）
	output.write(
		loaded.sources.length === 0
			? "config: none (built-in defaults)\n"
			: `config: ${loaded.sources.join(", ")}\n`,
	);

	const { provider, model, cassette } = resolveProvider(options, loaded);
	// M19（ADR-037）：录制 / 回放是**显式动作**，横幅写清去向与"回放不需要密钥/网络"。
	if (cassette !== undefined) {
		if (cassette.mode === "record") {
			output.write(
				`cassette: recording to ${cassette.path} (provider=${provider?.id ?? "none"}, ` +
					`model=${model ?? "none"}) — replay with --replay ${cassette.path} (no API key needed)\n`,
			);
		} else {
			output.write(
				`cassette: replay ${cassette.path} (${cassette.exchanges ?? 0} exchange(s), ` +
					`model=${model ?? "unknown"}) — no API key / no network\n`,
			);
		}
	}
	// ADR-027 / ADR-031：沙箱缺省 off（`undefined` 或 `off` ⇒ 不接线，行为与 M3 起逐字节相同）；
	// 未知取值 → 快速失败；`windows-job` 但非 Windows → `SandboxModeError`（**明确不可用**，不静默降级）
	const resolvedSandbox = createSandbox(options.sandbox, { home: resolveHome(options.home) });
	if (options.sandbox !== undefined && resolvedSandbox === undefined) {
		throw new SandboxModeError(
			`unknown --sandbox mode "${options.sandbox}"; expected: ${SANDBOX_MODES.join(" | ")}`,
		);
	}
	// 凡**改写执行**的沙箱都要在首屏横幅上自报家门（写清"做了什么 / 没做什么"）
	const activeSandbox = resolvedSandbox?.altersExecution === true ? resolvedSandbox : undefined;
	// 启用时把"做了什么 / 没做什么"打在首屏横幅上（**必须自带 experimental 与非隔离字样**）
	const sandboxLabel =
		activeSandbox === undefined
			? undefined
			: (() => {
					const audit = activeSandbox.auditDataRoot(resolveHome(options.home));
					const state = audit.tight ? "已收紧" : `未收紧（${audit.reason}）`;
					const hint = audit.tight || audit.hint === "" ? "" : `；手动收紧：${audit.hint}`;
					return `${activeSandbox.label}；数据根权限体检: ${state}${hint}`;
				})();
	const tools =
		options.noTools === true ? undefined : await createToolRuntime(options, activeSandbox);
	// ADR-015：按配置桥接 MCP 服务器（失败只提示、不阻塞；桥接结果打印以保证可审计）
	const bridgedServers = await bridgeConfiguredMcpServers(tools, loaded.mcpServers, output);
	// ADR-013/ADR-014：模式 -> 权限是**默认配置**，可被配置文件按模式整段覆盖
	const permission = createPermissionSystem({ policy: resolveModePolicy(loaded.permissions) });
	// ADR-011/ADR-013：分节提示词 + 每回合模式对账（必须送达模型）
	const contextBuilder = createContextBuilder();
	// ADR-016：记忆注入缝（MCP 外挂；未配置或未桥接成功则为 undefined = 不注入）
	const memoryFactory = createMemorySeamFactory(bridgedServers, loaded.memory, output);
	// ADR-017：子代理 `task` 工具（默认关闭；开启后注册）
	const subagents = registerSubagentTool({
		subagents: loaded.subagents,
		tools,
		provider,
		model,
		mode: defaultMode,
		permission,
		contextBuilder,
		home: resolveHome(options.home),
		output,
	});
	// M23（ADR-041）：上下文压缩**只在显式 `enabled:true` 时**才给出配置（缺省 = 不压缩）
	const compaction = resolveCompactionConfig(loaded);
	if (compaction !== undefined) {
		output.write(
			`context: compaction enabled (maxChars=${compaction.maxChars}, keepTurns=${compaction.keepTurns})\n`,
		);
	}

	return {
		defaultMode,
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(tools === undefined ? {} : { tools }),
		permission,
		contextBuilder,
		...(compaction === undefined ? {} : { compaction }),
		...(memoryFactory === undefined ? {} : { memory: memoryFactory }),
		...(subagents === undefined ? {} : { subagents }),
		...(sandboxLabel === undefined ? {} : { sandboxLabel }),
		async dispose(): Promise<void> {
			// 绝不留下孤儿进程：关闭全部已桥接的 MCP 子进程
			for (const server of bridgedServers) server.dispose();
		},
	};
}
