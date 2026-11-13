/**
 * sandbox 模块门面（ADR-027 / ADR-031）。
 *
 * 三个实现：`off`（**默认**，恒等，行为与不启用时逐字节相同）、`best-effort`（实验性、**非隔离**）、
 * `windows-job`（Windows-only，**内核强制**的资源/进程/UI 围栏，但**仍不是文件/网络隔离**）。
 * ⚠️ `off` / `best-effort` 的 `label` 必须自带 `experimental` 与"非隔离"字样；`windows-job` 必须写清"不是文件/网络隔离"。
 */
export * from "./audit.js";
export * from "./env.js";
export * from "./job-launcher-source.js";
export * from "./tree.js";
export * from "./types.js";
export * from "./windows-job.js";

import { auditDataRootAcl } from "./audit.js";
import { buildFencedEnv } from "./env.js";
import { killProcessTree } from "./tree.js";
import type {
	FenceResult,
	Sandbox,
	SandboxMode,
	SandboxPrepareRequest,
	SandboxPrepareResult,
} from "./types.js";
import { createWindowsJobSandbox, isWindowsJobAvailable } from "./windows-job.js";

const OFF_LABEL = "sandbox: off（默认；权限仍由 plan/build 的 allow/deny/ask 管）";
const BEST_EFFORT_LABEL =
	"sandbox: best-effort (experimental — 非隔离：只做进程树击杀 + 环境收敛 + 数据根 ACL，不限制工具能写哪里)";

/** `off`：一切恒等——**这是默认**，任何"默认行为变了"都是 bug。 */
export function createNullSandbox(): Sandbox {
	return {
		mode: "off",
		label: OFF_LABEL,
		altersExecution: false,
		prepare(request: SandboxPrepareRequest): SandboxPrepareResult {
			return { env: { ...process.env, ...(request.env ?? {}) } };
		},
		killTree(): boolean {
			return false;
		},
		auditDataRoot(): FenceResult {
			return {
				tight: false,
				reason: "未启用沙箱（默认 off），不做数据根体检",
				hint: "",
			};
		},
	};
}

/**
 * best-effort：三件可实测的事（ADR-027）。
 * 纪律：`refusal` 走**可读失败**（不抛）；击杀失败也**不改结果语义**（上层照常按超时/中止收尾）。
 */
export function createBestEffortSandbox(
	options: {
		readonly killTree?: (pid: number | undefined) => boolean;
		readonly auditDataRoot?: (root: string) => FenceResult;
	} = {},
): Sandbox {
	const doKill = options.killTree ?? killProcessTree;
	const doAudit = options.auditDataRoot ?? ((root: string) => auditDataRootAcl(root));
	return {
		mode: "best-effort",
		label: BEST_EFFORT_LABEL,
		altersExecution: true,
		prepare(request: SandboxPrepareRequest): SandboxPrepareResult {
			// ① cwd 越界 = **可读拒绝**，不执行；② 环境收敛到白名单 + 显式打标（与 windows-job 同一份实现）
			return buildFencedEnv(request, "best-effort");
		},
		killTree: (pid) => doKill(pid),
		auditDataRoot: (root) => doAudit(root),
	};
}

/** 解析模式（未知名 **快速失败**，绝不静默退回 off——那会让"以为开了"的人白开）。 */
export function resolveSandboxMode(value: string | undefined): SandboxMode | undefined {
	const normalized = (value ?? "off").trim().toLowerCase();
	if (normalized === "off") return "off";
	if (normalized === "best-effort" || normalized === "best_effort") return "best-effort";
	if (normalized === "windows-job" || normalized === "windows_job") return "windows-job";
	return undefined;
}

/** 模式非法 / 平台不可用时抛这个（调用方按可读失败 + 退出码 2 处理）。 */
export class SandboxModeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxModeError";
	}
}

/**
 * 按模式建沙箱。
 *  - 模式非法 ⇒ `undefined`（调用方报"取值域"错误）；
 *  - `windows-job` 但**不是 Windows** ⇒ 抛 `SandboxModeError`（**明确不可用**，绝不静默退回 off 或 best-effort）。
 */
export function createSandbox(
	mode: string | undefined,
	options: { readonly home?: string; readonly platform?: NodeJS.Platform } = {},
): Sandbox | undefined {
	const resolved = resolveSandboxMode(mode);
	if (resolved === undefined) return undefined;
	if (resolved === "windows-job") {
		if (!isWindowsJobAvailable(options.platform ?? process.platform)) {
			throw new SandboxModeError(
				"--sandbox windows-job 只在 Windows 可用（本平台没有对应的 Job Object 围栏）",
			);
		}
		return createWindowsJobSandbox(options.home === undefined ? {} : { home: options.home });
	}
	return resolved === "best-effort" ? createBestEffortSandbox() : createNullSandbox();
}
