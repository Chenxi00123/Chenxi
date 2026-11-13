/**
 * CLI 的记忆交换命令（ADR-030）：`--export-memory` / `--import-memory`。
 *
 * 只负责 **IO 与打印**：格式逻辑在 `memory/exchange.ts`，读侧在 `memory/portable.ts`。
 * 三条纪律：
 *  - **绝不打开记忆层写入路径**（ADR-016 显式推迟 `add`）⇒ `--import-memory` 只做
 *    **校验 + 规范化（可选 `--out` 落盘）**，并把这句**打印出来**（不许让用户以为"导进去了"）；
 *  - 导出**必须**打印"读到了什么作用域 / 几条 / 丢了几条"，以及"记忆层是外挂、我们不自研"；
 *  - 两者都**不进 REPL**：打印结果并退出（与 `--export` / `--import` 一致）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { MemoryScope, SessionId } from "@aster/schema";
import { MEMORY_EXCHANGE_FORMAT, MEMORY_EXCHANGE_FORMAT_VERSION } from "@aster/schema";
import { loadConfig } from "../config/index.js";
import { createContext } from "../events/index.js";
import { bridgeMcpServer } from "../mcp/index.js";
import {
	buildMemoryExchangeDocument,
	createMcpMemoryAdapter,
	normalizeMemoryExchangeDocument,
	parseMemoryExchangeJson,
	readMemoryLayerForExport,
} from "../memory/index.js";
import { createSessionStore } from "../persist/index.js";
import { ASTER_PRODUCER, resolveLatestSession } from "../portable/index.js";
import { createToolRegistry } from "../tools/index.js";
import type { Output } from "./repl.js";

/** 我们对外**明确承诺**不做的那件事，必须每次都说出来（ADR-016）。 */
const NO_WRITE_NOTE =
	"note: nothing was written into any memory layer — the memory write path (`add`) is " +
	"deferred by design (ADR-016)";

export interface MemoryPortableCliOptions {
	readonly home?: string;
	/** CLI `--config`：显式指定配置文件（与 REPL 路径同源，见 ADR-014）。 */
	readonly config?: string;
	/** `--export-memory`：是否执行导出。 */
	readonly exportMemory?: boolean;
	/** `--import-memory <path>`。 */
	readonly importMemoryPath?: string;
	/** 导出时用哪个会话作用域（缺省 = 最近更新的那个已记录会话）。 */
	readonly memorySession?: string;
	/** `--out`：导出/规范化重写的落盘路径。 */
	readonly out?: string;
	readonly output: Output;
}

/** 作用域里的 user 键：与 `bootstrap.ts` 的记忆缝**同一口径**（一处算不出两种身份）。 */
export function resolveMemoryUser(): string {
	return process.env.ASTER_USER ?? process.env.USER ?? process.env.USERNAME ?? "local";
}

async function runExport(options: MemoryPortableCliOptions): Promise<void> {
	const out = options.out;
	if (out === undefined) throw new Error("--export-memory requires --out <path>");

	const loaded = loadConfig({
		...(options.home === undefined ? {} : { home: options.home }),
		...(options.config === undefined ? {} : { explicitPath: options.config }),
	});
	if (loaded.memory === undefined) {
		throw new Error(
			"--export-memory: no memory layer is configured — declare memory.{server,searchTool} in " +
				`a config file (looked at: ${loaded.sources.length === 0 ? "none found" : loaded.sources.join(", ")}); ` +
				"aster does not own a memory store (ADR-010) and will not invent one",
		);
	}
	const declaration = loaded.memory;
	const server = (loaded.mcpServers ?? []).find(
		(candidate) => candidate.name === declaration.server,
	);
	if (server === undefined) {
		throw new Error(
			`--export-memory: memory.server "${declaration.server}" is not among the declared mcp.servers`,
		);
	}

	// 作用域的 session 键：显式 `--memory-session`，缺省取最近更新的**已记录**会话（可审计、可复现）
	const store = createSessionStore(options.home === undefined ? {} : { home: options.home });
	let session: SessionId;
	try {
		session =
			options.memorySession === undefined
				? resolveLatestSession(await store.list())
				: (options.memorySession as SessionId);
	} finally {
		await store.dispose();
	}
	const scope: MemoryScope = { user: resolveMemoryUser(), agent: "aster", session };

	// 只桥接**这一个**声明过的服务器：不建工具运行时、不装配 REPL（导出只要一条读连接）
	const ctx = createContext();
	const bridged = await bridgeMcpServer({
		serverName: server.name,
		// ADR-035：声明可以是 stdio（command）或 Streamable HTTP（url）
		transport:
			"url" in server
				? {
						url: server.url,
						...(server.headers === undefined ? {} : { headers: server.headers }),
					}
				: {
						command: server.command,
						...(server.args === undefined ? {} : { args: server.args }),
						...(server.env === undefined ? {} : { env: server.env }),
					},
		registry: createToolRegistry(ctx),
		ctx,
	});
	try {
		const exported = await readMemoryLayerForExport({
			adapter: createMcpMemoryAdapter({
				callTool: bridged.callTool,
				searchTool: declaration.searchTool,
			}),
			scope,
			producer: ASTER_PRODUCER,
		});
		const document = buildMemoryExchangeDocument({
			scope: exported.scope,
			records: exported.records,
			producer: exported.producer,
		});
		writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
		options.output.write(
			`exported ${exported.records.length} memory record(s) as ${MEMORY_EXCHANGE_FORMAT} ` +
				`v${MEMORY_EXCHANGE_FORMAT_VERSION} (lossless for Aster) -> ${out}\n`,
		);
		options.output.write(
			`scope: user=${scope.user} agent=${scope.agent} session=${scope.session}` +
				` (source: mcp:${declaration.server}/${declaration.searchTool})\n`,
		);
	} finally {
		bridged.dispose();
	}
}

/** 把解析后的文档打印成"看一眼就能核对"的摘要（不写记忆层）。 */
function writeSummary(
	options: MemoryPortableCliOptions,
	path: string,
	parsed: ReturnType<typeof parseMemoryExchangeJson>,
): void {
	options.output.write(
		`${path}: ${MEMORY_EXCHANGE_FORMAT} v${parsed.formatVersion} by ` +
			`${parsed.producer.name} ${parsed.producer.version} — ${parsed.records.length} record(s)\n`,
	);
	options.output.write(
		`scope: user=${parsed.scope.user} agent=${parsed.scope.agent} session=${parsed.scope.session}\n`,
	);
	for (const record of parsed.records.slice(0, 10)) {
		options.output.write(`  - ${record.id}: ${preview(record.content)}\n`);
	}
	if (parsed.records.length > 10) {
		options.output.write(`  … ${parsed.records.length - 10} more\n`);
	}
}

/** 单条正文的单行预览（只用于人眼核对，故**不**求完整）。 */
function preview(content: string): string {
	const single = content.replace(/\s+/g, " ").trim();
	return single.length <= 60 ? single : `${single.slice(0, 60)}…`;
}

async function runImport(options: MemoryPortableCliOptions): Promise<void> {
	const path = options.importMemoryPath as string;
	const parsed = parseMemoryExchangeJson(readFileSync(path, "utf8"));
	writeSummary(options, path, parsed);

	if (options.out !== undefined) {
		// 规范化重写（= 主张 4 的「迁移」落点）：未知键剥掉、产出方换成本仓、版本锚到当前
		const document = normalizeMemoryExchangeDocument(parsed, ASTER_PRODUCER);
		writeFileSync(options.out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
		options.output.write(`normalized (canonical form, unknown keys stripped) -> ${options.out}\n`);
	}
	options.output.write(`${NO_WRITE_NOTE}\n`);
}

/** 执行 `--export-memory` / `--import-memory`（两者都**不进 REPL**）。 */
export async function runMemoryPortableCommand(options: MemoryPortableCliOptions): Promise<void> {
	if (options.importMemoryPath !== undefined) {
		await runImport(options);
		return;
	}
	await runExport(options);
}
