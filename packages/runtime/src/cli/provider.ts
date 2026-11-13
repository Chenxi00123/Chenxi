/**
 * provider 解析（从 `main.ts` 拆出，见架构门禁的 400 行上限）。
 *
 * 优先级：
 *   1. `--replay <cassette>` —— **最高**：只回放，不读端点 / 不需要密钥 / 不发网络请求；
 *   2. `--stub` / `--demo-*` —— keyless 演示，回放固定脚本，不访问网络、不需密钥；
 *   3. `CHENXI_BASE_URL` / `CHENXI_API_KEY` / `CHENXI_MODEL` —— 真实 openai-compatible 端点
 *      （其中 `CHENXI_MODEL` 可由配置文件 `model` **兜底**，ADR-014）；
 *   4. 都不可用 —— 「仅记录」模式（不伪造 assistant 内容）。
 *
 * M19（ADR-037）：`--record` 把**已解析出来的** provider 包一层录制装饰器（stub / demo / 真实端点都可），
 * 因此 provider 选择逻辑与不录制时**完全一致**；`--replay` 与其它 provider 选择**互斥**。
 *
 * **任何路径都不得打印 key**。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { ToolCallId } from "@chenxi/schema";
import type { LoadedConfig } from "../config/index.js";
import { withModelFallback } from "../config/index.js";
import {
	type CassetteDocument,
	CassetteError,
	createCassetteHeader,
	createOpenAiCompatibleProvider,
	createRecordingProvider,
	createReplayProvider,
	createStubProvider,
	LlmConfigError,
	loadCassette,
	resolveLlmConfig,
	serializeCassetteExchange,
	serializeCassetteHeader,
} from "../llm/index.js";
import type { LlmProvider } from "../llm/types.js";
import type { CliOptions } from "./args.js";

/** 本次会话的 cassette 去向（bootstrap 用它打印可审计横幅）。 */
export interface CassetteSessionInfo {
	readonly mode: "record" | "replay";
	readonly path: string;
	/** 仅回放时有值：文件里一共多少条 exchange。 */
	readonly exchanges?: number;
}

export interface ResolvedProvider {
	readonly provider?: LlmProvider;
	readonly model?: string;
	readonly cassette?: CassetteSessionInfo;
}

/** 把演示文本切成小片，用于模拟流式输出（仅 keyless 桩演示）。 */
export function chunkText(text: string): string[] {
	const chunks = text.match(/.{1,6}/gs);
	return chunks === null ? [text] : chunks;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isEexist(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

/** `--replay` 与其它 provider 选择互斥的可读错误（先列出到底冲突了什么）。 */
function replayConflicts(options: CliOptions): string[] {
	const conflicts: string[] = [];
	if (options.record !== undefined) conflicts.push("--record");
	if (options.stub !== undefined) conflicts.push("--stub");
	if (options.demoRead !== undefined) conflicts.push("--demo-read");
	if (options.demoWrite !== undefined) conflicts.push("--demo-write");
	if (options.demoBash !== undefined) conflicts.push("--demo-bash");
	return conflicts;
}

/** `--replay`：读文件、严格解析、按 header.model 建回放 provider（全程无网络）。 */
function resolveReplayProvider(pathArg: string, options: CliOptions): ResolvedProvider {
	const conflicts = replayConflicts(options);
	if (conflicts.length > 0) {
		throw new Error(
			`--replay cannot be combined with ${conflicts.join(" / ")} ` +
				"(replay is offline: it needs no model endpoint and no scripted provider)",
		);
	}
	const path = resolvePath(pathArg);
	if (!existsSync(path)) throw new Error(`cassette file not found: ${path}`);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`cannot read cassette ${path}: ${errorMessage(error)}`);
	}
	let document: CassetteDocument;
	try {
		document = loadCassette(text);
	} catch (error) {
		if (error instanceof CassetteError) {
			throw new Error(`invalid cassette ${path}: ${error.message}`);
		}
		throw error;
	}
	return {
		provider: createReplayProvider(document),
		// 回放完全不需要端点：model 只用于请求哈希与展示，取自录制时的 header。
		model: document.header.model,
		cassette: { mode: "replay", path, exchanges: document.exchanges.length },
	};
}

/** `--record`：在建 provider 之后包一层录制装饰器；cassette 已存在则**拒绝覆盖**。 */
function withRecording(inner: ResolvedProvider, pathArg: string): ResolvedProvider {
	const { provider, model } = inner;
	if (provider === undefined || model === undefined) {
		throw new Error(
			"--record requires a model endpoint: set CHENXI_BASE_URL / CHENXI_API_KEY / CHENXI_MODEL, " +
				"or use --stub / --demo-read / --demo-write / --demo-bash",
		);
	}
	const path = resolvePath(pathArg);
	mkdirSync(dirname(path), { recursive: true });
	const header = createCassetteHeader({ providerId: provider.id, model });
	try {
		// `wx`：文件已存在即失败（录制是显式动作，绝不静默覆盖别人的 cassette）。
		writeFileSync(path, serializeCassetteHeader(header), { flag: "wx" });
	} catch (error) {
		if (isEexist(error)) {
			throw new Error(`cassette already exists: ${path} (refusing to overwrite)`);
		}
		throw new Error(`cannot create cassette ${path}: ${errorMessage(error)}`);
	}
	const recording = createRecordingProvider(provider, {
		onExchange: (exchange) => {
			appendFileSync(path, serializeCassetteExchange(exchange));
		},
	});
	return { provider: recording, model, cassette: { mode: "record", path } };
}

/** 既有的 provider 优先级（stub / demo / 真实端点 / 仅记录）——`--record` 复用这一份。 */
function resolveInnerProvider(options: CliOptions, loaded: LoadedConfig): ResolvedProvider {
	if (options.demoBash !== undefined) {
		// 脚本化一次 bash 调用（可配合 --ext-timeout 复现扩展缝，判据 #6）
		return {
			provider: createStubProvider([
				{
					content: "",
					toolCalls: [
						{
							callId: "demo_bash_call" as ToolCallId,
							toolName: "bash",
							input: { command: options.demoBash },
						},
					],
					stopReason: "tool_call" as const,
				},
				{ content: "Command finished.", stopReason: "end_turn" as const },
			]),
			model: "demo",
		};
	}
	if (options.demoWrite !== undefined) {
		// 脚本化「写文件」两轮：用于复现 plan 被拒 / build 通过（判据 #10）
		const writeCall = () => ({
			content: "",
			toolCalls: [
				{
					callId: "demo_write_call" as ToolCallId,
					toolName: "write",
					input: { path: options.demoWrite, content: "written by chenxi demo\n" },
				},
			],
			stopReason: "tool_call" as const,
		});
		return {
			provider: createStubProvider([
				writeCall(),
				{ content: "I could not write that file.", stopReason: "end_turn" as const },
				writeCall(),
				{ content: "Written.", stopReason: "end_turn" as const },
			]),
			model: "demo",
		};
	}
	if (options.demoRead !== undefined) {
		// keyless 脚本化闭环：step1 -> read(path)；step2 -> 总结（判据 #1 的终端轨迹）
		const script = [
			{
				content: "",
				toolCalls: [
					{
						callId: "demo_call_1" as ToolCallId,
						toolName: "read",
						input: { path: options.demoRead, offset: 0, limit: 5 },
					},
				],
				stopReason: "tool_call" as const,
			},
			{
				chunks: ["Read ", "the ", "first ", "5 ", "lines ", "of ", "the ", "file."],
				content: "Read the first 5 lines of the file.",
				stopReason: "end_turn" as const,
			},
		];
		return { provider: createStubProvider(script), model: "demo" };
	}
	if (options.stub !== undefined) {
		return {
			provider: createStubProvider({ content: options.stub, chunks: chunkText(options.stub) }),
			model: "stub",
		};
	}
	try {
		const providerConfig = resolveLlmConfig(withModelFallback(process.env, loaded));
		return {
			provider: createOpenAiCompatibleProvider(providerConfig),
			model: providerConfig.defaultModel,
		};
	} catch (error) {
		if (error instanceof LlmConfigError) return {};
		throw error;
	}
}

/**
 * 解析本次会话的 provider。
 *
 * 两个 flag 都缺省时与 M18 行为**逐字节相同**（`cassette` 字段为 `undefined`）。
 */
export function resolveProvider(options: CliOptions, loaded: LoadedConfig): ResolvedProvider {
	if (options.replay !== undefined) return resolveReplayProvider(options.replay, options);
	const inner = resolveInnerProvider(options, loaded);
	return options.record === undefined ? inner : withRecording(inner, options.record);
}
