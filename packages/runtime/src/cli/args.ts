/**
 * CLI 参数解析（从 `main.ts` 拆出，见架构门禁的 400 行上限）。
 *
 * 只负责「字符串 -> 结构化选项」；**不做**任何 IO、不读环境变量、不读配置文件
 * （优先级合并由调用方按 ADR-014 处理）。
 */
import type { AgentMode, PortableFormat } from "@aster/schema";
import { AGENT_MODES, PORTABLE_FORMATS } from "@aster/schema";
import { SANDBOX_MODES } from "../sandbox/index.js";
import type { ResumeTarget } from "./repl.js";

export interface CliOptions {
	home?: string;
	resume?: ResumeTarget;
	/** CLI `--config`：显式指定配置文件（优先级高于 `ASTER_CONFIG`，并跳过自动发现）。 */
	config?: string;
	/** CLI `--mode`：**未提供时为 undefined**（留给 `ASTER_MODE` / 配置文件 / 内置默认）。 */
	mode?: AgentMode;
	list: boolean;
	rebuildIndex: boolean;
	/** 环境自检（M6）：检查 Node/平台/sqlite/HOME 可写/端点/编码，并以退出码汇报。 */
	doctor: boolean;
	/** keyless 演示：用桩 provider 回放固定文本（不访问网络、不需要密钥）。 */
	stub?: string;
	/** keyless 演示：脚本化「先 read 指定文件、再总结」的完整闭环。 */
	demoRead?: string;
	/** keyless 演示：脚本化「写文件」——用于现场复现 plan/build 权限差异（判据 #10）。 */
	demoWrite?: string;
	/** keyless 演示：脚本化一次 bash 调用（可配合 --ext-timeout 复现扩展缝，判据 #6）。 */
	demoBash?: string;
	/** keyless 录制回放（ADR-037）：把本次会话的每次 LLM 往返录进该 cassette 文件。 */
	record?: string;
	/** keyless 录制回放（ADR-037）：只从该 cassette 回放，**不访问网络、不需要密钥**。 */
	replay?: string;
	/** 加载「超时中间件」示例扩展（不改主循环即生效）。 */
	extTimeout?: number;
	/** 加载「短路内置行为」示例扩展（对指定工具不调 next()）。 */
	extShortCircuit?: string;
	/** 关闭默认 4 原语工具（用于纯对话/仅记录场景）。 */
	noTools?: boolean;
	/** 会话可移植（ADR-019）：`--export <sessionId|latest>`。 */
	exportTarget?: string;
	/** 会话可移植（ADR-019）：`--import <path>`。 */
	importPath?: string;
	/** 会话可移植（ADR-019）：`--format aster|claude-code|zcode`（缺省 `aster`）。 */
	format?: PortableFormat;
	/** 会话可移植（ADR-019）：`--export` 的输出路径。 */
	out?: string;
	/** 记忆交换（ADR-030）：`--export-memory`（把配置的记忆层导出为 canonical 文档；`--out` 必填）。 */
	exportMemory?: boolean;
	/** 记忆交换（ADR-030）：`--import-memory <path>`（校验/规范化一份记忆交换文档）。 */
	importMemoryPath?: string;
	/** 记忆交换（ADR-030）：导出时用哪个会话作用域（缺省 = 最近更新的那个已记录会话）。 */
	memorySession?: string;
	/** 差分 TUI（ADR-020）：用全屏差分渲染前端替代朴素 REPL。 */
	tui?: boolean;
	/** 关闭上色（ADR-020；等价于设置 `NO_COLOR`）。 */
	noColor?: boolean;
	/**
	 * 沙箱（ADR-027 / ADR-031）：`off`（缺省）/ `best-effort` / `windows-job`（Windows-only，内核强制围栏）。
	 * **默认关**；未知取值**快速失败**（绝不静默退回 off）。
	 */
	sandbox?: string;
	/** client/server（ADR-021）：随会话一起启动 SSE 服务端。 */
	serve?: boolean;
	/** client/server（ADR-021）：监听端口（缺省 8787；`0` = 由系统分配）。 */
	port?: number;
	/** client/server（ADR-021）：监听地址（**缺省 127.0.0.1**；外部暴露需显式指定）。 */
	host?: string;
	/** client/server（ADR-022）：`--attach <url>` 只读镜像远端会话，**不进 REPL**。 */
	attach?: string;
	/** MCP 只读面（ADR-035）：列出指定服务器的提示词，**不进 REPL**。 */
	mcpPrompts?: string;
	/** MCP 只读面（ADR-035）：列出指定服务器的资源，**不进 REPL**。 */
	mcpResources?: string;
	/** ACP 通道（ADR-036）：把本进程变成 ACP agent（stdout 只走 JSON-RPC），**不进 REPL**。 */
	acp?: boolean;
}

export function parseArgs(args: readonly string[]): CliOptions {
	const options: CliOptions = {
		list: false,
		rebuildIndex: false,
		doctor: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		switch (arg) {
			case "--home": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--home requires a directory");
				options.home = value;
				i += 1;
				break;
			}
			case "--config": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--config requires a file path");
				options.config = value;
				i += 1;
				break;
			}
			case "--mode": {
				const value = args[i + 1];
				if (value === undefined || !AGENT_MODES.includes(value as AgentMode)) {
					throw new Error(`--mode must be one of: ${AGENT_MODES.join(", ")}`);
				}
				options.mode = value as AgentMode;
				i += 1;
				break;
			}
			case "--resume": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--resume requires a session id or 'latest'");
				options.resume = value as ResumeTarget;
				i += 1;
				break;
			}
			case "--doctor":
				options.doctor = true;
				break;
			case "--list":
				options.list = true;
				break;
			case "--rebuild-index":
				options.rebuildIndex = true;
				break;
			case "--stub": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--stub requires a text to replay");
				options.stub = value;
				i += 1;
				break;
			}
			case "--no-tools":
				options.noTools = true;
				break;
			case "--tui":
				options.tui = true;
				break;
			case "--no-color":
				options.noColor = true;
				break;
			case "--sandbox": {
				const value = args[i + 1];
				if (value === undefined) {
					throw new Error(`--sandbox requires a mode: ${SANDBOX_MODES.join(" | ")}`);
				}
				options.sandbox = value;
				i += 1;
				break;
			}
			case "--serve":
				options.serve = true;
				break;
			case "--acp":
				options.acp = true;
				break;
			case "--attach": {
				const value = args[i + 1];
				if (value === undefined || value.trim() === "") {
					throw new Error("--attach requires a server url (e.g. http://127.0.0.1:8787)");
				}
				options.attach = value;
				i += 1;
				break;
			}
			case "--mcp-prompts":
			case "--mcp-resources": {
				const value = args[i + 1];
				if (value === undefined || value.trim() === "") {
					throw new Error(`${args[i]} requires a server name declared in mcp.servers`);
				}
				if (args[i] === "--mcp-prompts") options.mcpPrompts = value;
				else options.mcpResources = value;
				i += 1;
				break;
			}
			case "--port": {
				const value = Number(args[i + 1]);
				if (!Number.isInteger(value) || value < 0 || value > 65535) {
					throw new Error("--port requires an integer in [0, 65535]");
				}
				options.port = value;
				i += 1;
				break;
			}
			case "--host": {
				const value = args[i + 1];
				if (value === undefined || value.trim() === "") {
					throw new Error("--host requires an address (e.g. 127.0.0.1 or 0.0.0.0)");
				}
				options.host = value;
				i += 1;
				break;
			}
			case "--export": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--export requires a session id or 'latest'");
				options.exportTarget = value;
				i += 1;
				break;
			}
			case "--import": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--import requires a file path");
				options.importPath = value;
				i += 1;
				break;
			}
			case "--format": {
				const value = args[i + 1];
				if (value === undefined || !PORTABLE_FORMATS.includes(value as PortableFormat)) {
					throw new Error(`--format must be one of: ${PORTABLE_FORMATS.join(", ")}`);
				}
				options.format = value as PortableFormat;
				i += 1;
				break;
			}
			case "--out": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--out requires a file path");
				options.out = value;
				i += 1;
				break;
			}
			case "--export-memory":
				options.exportMemory = true;
				break;
			case "--import-memory": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--import-memory requires a file path");
				options.importMemoryPath = value;
				i += 1;
				break;
			}
			case "--memory-session": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--memory-session requires a session id");
				options.memorySession = value;
				i += 1;
				break;
			}
			case "--demo-read": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--demo-read requires a file path");
				options.demoRead = value;
				i += 1;
				break;
			}
			case "--demo-write": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--demo-write requires a file path");
				options.demoWrite = value;
				i += 1;
				break;
			}
			case "--demo-bash": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--demo-bash requires a command");
				options.demoBash = value;
				i += 1;
				break;
			}
			case "--record": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--record requires a cassette file path");
				options.record = value;
				i += 1;
				break;
			}
			case "--replay": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--replay requires a cassette file path");
				options.replay = value;
				i += 1;
				break;
			}
			case "--ext-timeout": {
				const value = Number(args[i + 1]);
				if (!Number.isFinite(value) || value <= 0) {
					throw new Error("--ext-timeout requires a positive number (ms)");
				}
				options.extTimeout = value;
				i += 1;
				break;
			}
			case "--ext-short-circuit": {
				const value = args[i + 1];
				if (value === undefined) throw new Error("--ext-short-circuit requires a tool name");
				options.extShortCircuit = value;
				i += 1;
				break;
			}
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}
