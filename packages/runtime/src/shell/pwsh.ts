/**
 * PowerShell provider（ADR-009：Windows 默认后端）。
 *
 * 可执行文件选择：优先 PowerShell 7（`pwsh`），否则回退 Windows PowerShell 5.1（`powershell`）。
 * 命令作为 `-Command` 的**单个 argv 元素**传入（`shell: false`），不做字符串拼接，避免注入。
 * 检测到 Unix 惯用法时写入 `hints`（判据 #11）——**命令照常执行，不硬失败**。
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Sandbox } from "../sandbox/types.js";
import { detectUnixisms } from "./hints.js";
import type { ShellProvider, ShellRunRequest, ShellRunResult } from "./types.js";

/** 输出截断上限（字节）缺省值。 */
const DEFAULT_MAX_OUTPUT_BYTES = 262144;

/**
 * 子进程输出统一 **UTF-8**（M16）——`[Console]::OutputEncoding` 会连带把控制台输出代码页设成 65001，
 * 于是**原生命令**（git / npm / python…）与 cmdlet 的文本都以 UTF-8 写字节；
 * 不这么做的话 PowerShell 5.1 在**重定向** stdout 时按 OS OEM 代码页（本机 936）写字节 ⇒ 我们按 UTF-8 解码即乱码。
 * 用 try/catch 包住：无控制台时赋值会抛，但不该因此让命令失败。
 */
const UTF8_PROLOGUE =
	"try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }\n" +
	"$OutputEncoding = [System.Text.Encoding]::UTF8";

/** 给命令加上 UTF-8 前言（**两条路径共用同一份脚本文本**：直接 spawn 与 windows-job 包装都走它）。 */
function withUtf8Prologue(command: string): string {
	return `${UTF8_PROLOGUE}\n${command}`;
}

/** 把（可能多行的）脚本包成 `-EncodedCommand` 载荷：**UTF-16LE base64**，
 *  于是 argv 里只有一个不含空格/引号的 token ⇒ 零引号转义风险，且不受命令行长度/编码影响。 */
function encodeCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * 在 PATH 上解析可执行文件（Windows 语义：裸名按 `PATHEXT` 逐个补扩展名；吞掉一切异常）。
 *
 * 为什么不做"起一个进程试跑"的探测（2026-11-12 实测缺陷）：没装 pwsh 7 的原厂 Windows 只有
 * Windows PowerShell 5.1，冷启动一次 `powershell -NoProfile -Command "exit 0"` **实测 2089ms**，
 * 恰好越过原先 2s 的 `spawnSync` 超时 ⇒ `ETIMEDOUT` 被当成"不存在" ⇒ 整条链误报
 * "PowerShell 不可用"并静默回退 bash。按 PATH 查找是**同一套查找规则**的纯文件检查：
 * 毫秒级、不阻塞事件循环、不受机器冷启动与负载影响。
 */
function probeExecutable(executable: string): boolean {
	// 只解析裸名（带路径的写法不是本函数的使用场景）
	if (executable.includes("/") || executable.includes("\\")) return false;
	const dirs = (process.env.PATH ?? "")
		.split(delimiter)
		.map((rawDir) => rawDir.trim().replace(/^"|"$/g, ""))
		.filter((dir) => dir.length > 0);
	if (process.platform !== "win32") {
		// 类 Unix 没有 PATHEXT：裸名本身就是可执行文件（CI 的 ubuntu-latest 也走这条）
		for (const dir of dirs) {
			try {
				accessSync(join(dir, executable), constants.X_OK);
				return true;
			} catch {
				// 该目录下没有，继续找
			}
		}
		return false;
	}
	const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.filter((ext) => ext.length > 0);
	for (const dir of dirs) {
		for (const extension of extensions) {
			try {
				accessSync(join(dir, `${executable}${extension}`), constants.F_OK);
				return true;
			} catch {
				// 该目录下没有这个候选，继续找
			}
		}
	}
	return false;
}

/** 以 PowerShell 语义执行命令并归一化结果（内部实现，不导出）。 */
function execute(
	executable: string,
	request: ShellRunRequest,
	sandbox: Sandbox | undefined,
): Promise<ShellRunResult> {
	const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const hints = detectUnixisms(request.command);
	// ADR-027：沙箱（**默认 off** ⇒ 恒等）只做两件事——环境收敛 / cwd 越界可读拒绝
	const prepared = sandbox?.prepare({
		command: request.command,
		cwd: request.cwd,
		...(request.workspaceRoot === undefined ? {} : { workspaceRoot: request.workspaceRoot }),
		...(request.env === undefined ? {} : { env: request.env }),
	});
	if (prepared?.refusal !== undefined) {
		return Promise.resolve({
			providerId: "pwsh",
			stdout: "",
			stderr: prepared.refusal,
			exitCode: 126,
			timedOut: false,
			truncated: false,
			durationMs: 0,
			...(hints.length > 0 ? { hints } : {}),
		});
	}
	const env = prepared?.env ?? { ...process.env, ...(request.env ?? {}) };
	// M16：脚本文本 = UTF-8 前言 + 用户命令（用户命令**一字不改**地接在我们的前言之后）
	const script = withUtf8Prologue(request.command);
	// ADR-031：`windows-job` 走**包装执行**（把内层命令放进 Job Object）；其它沙箱/未启用 = 原样 spawn。
	// 包装计划拿不到（落盘失败等）⇒ **拒绝执行**（可读失败，绝不静默降级成"没围栏也跑"）。
	let launch:
		| { executable: string; args: readonly string[]; env: Readonly<Record<string, string>> }
		| undefined;
	try {
		launch = sandbox?.prepareLaunch?.({
			executable,
			command: script,
			cwd: request.cwd,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Promise.resolve({
			providerId: "pwsh",
			stdout: "",
			stderr: `sandbox refused: cannot establish the execution fence -> ${message}`,
			exitCode: 126,
			timedOut: false,
			truncated: false,
			durationMs: 0,
			...(hints.length > 0 ? { hints } : {}),
		});
	}
	return new Promise<ShellRunResult>((resolve) => {
		const startedAt = Date.now();
		const child = spawn(
			launch?.executable ?? executable,
			launch?.args ?? ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(script)],
			{
				cwd: request.cwd,
				shell: false,
				windowsHide: true,
				env: { ...env, ...(launch?.env ?? {}) },
			},
		);

		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;

		const kill = (): void => {
			// ADR-027：先杀**整棵进程树**（best-effort），**再无条件补一刀直接子进程**——
			// 双保险：`taskkill` 失败 / 只杀了一半时，这一刀保证至少不留下 pwsh 自己（空操作无害）。
			sandbox?.killTree(child.pid);
			try {
				child.kill();
			} catch {
				/* 进程可能已退出，忽略。 */
			}
		};

		const onAbort = (): void => {
			kill();
		};

		const timer =
			request.timeoutMs !== undefined && request.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						kill();
					}, request.timeoutMs)
				: undefined;

		const finish = (exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
			resolve({
				providerId: "pwsh",
				stdout,
				stderr,
				exitCode,
				timedOut,
				truncated,
				durationMs: Date.now() - startedAt,
				...(hints.length > 0 ? { hints } : {}),
			});
		};

		const collect = (chunk: Buffer, sink: "stdout" | "stderr"): void => {
			const used = sink === "stdout" ? stdoutBytes : stderrBytes;
			const remaining = maxOutputBytes - used;
			if (remaining <= 0) {
				truncated = true;
				return;
			}
			const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
			if (sink === "stdout") {
				stdout += slice.toString("utf8");
				stdoutBytes += slice.length;
			} else {
				stderr += slice.toString("utf8");
				stderrBytes += slice.length;
			}
			if (chunk.length > remaining) truncated = true;
		};

		child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));

		child.on("error", (error: Error) => {
			stderr += (stderr.length > 0 ? "\n" : "") + error.message;
			finish(null);
		});

		child.on("close", (code: number | null) => {
			finish(timedOut ? null : code);
		});

		if (request.signal !== undefined) {
			if (request.signal.aborted) kill();
			else request.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/** 创建 PowerShell provider（`sandbox` 缺省 = 不启用沙箱，行为与 M3 起逐字节相同）。 */
export function createPwshProvider(options: { readonly sandbox?: Sandbox } = {}): ShellProvider {
	const sandbox = options.sandbox;
	let cachedExecutable: string | null = null;

	const resolveExecutable = (): string | undefined => {
		if (cachedExecutable === null) {
			cachedExecutable = probeExecutable("pwsh")
				? "pwsh"
				: probeExecutable("powershell")
					? "powershell"
					: "";
		}
		return cachedExecutable === "" ? undefined : cachedExecutable;
	};

	return {
		id: "pwsh",
		isAvailable(): boolean {
			return resolveExecutable() !== undefined;
		},
		run(request: ShellRunRequest): Promise<ShellRunResult> {
			const executable = resolveExecutable();
			if (executable === undefined) {
				const hints = detectUnixisms(request.command);
				return Promise.resolve({
					providerId: "pwsh",
					stdout: "",
					stderr: "PowerShell 不可用（未找到 pwsh 或 powershell）",
					exitCode: null,
					timedOut: false,
					truncated: false,
					durationMs: 0,
					...(hints.length > 0 ? { hints } : {}),
				});
			}
			return execute(executable, request, sandbox);
		},
	};
}
