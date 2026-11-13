/**
 * `windows-job` 沙箱（ADR-031）：用 **Job Object** 拿到**内核强制**的围栏。
 *
 * 凭什么说"内核强制"（不是 best-effort）：围栏由 **OS** 执行，不是我们"尽量杀一下"：
 *  ① **`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**：作业句柄一关（含包装进程被杀），作业内**整棵树**由内核击杀
 *     —— 孙/曾孙进程**不可能**变孤儿（实测：包装进程被杀 500ms 内孙进程归零）；
 *  ② **`JOB_OBJECT_LIMIT_ACTIVE_PROCESS`**：超过上限的进程**入不了作业**（内核拒绝，实测 err=1816）。
 *  ③ **`JOB_OBJECT_UILIMIT_*`**：剪贴板读写 / 外窗句柄 / 全局原子 / 系统参数 / 显示设置一律被内核挡掉。
 *
 * ⚠️ **它不是文件/网络隔离**（实测证据见 ADR-031：非管理员下 token filtering `NOT_SUPPORTED`、
 * AppContainer 要提权且写 C 盘、Windows Sandbox 在 Home 版不存在）——**不许**按"真沙箱"理解。
 *
 * 载体：内盒 PowerShell 5.1 + `Add-Type`（P/Invoke），**零新依赖**；包装脚本与 DLL 缓存落在**数据根**
 * （`<home>/sandbox/`，本机即 D 盘），ps1 落盘带 UTF-8 BOM（PowerShell 5.1 无 BOM 会按 ANSI 读）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../persist/index.js";
import { auditDataRootAcl } from "./audit.js";
import { buildFencedEnv } from "./env.js";
import { JOB_LAUNCHER_PS1, JOB_WIN32_CS } from "./job-launcher-source.js";
import { killProcessTree } from "./tree.js";
import type {
	FenceResult,
	Sandbox,
	SandboxInnerCommand,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxPrepareResult,
} from "./types.js";

/** 进程数上限（含内层 pwsh 自己）；取够松的值，避免把正常构建（并行编译）误杀。 */
export const WINDOWS_JOB_PROCESS_LIMIT = 64;

/**
 * UI 限制掩码（**保守默认**）：剪贴板读写 + 外窗句柄 + 全局原子 + 系统参数 + 显示设置。
 * **刻意不含** `JOB_OBJECT_UILIMIT_DESKTOP`(0x40) 与 `EXITWINDOWS`(0x80)：它们会把"用得上桌面的正常工具链"
 * 一起挡掉，收益与破坏性不成比例。
 */
export const WINDOWS_JOB_UI_RESTRICTIONS = 0x3f;

/** 包装脚本与缓存所在目录名（挂在数据根下）。 */
const ASSET_DIR = "sandbox";

const WINDOWS_JOB_LABEL =
	"sandbox: windows-job（Windows-only；**内核强制**的围栏：关句柄即整树击杀 + 进程数上限 + UI 限制；" +
	"**不是**文件/网络隔离，也不限制工具能写哪里——写操作仍由 plan/build 的 allow/deny/ask 管）";

/** windows-job 只在 Windows 可用；`platform` 可注入以便测试（缺省 `process.platform`）。 */
export function isWindowsJobAvailable(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32";
}

/** 包装进程宿主：**内盒** Windows PowerShell 5.1（不依赖 pwsh 7；`Add-Type` 实测可用）。 */
function wrapperHost(): string {
	const root = process.env.SystemRoot ?? "C:\\Windows";
	return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

interface JobAssets {
	readonly dir: string;
	readonly scriptPath: string;
	readonly csPath: string;
}

/** 按内容比对写文件（内容相同则不重写；避免每次启动都碰盘）。 */
function writeIfChanged(path: string, content: string): void {
	let current: string | undefined;
	try {
		current = readFileSync(path, "utf8");
	} catch {
		current = undefined;
	}
	if (current === content) return;
	writeFileSync(path, content, "utf8");
}

/** 把包装脚本与 C# 源落到数据根（幂等）；ps1 **带 BOM**，C# 源**不带 BOM**（由 ps1 显式按 UTF-8 读）。 */
export function materializeJobAssets(home: string): JobAssets {
	const dir = join(home, ASSET_DIR);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const scriptPath = join(dir, "job-launcher.ps1");
	const csPath = join(dir, "job-launcher.cs");
	writeIfChanged(csPath, JOB_WIN32_CS);
	writeIfChanged(scriptPath, `\uFEFF${JOB_LAUNCHER_PS1}`);
	return { dir, scriptPath, csPath };
}

/** C# 源的内容指纹（同一份源码 ⇒ 同一个 DLL 缓存名；源码一变，旧 DLL 自然失效）。 */
export function jobSourceFingerprint(): string {
	return createHash("sha256").update(JOB_WIN32_CS, "utf8").digest("hex").slice(0, 16);
}

export interface WindowsJobOptions {
	readonly home?: string;
	readonly processLimit?: number;
	readonly uiRestrictions?: number;
	readonly killTree?: (pid: number | undefined) => boolean;
	readonly auditDataRoot?: (root: string) => FenceResult;
	/** 缺省 = 不额外改写（`materializeJobAssets` 直接落盘）。测试可注入以做**失败路径**。 */
	readonly materialize?: (home: string) => JobAssets;
}

/** 建 windows-job 沙箱（**只在 Windows 上可用**；不可用时由 `createSandbox` 报可读错误）。 */
export function createWindowsJobSandbox(options: WindowsJobOptions = {}): Sandbox {
	const home = options.home ?? resolveHome();
	const processLimit = options.processLimit ?? WINDOWS_JOB_PROCESS_LIMIT;
	const uiRestrictions = options.uiRestrictions ?? WINDOWS_JOB_UI_RESTRICTIONS;
	const doKill = options.killTree ?? killProcessTree;
	const doAudit = options.auditDataRoot ?? ((root: string) => auditDataRootAcl(root));
	const materialize = options.materialize ?? materializeJobAssets;

	return {
		mode: "windows-job",
		label: WINDOWS_JOB_LABEL,
		altersExecution: true,
		prepare(request: SandboxPrepareRequest): SandboxPrepareResult {
			// 与 best-effort 同源的两条（cwd 越界可读拒绝 + 环境白名单），另加**打标**供子进程自认
			return buildFencedEnv(request, "windows-job");
		},
		killTree: (pid) => doKill(pid),
		auditDataRoot: (root) => doAudit(root),
		prepareLaunch(inner: SandboxInnerCommand): SandboxLaunchPlan {
			// 落盘失败 / 取不到宿主 ⇒ **抛**（调用方按"拒绝执行"处理，绝不静默降级成没围栏也跑）
			const assets = materialize(home);
			return {
				executable: wrapperHost(),
				args: [
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					assets.scriptPath,
					"-DllDir",
					assets.dir,
					"-CsSourcePath",
					assets.csPath,
					"-ProcessLimit",
					String(processLimit),
					"-UiFlags",
					String(uiRestrictions),
					"-InnerExe",
					inner.executable,
				],
				env: {
					// 命令文本一字不改地经 base64 传给包装层（避免 argv 引号转义）
					CHENXI_JOB_INNER_B64: Buffer.from(inner.command, "utf8").toString("base64"),
				},
			};
		},
	};
}
