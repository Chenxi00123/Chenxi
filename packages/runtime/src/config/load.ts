/**
 * 配置文件加载（ADR-014）：发现 -> 解析 -> **严格**校验 -> 逐键合并。
 *
 * 本模块**只负责「配置文件」这一层**，产出 `LoadedConfig`；env / CLI 的覆盖由调用方合并
 * （见 `resolveDefaultMode`）。完整优先级：**CLI 参数 > 环境变量 > 配置文件 > 内置默认**。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMode } from "@aster/schema";
import { DEFAULT_AGENT_MODE } from "@aster/schema";
import type { ZodError } from "zod";
import type { PermissionRule } from "../permission/types.js";
import { resolveHome } from "../persist/paths.js";
import {
	type ConfigContext,
	type ConfigFileData,
	configFileSchema,
	type McpServerDeclaration,
	type MemoryDeclaration,
	type SubagentsDeclaration,
} from "./schema.js";

/** 用户级配置文件名（位于 `<home>/`）。 */
export const USER_CONFIG_FILE = "config.json";
/** 项目级配置文件名（位于 `<cwd>/`）。 */
export const PROJECT_CONFIG_FILE = "aster.config.json";
/** 显式指定配置文件的变量名（设置后跳过自动发现）。 */
export const CONFIG_PATH_VAR = "ASTER_CONFIG";
/** 默认启动模式的环境变量（优先级低于 `--mode`）。 */
export const MODE_VAR = "ASTER_MODE";

/** 与 `process.env` 形状兼容的最小环境变量视图。 */
export interface EnvLike {
	readonly [key: string]: string | undefined;
}

/**
 * 配置错误。`source` 为**出错来源标签**（文件路径，或 `env ASTER_MODE` 这类变量），
 * 消息**只含来源与键路径**，绝不回显任何取值（对齐 `llm/config` 的密钥纪律）。
 */
export class ConfigError extends Error {
	readonly source: string;
	constructor(source: string, message: string) {
		super(`config error [${source}]: ${message}`);
		this.name = "ConfigError";
		this.source = source;
	}
}

export interface LoadedConfig {
	/** 默认启动模式（可被 `--mode` / `ASTER_MODE` 覆盖）。 */
	readonly mode?: AgentMode;
	/** 模型 id **兜底**（仅当 `ASTER_MODEL` 未设置时生效）。 */
	readonly model?: string;
	/** 按模式整段替换后的规则（**未提供**的模式不含键 -> 调用方回退内置默认）。 */
	readonly permissions?: Partial<Record<AgentMode, readonly PermissionRule[]>>;
	/** MCP 服务器声明（ADR-015）；未声明或为空数组时**不含键**。 */
	readonly mcpServers?: readonly McpServerDeclaration[];
	/** 记忆外挂声明（ADR-016）；未声明时**不含键**。 */
	readonly memory?: MemoryDeclaration;
	/** 子代理声明（ADR-017）；未声明时**不含键**（= 不注册 `task` 工具）。 */
	readonly subagents?: SubagentsDeclaration;
	/** 上下文压缩（M23，ADR-041）；未声明或缺省 `enabled` 时**不含键**（= 不压缩）。 */
	readonly context?: ConfigContext;
	/** 实际读入的配置文件路径（按优先级从低到高）；空数组 = 未发现任何配置文件。 */
	readonly sources: readonly string[];
}

function readVar(env: EnvLike, key: string): string | undefined {
	const raw = env[key];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 把 zod 校验错误压成**可读单行**。
 * 有键路径的带路径前缀；无路径的（如「未知键」这类根级问题）直接用它自己的消息
 * —— zod 的消息里已含键名，因此用户仍能看到**是哪个键**出的问题。
 */
function formatIssues(error: ZodError): string {
	return error.issues
		.map((issue) => {
			const where = issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
			return `${where}${issue.message}`;
		})
		.join("; ");
}

/** 读取 + 解析 + 严格校验单个配置文件。任何问题都以 `ConfigError` 快速失败。 */
function parseConfigFile(path: string): ConfigFileData {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigError(path, `cannot read file: ${errorMessage(error)}`);
	}
	let json: unknown;
	try {
		// 顺带修复（M11 批次声明）：Windows 记事本 / PowerShell `Set-Content -Encoding utf8` 会写
		// UTF-8 **BOM**，而那仍然是合法 UTF-8 文件。原先直接 `JSON.parse` 会把它判成"非法 JSON"，
		// 让用户以为配置写错了。这里只剥**首个** U+FEFF，正文一字不改。
		json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
	} catch (error) {
		throw new ConfigError(path, `not valid JSON: ${errorMessage(error)}`);
	}
	const parsed = configFileSchema.safeParse(json);
	if (!parsed.success) throw new ConfigError(path, formatIssues(parsed.error));
	return parsed.data;
}

/** `permissions` 的合并：按模式**整段替换**（不是深合并数组）。 */
function mergePermissions(
	base: ConfigFileData["permissions"],
	over: ConfigFileData["permissions"],
): ConfigFileData["permissions"] {
	if (base === undefined) return over;
	if (over === undefined) return base;
	const plan = over.plan ?? base.plan;
	const build = over.build ?? base.build;
	return {
		...(plan === undefined ? {} : { plan }),
		...(build === undefined ? {} : { build }),
	};
}

/** 逐键合并：`over` 中**出现**的键覆盖 `base`。 */
function mergeConfig(base: ConfigFileData, over: ConfigFileData): ConfigFileData {
	const mode = over.mode ?? base.mode;
	const model = over.model ?? base.model;
	const permissions = mergePermissions(base.permissions, over.permissions);
	// `mcp` / `memory` / `subagents` 整段替换（语义与 permissions 一致）
	const mcp = over.mcp ?? base.mcp;
	const memory = over.memory ?? base.memory;
	const subagents = over.subagents ?? base.subagents;
	return {
		...(mode === undefined ? {} : { mode }),
		...(model === undefined ? {} : { model }),
		...(permissions === undefined ? {} : { permissions }),
		...(mcp === undefined ? {} : { mcp }),
		...(memory === undefined ? {} : { memory }),
		...(subagents === undefined ? {} : { subagents }),
	};
}

/**
 * 跨字段校验：`memory.server` **必须**指向已声明的 `mcp.servers` 之名。
 * 在**合并之后**校验（`memory` 可能来自用户级配置，而 `server` 声明在项目级配置里）。
 */
function assertMemoryServerDeclared(merged: ConfigFileData | undefined): void {
	const memory = merged?.memory;
	if (memory === undefined) return;
	const declared = (merged?.mcp?.servers ?? []).map((server) => server.name);
	if (declared.includes(memory.server)) return;
	throw new ConfigError(
		"memory.server",
		`must reference a declared mcp.servers name; declared: ${
			declared.length === 0 ? "(none)" : declared.join(", ")
		}`,
	);
}

/**
 * 跨字段校验：写入路径（ADR-033）——`write.enabled: true` 必须同时给出 `addTool`。
 * 不校验的话会得到"开了写入但永远写不进去"的静默失效（比报错更难查）。
 */
function assertMemoryWriteConfig(merged: ConfigFileData | undefined): void {
	const write = merged?.memory?.write;
	if (write === undefined || write.enabled !== true) return;
	if (write.addTool !== undefined && write.addTool.trim() !== "") return;
	throw new ConfigError(
		"memory.write.addTool",
		"is required when memory.write.enabled is true (name of the memory server's add tool)",
	);
}

/** 跨字段校验：`mcp.servers[].name` 必须唯一（否则命名空间会互相覆盖/歧义）。 */
function assertUniqueServerNames(source: string, servers: ConfigFileData["mcp"]): void {
	if (servers?.servers === undefined) return;
	const seen = new Set<string>();
	for (const [index, server] of servers.servers.entries()) {
		if (seen.has(server.name)) {
			throw new ConfigError(
				source,
				`mcp.servers.${index}.name: duplicate MCP server name "${server.name}"`,
			);
		}
		seen.add(server.name);
	}
}

/**
 * 发现配置文件（返回顺序 = **优先级从低到高**）。
 * 优先级：`explicitPath`（CLI `--config`）> `ASTER_CONFIG` > 自动发现 `<home>/config.json` -> `<cwd>/aster.config.json`。
 */
export function discoverConfigPaths(options: {
	home: string;
	cwd: string;
	env: EnvLike;
	explicitPath?: string;
}): string[] {
	if (options.explicitPath !== undefined) return [resolve(options.cwd, options.explicitPath)];
	const fromEnv = readVar(options.env, CONFIG_PATH_VAR);
	if (fromEnv !== undefined) return [resolve(options.cwd, fromEnv)];
	return [join(options.home, USER_CONFIG_FILE), join(options.cwd, PROJECT_CONFIG_FILE)].filter(
		(path) => existsSync(path),
	);
}

export interface LoadConfigOptions {
	readonly home?: string;
	readonly cwd?: string;
	readonly env?: EnvLike;
	/** CLI `--config`：显式指定唯一配置文件（最高优先级）。 */
	readonly explicitPath?: string;
}

/** 加载并合并配置文件。**不抛错以外的副作用**：不创建任何目录、不写文件。 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
	const env = options.env ?? process.env;
	const home = resolveHome(options.home);
	const cwd = options.cwd ?? process.cwd();
	const paths = discoverConfigPaths({
		home,
		cwd,
		env,
		...(options.explicitPath === undefined ? {} : { explicitPath: options.explicitPath }),
	});

	let merged: ConfigFileData | undefined;
	for (const path of paths) {
		const parsed = parseConfigFile(path);
		assertUniqueServerNames(path, parsed.mcp);
		merged = merged === undefined ? parsed : mergeConfig(merged, parsed);
	}

	assertMemoryServerDeclared(merged);
	assertMemoryWriteConfig(merged);

	const servers = merged?.mcp?.servers;
	return {
		...(merged?.mode === undefined ? {} : { mode: merged.mode }),
		...(merged?.model === undefined ? {} : { model: merged.model }),
		...(merged?.permissions === undefined ? {} : { permissions: merged.permissions }),
		...(servers === undefined || servers.length === 0 ? {} : { mcpServers: servers }),
		...(merged?.memory === undefined ? {} : { memory: merged.memory }),
		...(merged?.subagents === undefined ? {} : { subagents: merged.subagents }),
		...(merged?.context === undefined ? {} : { context: merged.context }),
		sources: paths,
	};
}

/**
 * 解析**默认启动模式**：`--mode`（CLI）> `ASTER_MODE`（env）> 配置文件 > 内置默认（`plan`）。
 */
export function resolveDefaultMode(options: {
	cliMode?: AgentMode;
	env?: EnvLike;
	config: LoadedConfig;
}): AgentMode {
	if (options.cliMode !== undefined) return options.cliMode;
	const raw = readVar(options.env ?? process.env, MODE_VAR);
	if (raw !== undefined) {
		if (raw === "plan" || raw === "build") return raw;
		throw new ConfigError(`env ${MODE_VAR}`, "must be one of: plan, build");
	}
	return options.config.mode ?? DEFAULT_AGENT_MODE;
}

/**
 * 把 `config.model` 作为 `ASTER_MODEL` 的**兜底**（只补缺，绝不覆盖已设置的值）。
 * 返回新对象，不改动入参。
 */
export function withModelFallback(env: EnvLike, config: LoadedConfig): EnvLike {
	if (config.model === undefined || readVar(env, "ASTER_MODEL") !== undefined) return env;
	return { ...env, ASTER_MODEL: config.model };
}
