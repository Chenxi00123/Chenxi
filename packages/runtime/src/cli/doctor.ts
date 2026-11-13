/**
 * `chenxi --doctor`：环境自检（M6；M7a 起增加配置文件状态检查）。
 *
 * 设计约束：
 *   - 只做**只读探测** + **一次可写探针**（写入后立即删除），不修改任何用户数据；
 *   - **绝不打印任何密钥值**：端点相关变量只报告 `set` / `unset`；
 *   - 以**退出码**汇报：关键项（critical）全通过 -> 0，否则 -> 1。
 *
 * 可注入 `env` / `cwd` / `nodeVersion` / `platform` 以便单测（默认读当前进程）。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EnvLike, loadConfig } from "../config/index.js";
import { indexPath, JSONL_EXT, resolveHome, sessionsDir } from "../persist/paths.js";
import { selectShellProvider } from "../shell/index.js";

export interface DoctorOutput {
	write(text: string): void;
}

export interface DoctorOptions {
	readonly home?: string;
	/** 配置文件发现用的工作目录（默认 `process.cwd()`）。 */
	readonly cwd?: string;
	readonly output: DoctorOutput;
	/** 端点变量来源（默认 `process.env`）。 */
	readonly env?: NodeJS.ProcessEnv;
	/** Node 版本（默认 `process.versions.node`）。 */
	readonly nodeVersion?: string;
	/** 平台（默认 `process.platform`）。 */
	readonly platform?: NodeJS.Platform;
}

/** 本工具要求的最低 Node 版本（`node:sqlite` 稳定性所需）。 */
export const MIN_NODE: readonly [number, number] = [22, 19];

/** 端点三变量（缺失时进入「仅记录」模式，非阻塞）。 */
const ENDPOINT_VARS = ["CHENXI_BASE_URL", "CHENXI_API_KEY", "CHENXI_MODEL"] as const;

interface CheckResult {
	readonly name: string;
	readonly ok: boolean;
	/** 关键项：为 false 时不影响退出码，仅作为建议提示。 */
	readonly critical: boolean;
	readonly detail: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 版本比较：`major > min.major`，或同 major 下 `minor >= min.minor`。 */
function meetsNodeVersion(version: string, min: readonly [number, number]): boolean {
	const [majorRaw = "", minorRaw = ""] = version.replace(/^v/, "").split(".");
	const major = Number(majorRaw);
	const minor = Number(minorRaw);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
	if (major !== min[0]) return major > min[0];
	return minor >= min[1];
}

function checkNode(version: string): CheckResult {
	const ok = meetsNodeVersion(version, MIN_NODE);
	return {
		name: "node",
		ok,
		critical: true,
		detail: `v${version} (>= ${MIN_NODE[0]}.${MIN_NODE[1]} required)`,
	};
}

function checkShell(platform: NodeJS.Platform): CheckResult {
	const provider = selectShellProvider({ platform });
	const available = provider.isAvailable();
	return {
		name: "shell",
		ok: available,
		critical: true,
		detail: `provider=${provider.id} available=${available ? "yes" : "no"}`,
	};
}

/** `node:sqlite` 可用性探测（首次加载会有 Node 的 ExperimentalWarning，属预期）。 */
async function checkSqlite(): Promise<CheckResult> {
	try {
		await import("node:sqlite");
		return {
			name: "node:sqlite",
			ok: true,
			critical: true,
			detail: "available (experimental feature; a startup warning is expected)",
		};
	} catch (error) {
		return { name: "node:sqlite", ok: false, critical: true, detail: errorMessage(error) };
	}
}

/** 数据根目录可写性：创建目录 -> 写探针 -> 删除探针。 */
function checkHomeWritable(home: string): CheckResult {
	const name = "home-writable";
	try {
		mkdirSync(home, { recursive: true });
		const probe = join(home, `.doctor-probe-${process.pid}`);
		writeFileSync(probe, "ok", "utf8");
		rmSync(probe, { force: true });
		return { name, ok: true, critical: true, detail: `${home} (probe write + delete ok)` };
	} catch (error) {
		return { name, ok: false, critical: true, detail: `${home}: ${errorMessage(error)}` };
	}
}

/** UTF-8 中文输出可用性：编解码往返 + 非 ASCII 字节长度校验。 */
function checkUtf8(): CheckResult {
	const sample = "中文 UTF-8 ✓";
	const ok =
		Buffer.from(sample, "utf8").toString("utf8") === sample &&
		Buffer.byteLength(sample, "utf8") > sample.length;
	return {
		name: "utf8",
		ok,
		critical: true,
		detail: ok ? "encoding round-trip ok" : "encoding round-trip mismatch",
	};
}

/** 端点变量：只报告 set/unset，**绝不打印取值**。 */
function checkEndpoints(env: NodeJS.ProcessEnv): CheckResult {
	const status = ENDPOINT_VARS.map((key) => {
		const value = env[key];
		return `${key}=${value !== undefined && value.trim() !== "" ? "set" : "unset"}`;
	});
	const set = status.filter((line) => line.endsWith("=set")).length;
	return {
		name: "endpoints",
		ok: set === ENDPOINT_VARS.length,
		critical: false,
		detail: set === 0 ? `all unset (recording-only mode) — ${status.join(" ")}` : status.join(" "),
	};
}

/**
 * 配置文件状态（ADR-014）：读入并校验实际生效的配置文件。
 * 配置**非法**是关键项失败——启动器会因此快速失败，属于必须修的问题。
 */
function checkConfig(home: string, cwd: string, env: EnvLike): CheckResult {
	try {
		const loaded = loadConfig({ home, cwd, env });
		// 只报告**声明**，不 spawn（自检不做有副作用的动作）
		const mcp =
			loaded.mcpServers === undefined
				? ""
				: `; mcp servers: ${loaded.mcpServers.map((server) => server.name).join(", ")}`;
		const memory =
			loaded.memory === undefined
				? ""
				: `; memory: ${loaded.memory.server}/${loaded.memory.searchTool}`;
		const subagents =
			loaded.subagents === undefined
				? ""
				: `; subagents: ${loaded.subagents.enabled ? `enabled (maxDepth=${loaded.subagents.maxDepth ?? 2})` : "declared but disabled"}`;
		const sources =
			loaded.sources.length === 0 ? "none found (built-in defaults)" : loaded.sources.join(", ");
		return {
			name: "config",
			ok: true,
			critical: false,
			detail: `${sources}${mcp}${memory}${subagents}`,
		};
	} catch (error) {
		return { name: "config", ok: false, critical: true, detail: errorMessage(error) };
	}
}

/**
 * 存储状态：会话数按 `sessions/*.jsonl` 计数；索引文件仅报告存在性
 * （索引缺失属正常 —— 会在下次启动时自动重建）。
 */
function checkStorage(home: string): CheckResult {
	const dir = sessionsDir(home);
	let sessions = 0;
	let indexPresent = false;
	try {
		sessions = readdirSync(dir).filter((entry) => entry.endsWith(JSONL_EXT)).length;
		indexPresent = existsSync(indexPath(home));
	} catch {
		// sessions 目录尚不存在：视为 0 会话
	}
	return {
		name: "storage",
		ok: true,
		critical: false,
		detail: `sessions=${sessions} index=${indexPresent ? "present" : "absent (auto-rebuilt)"}`,
	};
}

/** 跑一遍环境自检，打印报告，返回退出码（0=关键项全通过，1=有阻塞项）。 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const nodeVersion = options.nodeVersion ?? process.versions.node;
	const home = resolveHome(options.home);
	const cwd = options.cwd ?? process.cwd();

	const results: CheckResult[] = [
		checkNode(nodeVersion),
		checkShell(platform),
		await checkSqlite(),
		checkHomeWritable(home),
		checkUtf8(),
		checkEndpoints(env),
		checkConfig(home, cwd, env),
		checkStorage(home),
	];

	options.output.write("chenxi doctor — environment self-check\n");
	options.output.write(`node v${nodeVersion} | platform ${platform} | home ${home}\n\n`);
	for (const result of results) {
		const mark = result.ok ? "✔" : "✖";
		const tag = result.critical ? "" : " (optional)";
		options.output.write(`  ${mark} ${result.name}${tag}: ${result.detail}\n`);
	}

	const blocking = results.filter((result) => result.critical && !result.ok);
	options.output.write(
		blocking.length === 0
			? "\nOK: all critical checks passed.\n"
			: `\nFAILED: ${blocking.length} critical check(s) need attention: ` +
					`${blocking.map((result) => result.name).join(", ")}\n`,
	);
	return blocking.length === 0 ? 0 : 1;
}
