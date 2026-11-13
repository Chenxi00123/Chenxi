/**
 * shell provider 抽象（**ADR-009：首发支持 Windows**）。
 *
 * `bash` 工具**不绑定 bash**，而是通过本接口选择后端：类 Unix 用 `bash`，Windows 用 `pwsh`。
 * 两个实现**接口一致**：`{command, timeout}` -> 流式 stdout/stderr + 退出码 + 可读提示。
 *
 * 这样 4 原语工具的核心语义不被平台差异污染（ADR-009 的后果栏）。
 */
export type ShellProviderId = "bash" | "pwsh";

export interface ShellRunRequest {
	readonly command: string;
	/** 工作目录（必须是绝对路径；由调用方保证在 workspace 内）。 */
	readonly cwd: string;
	/** 工作区根（ADR-027：启用沙箱时用它判定 `cwd` 是否越界；缺省 = `cwd`）。 */
	readonly workspaceRoot?: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly env?: Readonly<Record<string, string>>;
	/** 输出截断上限（字节）；超限截断并置 `truncated=true`。 */
	readonly maxOutputBytes?: number;
}

export interface ShellRunResult {
	readonly providerId: ShellProviderId;
	readonly stdout: string;
	readonly stderr: string;
	/** 被超时/信号终止时为 `null`。 */
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly truncated: boolean;
	readonly durationMs: number;
	/**
	 * 平台相关的**可读提示**（判据 #11）：
	 * 例如在 Windows/pwsh 下检测到 Unix 惯用法（`ls`/`rg`/`cat` 等）时，
	 * 给出等价 PowerShell 写法，**而非硬失败**。
	 */
	readonly hints?: readonly string[];
}

export interface ShellProvider {
	readonly id: ShellProviderId;
	/** 后端在当前环境是否可用（例如 Windows 上通常没有 bash）。 */
	isAvailable(): boolean;
	run(request: ShellRunRequest): Promise<ShellRunResult>;
}
