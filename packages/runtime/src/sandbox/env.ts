/**
 * 沙箱共用的**执行环境收敛**与路径围栏（ADR-027 的 ①③ 与 windows-job 共用，避免两处各写一份）。
 *
 * ⚠️ 口径（不许美化）：这里做的是"**cwd 越界可读拒绝 + 环境白名单 + 显式打标**"，
 * 它**不是**隔离——真围栏在 `windows-job`（作业对象，ADR-031）；`off` 时一切恒等。
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { SandboxPrepareRequest, SandboxPrepareResult } from "./types.js";

/** best-effort / windows-job 下保留的环境变量白名单（**含路径 / 语言 / 临时目录**；**不含任何密钥类变量**）。 */
const ENV_ALLOWLIST: readonly string[] = [
	"PATH",
	"Path",
	"PATHEXT",
	"SystemRoot",
	"SystemDrive",
	"windir",
	"COMSPEC",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"TERM",
	"HOME",
	"SHELL",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PSModulePath",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"OS",
];

/** 让被执行的脚本自己知道"我是被哪种沙箱跑起来的"（诚实标注给子进程，ADR-027 ②）。 */
export const SANDBOX_MARKER_ENV = "CHENXI_SANDBOX";

export { ENV_ALLOWLIST };

/** 路径包容判定（与 `permission` 的 `isInsideRoot` 同一语义；此处不 import 以避免模块间反向依赖）。 */
export function isInside(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	if (rel === "") return true;
	if (isAbsolute(rel)) return false;
	return rel.split(/[\\/]/)[0] !== "..";
}

/**
 * 建立"收敛后的执行环境"（best-effort 与 windows-job 共用）：
 *  ① cwd 越出工作区 ⇒ **可读拒绝**，不执行；
 *  ② 环境收敛到白名单（**密钥类变量一律不传给子进程**）+ 显式打标。
 */
export function buildFencedEnv(
	request: SandboxPrepareRequest,
	marker: string,
): SandboxPrepareResult {
	const root = request.workspaceRoot ?? request.cwd;
	if (root !== "" && !isInside(root, request.cwd)) {
		return {
			env: {},
			refusal:
				`sandbox refused: cwd "${request.cwd}" is outside the workspace root "${root}". ` +
				"Do not retry this call; run inside the workspace instead.",
		};
	}
	const env: NodeJS.ProcessEnv = {};
	for (const key of ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(request.env ?? {})) env[key] = value;
	env[SANDBOX_MARKER_ENV] = marker;
	return { env };
}
