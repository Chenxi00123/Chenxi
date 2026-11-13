/**
 * CLI 的可移植命令（ADR-019）：`--export` / `--import`。
 *
 * 只负责 **IO 与打印**：格式逻辑在 `portable`，写入路径在 `persist`。
 * 两条纪律：
 *  - 厂商路径**必须把有损项打印出来**（不许把"能读"说成"能互通"）；
 *  - 导入**永不进 REPL**：打印新 `sessionId` 并退出，用户再自行 `--resume`。
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { AgentMode, PortableFormat, SessionId } from "@chenxi/schema";
import { EXCHANGE_FORMAT, EXCHANGE_FORMAT_VERSION } from "@chenxi/schema";
import type { SessionStore } from "../persist/index.js";
import { createSessionStore } from "../persist/index.js";
import type { PortableTurn } from "../portable/index.js";
import {
	buildExchangeDocument,
	CHENXI_PRODUCER,
	exportClaudeCodeJsonl,
	exportZCodeSession,
	importClaudeCodeJsonl,
	importExchangeDocument,
	importTurns,
	importZCodeSession,
	parseExchangeJson,
	readSessionForExport,
	resolveLatestSession,
} from "../portable/index.js";
import type { Output } from "./repl.js";

/** 有损清单（ADR-019）：厂商侧**没有**这些事实的对应物。 */
const LOSSY_NOTE =
	"tool calls + tool results, approvals, mode changes, turn boundaries, memory injections " +
	"and subagent events are NOT carried over (see ADR-019)";

export interface PortableCliOptions {
	readonly home?: string;
	/** `--export <sessionId|latest>`。 */
	readonly exportTarget?: string;
	/** `--import <path>`。 */
	readonly importPath?: string;
	/** `--format chenxi|claude-code|zcode`（缺省 `chenxi`）。 */
	readonly format?: PortableFormat;
	/** `--export` 的输出路径（必填）。 */
	readonly out?: string;
	readonly output: Output;
}

async function runExport(
	options: PortableCliOptions,
	store: SessionStore,
	format: PortableFormat,
): Promise<void> {
	const out = options.out;
	if (out === undefined) throw new Error("--export requires --out <path>");
	const target = options.exportTarget as string;
	const sessionId =
		target === "latest" ? resolveLatestSession(await store.list()) : (target as SessionId);

	const exported = await readSessionForExport({ store, sessionId, producer: CHENXI_PRODUCER });
	const cwd = exported.meta.cwd === "" ? process.cwd() : exported.meta.cwd;

	if (format === "chenxi") {
		const document = buildExchangeDocument({
			session: { ...exported.meta, cwd },
			events: exported.events,
			producer: exported.producer,
		});
		writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
		options.output.write(
			`exported ${exported.events.length} event(s) as ${EXCHANGE_FORMAT} ` +
				`v${EXCHANGE_FORMAT_VERSION} (lossless for Chenxi) -> ${out}\n`,
		);
		return;
	}

	const text =
		format === "claude-code"
			? exportClaudeCodeJsonl({ cwd, turns: exported.turns })
			: exportZCodeSession({
					sessionId,
					cwd,
					mode: exported.meta.mode,
					...(exported.meta.model === undefined ? {} : { model: exported.meta.model }),
					createdAt: exported.meta.createdAt,
					updatedAt: exported.meta.updatedAt,
					turns: exported.turns,
				});
	writeFileSync(out, text, "utf8");
	options.output.write(`exported ${exported.turns.length} turn(s) as ${format} -> ${out}\n`);
	options.output.write(`note: ${format} is a best-effort adapter — ${LOSSY_NOTE}\n`);
}

interface ImportedSource {
	readonly turns: readonly PortableTurn[];
	readonly cwd?: string;
	/** Claude Code 侧没有我们的模式概念：缺省 `plan`（最安全：写操作一律拒）。 */
	readonly mode: AgentMode;
	readonly model?: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
}

function readVendorSource(format: Exclude<PortableFormat, "chenxi">, text: string): ImportedSource {
	if (format === "claude-code") {
		const parsed = importClaudeCodeJsonl(text);
		return {
			turns: parsed.turns,
			...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
			mode: "plan",
			...(parsed.model === undefined ? {} : { model: parsed.model }),
			...(parsed.createdAt === undefined ? {} : { createdAt: parsed.createdAt }),
			...(parsed.updatedAt === undefined ? {} : { updatedAt: parsed.updatedAt }),
		};
	}
	const parsed = importZCodeSession(text);
	return {
		turns: parsed.turns,
		...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
		mode: parsed.mode ?? "plan",
		...(parsed.model === undefined ? {} : { model: parsed.model }),
		...(parsed.createdAt === undefined ? {} : { createdAt: parsed.createdAt }),
		...(parsed.updatedAt === undefined ? {} : { updatedAt: parsed.updatedAt }),
	};
}

async function runImport(
	options: PortableCliOptions,
	store: SessionStore,
	format: PortableFormat,
): Promise<void> {
	const path = options.importPath as string;
	const text = readFileSync(path, "utf8");

	if (format === "chenxi") {
		const document = parseExchangeJson(text);
		const result = await importExchangeDocument({
			store,
			events: document.events,
			session: document.session,
		});
		options.output.write(
			`imported ${result.eventCount} event(s) from ${EXCHANGE_FORMAT} v${document.formatVersion} ` +
				`(produced by ${document.producer.name} ${document.producer.version}) ` +
				`into session ${result.sessionId}\n`,
		);
		options.output.write(`resume with: chenxi --resume ${result.sessionId}\n`);
		return;
	}

	const source = readVendorSource(format, text);
	const result = await importTurns({
		store,
		turns: source.turns,
		cwd: source.cwd ?? process.cwd(),
		mode: source.mode,
		...(source.model === undefined ? {} : { model: source.model }),
		...(source.createdAt === undefined ? {} : { createdAt: source.createdAt }),
		...(source.updatedAt === undefined ? {} : { updatedAt: source.updatedAt }),
	});
	options.output.write(
		`imported ${source.turns.length} turn(s) from ${format} into session ${result.sessionId}\n`,
	);
	options.output.write(`note: ${format} is a best-effort adapter — ${LOSSY_NOTE}\n`);
	options.output.write(`resume with: chenxi --resume ${result.sessionId}\n`);
}

/** 执行 `--export` / `--import`（两者都**不进 REPL**：打印结果并退出）。 */
export async function runPortableCommand(options: PortableCliOptions): Promise<void> {
	const store = createSessionStore(options.home === undefined ? {} : { home: options.home });
	const format = options.format ?? "chenxi";
	try {
		if (options.importPath !== undefined) {
			await runImport(options, store, format);
			return;
		}
		await runExport(options, store, format);
	} finally {
		await store.dispose();
	}
}
