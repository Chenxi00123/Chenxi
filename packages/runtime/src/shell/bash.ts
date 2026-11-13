/**
 * Bash provider：以 `bash -lc <command>` 执行（ADR-009：类 Unix 默认后端）。
 *
 * 关键纪律：
 * - 用 `spawn` + `shell: false` 执行，命令作为 argv 的**单个元素**传入，避免注入；
 * - Windows 上通常没有 bash，`isAvailable()` 探测失败时**吞掉异常返回 false**。
 */
import { spawn, spawnSync } from "node:child_process";
import type { Sandbox } from "../sandbox/types.js";
import type { ShellProvider, ShellRunRequest, ShellRunResult } from "./types.js";

/** 输出截断上限（字节）缺省值。 */
const DEFAULT_MAX_OUTPUT_BYTES = 262144;

/** 以 `bash -lc` 语义执行命令并归一化结果（内部实现，不导出以避免污染公共 API）。 */
function execute(request: ShellRunRequest, sandbox: Sandbox | undefined): Promise<ShellRunResult> {
	const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	// ADR-027：沙箱（**默认 off** ⇒ 恒等）只做两件事——环境收敛 / cwd 越界可读拒绝
	const prepared = sandbox?.prepare({
		command: request.command,
		cwd: request.cwd,
		...(request.workspaceRoot === undefined ? {} : { workspaceRoot: request.workspaceRoot }),
		...(request.env === undefined ? {} : { env: request.env }),
	});
	if (prepared?.refusal !== undefined) {
		return Promise.resolve({
			providerId: "bash",
			stdout: "",
			stderr: prepared.refusal,
			exitCode: 126,
			timedOut: false,
			truncated: false,
			durationMs: 0,
		});
	}
	const env = prepared?.env ?? { ...process.env, ...(request.env ?? {}) };
	return new Promise<ShellRunResult>((resolve) => {
		const startedAt = Date.now();
		const child = spawn("bash", ["-lc", request.command], {
			cwd: request.cwd,
			shell: false,
			windowsHide: true,
			env,
		});

		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;

		const kill = (): void => {
			// ADR-027：先杀**整棵进程树**（best-effort），**再无条件补一刀直接子进程**（双保险，空操作无害）
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
				providerId: "bash",
				stdout,
				stderr,
				exitCode,
				timedOut,
				truncated,
				durationMs: Date.now() - startedAt,
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

/** 创建 bash provider（`sandbox` 缺省 = 不启用沙箱，行为与 M3 起逐字节相同）。 */
export function createBashProvider(options: { readonly sandbox?: Sandbox } = {}): ShellProvider {
	const sandbox = options.sandbox;
	return {
		id: "bash",
		isAvailable(): boolean {
			try {
				const probe = spawnSync("bash", ["-c", "exit 0"], { timeout: 2000, windowsHide: true });
				return probe.error === undefined && probe.status === 0;
			} catch {
				return false;
			}
		},
		run(request: ShellRunRequest): Promise<ShellRunResult> {
			return execute(request, sandbox);
		},
	};
}
