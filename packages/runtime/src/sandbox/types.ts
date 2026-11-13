/**
 * 沙箱契约（ADR-027 / ADR-031）。
 *
 * ⚠️ 先读这句，再看代码：**`off` 与 `best-effort` 都不是隔离**。`best-effort` 只做三件可实测的事：
 *  ① **进程树击杀**（超时/中止时杀整棵树，别留孤儿进程）；
 *  ② **执行环境收敛**（环境变量白名单 + cwd 越界可读拒绝）；
 *  ③ **数据根 ACL 围栏**（best-effort，只管"我们的数据"）。
 *
 * `windows-job`（ADR-031，**Windows-only**）是另一回事：它用 **Job Object** 拿到**内核强制**的
 * 整树击杀 + 进程数上限 + UI 限制——但**仍然不是文件/网络隔离**
 * （实测结论：非管理员下 token filtering `NOT_SUPPORTED`、AppContainer 需提权且写 C 盘 ⇒ 见 ADR-031）。
 * 边界在三处口径一致：`label` / CLI 横幅 / `capabilities.json`。
 */
export type SandboxMode = "off" | "best-effort" | "windows-job";

/** 取值域（CLI 校验与 ADR 一致，**新增值必须同步这里**）。 */
export const SANDBOX_MODES: readonly SandboxMode[] = ["off", "best-effort", "windows-job"];

export interface SandboxPrepareRequest {
	readonly command: string;
	readonly cwd: string;
	/** 工作区根（缺省 = `cwd`）；`cwd` **必须**在其内，否则拒绝执行。 */
	readonly workspaceRoot?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface SandboxPrepareResult {
	/** 交给 `spawn` 的环境变量（`off` ⇒ 与不启用时**逐字节相同**）。 */
	readonly env: NodeJS.ProcessEnv;
	/** 非空 ⇒ **不得执行**（把它当可读失败原因回给模型，而不是抛）。 */
	readonly refusal?: string;
}

export interface FenceResult {
	/** 是否已经"仅当前用户与系统账户可访问"（**只读体检结论**，不是"我们替你收紧了"）。 */
	readonly tight: boolean;
	/** 可读原因（无论结论都给，便于横幅与日志）。 */
	readonly reason: string;
	/**
	 * 想收紧的话该跑的命令（**复制粘贴执行**）——**我们显式不动手**：
	 * 实测 `icacls /inheritance:r` 会把调用者自己锁在门外（M12a 实现期的真实教训，见 ADR-027）。
	 */
	readonly hint: string;
}

export interface Sandbox {
	readonly mode: SandboxMode;
	/** 一句话说明（`best-effort` **必须**自带 `experimental` 与"非隔离"字样；`windows-job` 必须写清"不是文件/网络隔离"）。 */
	readonly label: string;
	/** 是否改写执行环境（`off` ⇒ 恒等，回归测试据此钉"默认行为不变"）。 */
	readonly altersExecution: boolean;
	prepare(request: SandboxPrepareRequest): SandboxPrepareResult;
	/** 超时 / 中止时的**进程树击杀**；返回是否至少发出一条有效的击杀命令。 */
	killTree(pid: number | undefined): boolean;
	/** 数据根权限**体检**（只读，绝不改 ACL）。 */
	auditDataRoot(root: string): FenceResult;
	/**
	 * **包装执行**（ADR-031，可选）：返回非空 ⇒ 命令不直接 spawn，而是交给一个包装进程
	 * （`windows-job` 就是靠它把内层命令放进 Job Object）。**抛错 = 拒绝执行**（调用方按可读失败处理）。
	 */
	readonly prepareLaunch?: (inner: SandboxInnerCommand) => SandboxLaunchPlan;
}

/** 内层命令（provider 本来要直接 spawn 的那个）。 */
export interface SandboxInnerCommand {
	readonly executable: string;
	/** 单条 `-Command` 文本；包装层必须**一字不改**地把它交给内层（windows-job 用 base64 走环境变量，避免 argv 转义）。 */
	readonly command: string;
	/** 内层命令的工作目录（包装进程不改它，只是把它交给内层）。 */
	readonly cwd: string;
}

/** 包装执行计划：用谁起、怎么起、额外塞哪些环境变量。 */
export interface SandboxLaunchPlan {
	readonly executable: string;
	readonly args: readonly string[];
	/** 与 `prepare()` 的 env **合并**后交给 spawn。 */
	readonly env: Readonly<Record<string, string>>;
}
