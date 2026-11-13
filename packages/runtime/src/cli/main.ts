/**
 * Aster CLI 入口（M1：最小 REPL + 索引维护命令；M6：`--doctor`；M7a：本地配置；
 * M7b：按 `mcp.servers` 桥接 MCP 服务器）。
 *
 * 参数解析见 `./args.js`，provider 解析见 `./provider.js`，**会话运行时装配**见 `./bootstrap.js`
 * （M13b 起与桌面版共用同一份装配，见 ADR-029 增补）。
 *
 * 用法：
 *   aster [--home <dir>] [--mode plan|build] [--config <file>] [--resume <sessionId|latest>]
 *   aster [--home <dir>] --list
 *   aster [--home <dir>] --rebuild-index
 *   aster [--home <dir>] --doctor
 *   aster [--home <dir>] --export <sessionId|latest> [--format aster|claude-code|zcode] --out <file>
 *   aster [--home <dir>] --import <file> [--format aster|claude-code|zcode]
 *   aster [--home <dir>] --export-memory --out <file> [--memory-session <id>]
 *   aster [--home <dir>] --import-memory <file> [--out <file>]   # 校验 + 规范化（不写记忆层，ADR-016/030）
 *   aster [--home <dir>] --serve [--port N] [--host H]   # SSE 服务端（回环下另开远端写路径）
 *   aster --attach <url>                                  # 只读镜像远端会话（不进 REPL）
 *   aster [--home <dir>] --record <cassette.jsonl> [--mode …] [--stub … | --demo-*]  # 录制（ADR-037）
 *   aster [--home <dir>] --replay <cassette.jsonl>        # 回放（不需要密钥、不发网络请求）
 */
import { argv, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { createSessionStore } from "../persist/index.js";
import { createTheme, isTuiSupported, runTuiSession } from "../tui/index.js";
import { startAcpCommand } from "./acp-wiring.js";
import { type CliOptions, parseArgs } from "./args.js";
import { runAttachSession } from "./attach.js";
import { bootstrapSessionRuntime, SandboxModeError } from "./bootstrap.js";
import { runDoctor } from "./doctor.js";
import { runMcpInspectCommand } from "./mcp-inspect.js";
import { runMemoryPortableCommand } from "./memory-portable.js";
import { runPortableCommand } from "./portable.js";
import { runSessionRepl } from "./repl.js";
import { startServeCommand } from "./serve-wiring.js";

export { parseArgs };
export type { CliOptions };

async function main(): Promise<void> {
	const options = parseArgs(argv.slice(2));
	const storeOptions = options.home === undefined ? {} : { home: options.home };

	if (options.doctor) {
		// 环境自检（M6）：以退出码汇报（0=关键项全通过，1=有阻塞项）
		process.exitCode = await runDoctor({
			...(options.home === undefined ? {} : { home: options.home }),
			output: { write: (text) => stdout.write(text) },
		});
		return;
	}

	if (options.list) {
		const store = createSessionStore(storeOptions);
		const metas = await store.list();
		for (const meta of metas) {
			stdout.write(
				`${meta.sessionId}\t${meta.mode}\tevents=${meta.eventCount}\t${meta.updatedAt}\t${meta.cwd}\n`,
			);
		}
		stdout.write(`total ${metas.length} session(s)\n`);
		await store.dispose();
		return;
	}

	if (options.rebuildIndex) {
		const store = createSessionStore(storeOptions);
		const report = await store.rebuildIndex();
		stdout.write(`rebuilt index: ${report.sessions} session(s), ${report.events} event(s)\n`);
		await store.dispose();
		return;
	}

	if (options.exportTarget !== undefined || options.importPath !== undefined) {
		// ADR-019：会话可移植（导出/导入）——**不进 REPL**，打印结果并退出
		await runPortableCommand({
			...(options.home === undefined ? {} : { home: options.home }),
			...(options.exportTarget === undefined ? {} : { exportTarget: options.exportTarget }),
			...(options.importPath === undefined ? {} : { importPath: options.importPath }),
			...(options.format === undefined ? {} : { format: options.format }),
			...(options.out === undefined ? {} : { out: options.out }),
			output: { write: (text) => stdout.write(text) },
		});
		return;
	}

	if (options.exportMemory === true || options.importMemoryPath !== undefined) {
		// ADR-030：记忆交换（导出配置的记忆层 / 校验并规范化一份文档）——**不进 REPL**
		await runMemoryPortableCommand({
			...(options.home === undefined ? {} : { home: options.home }),
			...(options.config === undefined ? {} : { config: options.config }),
			...(options.exportMemory === true ? { exportMemory: true } : {}),
			...(options.importMemoryPath === undefined
				? {}
				: { importMemoryPath: options.importMemoryPath }),
			...(options.memorySession === undefined ? {} : { memorySession: options.memorySession }),
			...(options.out === undefined ? {} : { out: options.out }),
			output: { write: (text) => stdout.write(text) },
		});
		return;
	}

	if (options.mcpPrompts !== undefined || options.mcpResources !== undefined) {
		// ADR-035：MCP 只读面（提示词 / 资源）——**不进 REPL**，打印结果并退出
		await runMcpInspectCommand({
			...(options.home === undefined ? {} : { home: options.home }),
			...(options.config === undefined ? {} : { config: options.config }),
			server: (options.mcpPrompts ?? options.mcpResources) as string,
			kind: options.mcpPrompts !== undefined ? "prompts" : "resources",
			output: { write: (text) => stdout.write(text) },
		});
		return;
	}

	if (options.acp === true) {
		// ADR-036：ACP agent 通道（stdout **只**走 JSON-RPC；诊断走 stderr）
		await startAcpCommand(options, {
			input: process.stdin,
			output: { write: (text) => stdout.write(text) },
			diagnostics: { write: (text) => process.stderr.write(text) },
		});
		return;
	}

	if (options.attach !== undefined) {
		// ADR-022：`--attach <url>` 只读镜像远端会话——**不进 REPL**，镜像结束即退出
		await runAttachSession({
			url: options.attach,
			...(options.noColor === true ? { theme: createTheme({ disabled: true }) } : {}),
		});
		return;
	}

	// ADR-029 增补：会话运行时装配与桌面版**共用同一份**（`bootstrap.ts`）
	const output = { write: (text: string) => stdout.write(text) };
	const runtime = await bootstrapSessionRuntime({ options, output });
	try {
		// ADR-021 / ADR-022：`--serve` 随会话一起开 SSE 服务端（只读事件流 + 回放 + 回环下的远端写）
		const serve =
			options.serve === true
				? await startServeCommand({
						...(options.home === undefined ? {} : { home: options.home }),
						...(options.host === undefined ? {} : { host: options.host }),
						...(options.port === undefined ? {} : { port: options.port }),
						...(runtime.provider === undefined ? {} : { provider: runtime.provider }),
						...(runtime.model === undefined ? {} : { model: runtime.model }),
						...(runtime.tools === undefined ? {} : { tools: runtime.tools }),
						permission: runtime.permission,
						contextBuilder: runtime.contextBuilder,
						...(runtime.compaction === undefined ? {} : { compaction: runtime.compaction }),
						...(runtime.memory === undefined ? {} : { memory: runtime.memory }),
						write: (text: string) => stdout.write(text),
					})
				: undefined;

		const replOptions = {
			...(options.home === undefined ? {} : { home: options.home }),
			...(options.resume === undefined ? {} : { resume: options.resume }),
			...(runtime.provider === undefined ? {} : { provider: runtime.provider }),
			...(runtime.model === undefined ? {} : { model: runtime.model }),
			...(runtime.tools === undefined ? {} : { tools: runtime.tools }),
			...(runtime.memory === undefined ? {} : { memory: runtime.memory }),
			...(runtime.subagents === undefined ? {} : { subagents: runtime.subagents }),
			...(serve === undefined
				? {}
				: { onEvent: serve.onEvent, onSessionReady: serve.registerLive }),
			permission: runtime.permission,
			contextBuilder: runtime.contextBuilder,
			...(runtime.compaction === undefined ? {} : { compaction: runtime.compaction }),
			mode: runtime.defaultMode,
			...(runtime.sandboxLabel === undefined ? {} : { sandboxLabel: runtime.sandboxLabel }),
			output,
		};
		// ADR-020：`--tui` 走差分渲染前端；环境不支持 TTY 时**明确提示并回落**朴素 REPL
		const useTui = options.tui === true;
		if (useTui && !isTuiSupported()) {
			stdout.write("tui: stdout/stdin is not a TTY — falling back to the plain REPL\n");
		}
		if (useTui && isTuiSupported()) {
			await runTuiSession({
				...replOptions,
				input: process.stdin,
				theme: createTheme(options.noColor === true ? { disabled: true } : {}),
			});
		} else {
			await runSessionRepl({ ...replOptions, input: process.stdin });
		}
		if (serve !== undefined) await serve.handle.close();
	} finally {
		// 绝不留下孤儿进程 / 监听中的端口（含在途 SSE 连接）
		await runtime.dispose();
	}
}

/**
 * **构建期常量**（esbuild `define`）：本文件被打成**可执行 CLI** 时置 `true`；
 * 被打进**别的 App**（如桌面版的 `dist/app/main.mjs`）时置 `false`。
 * 未定义（`tsx` / `tsc` 直跑）时下面的守卫不生效，退回 URL 比较。
 */
declare const ASTER_CLI_ENTRY: boolean | undefined;

/**
 * 仅在被当作**可执行入口**运行时才启动，避免被 import 时误读 stdin。
 *
 * ⚠️ **只比较 `import.meta.url === argv[1]` 是不够的**（M13d-2 实测抓到的真缺陷）：
 * 本包会被 esbuild **打进别的 App**——那时 `import.meta.url` 就是那个 App 的入口文件，
 * 与 `argv[1]` **同一个** ⇒ `isMainModule()` 误报为真，**CLI 的 `main()` 会在 GUI 进程里跑起来**
 * （读 stdin、开一条野生 REPL、往数据根里写会话）。⇒ 额外用构建期常量把这条路**关死**。
 */
function isMainModule(): boolean {
	if (typeof ASTER_CLI_ENTRY === "boolean" && ASTER_CLI_ENTRY === false) return false;
	const entry = argv[1];
	if (entry === undefined) return false;
	try {
		return import.meta.url === pathToFileURL(entry).href;
	} catch {
		return false;
	}
}

if (isMainModule()) {
	main().catch((error: unknown) => {
		if (error instanceof SandboxModeError) {
			// 未知 --sandbox 取值：与既有行为一致（可读提示 + 退出码 2），绝不静默退回 off
			stdout.write(`  [error] ${error.message}\n`);
			process.exitCode = 2;
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`aster: ${message}\n`);
		process.exitCode = 1;
	});
}
