/**
 * 进程树击杀（ADR-027 的 ①）：超时 / 中止时把**整棵树**送走，而不是只杀直接子进程。
 *
 * 为什么重要：`child.kill()` 只杀 `bash` / `pwsh` 本身；它启动的孙子进程（后台服务、长任务）
 * 会变成**孤儿**继续持有句柄 / 端口 / 文件锁——这类"命令返回了但后台还在跑"最难排查。
 *
 * 纪律：**绝不抛**（杀不掉也要让上层照常收尾），且**返回是否发出了有效击杀**便于测试与日志。
 */
import { spawnSync } from "node:child_process";

const WIN32 = process.platform === "win32";

/** 单次击杀命令的等待上限（毫秒）——杀不动就放弃，绝不挂住工具执行。 */
const KILL_TIMEOUT_MS = 5000;

/** 是否是一个像样的 pid（0 / 负数 / 非整数一律拒绝，避免误杀进程组）。 */
export function isKillablePid(pid: number | undefined): pid is number {
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

/**
 * 杀掉 `pid` 及其**全部后代**。
 * - Windows：`taskkill /PID <pid> /T /F`（`/T` = 连带子树，`/F` = 强制）；
 * - 类 Unix：先试**进程组**（`kill(-pid)`，要求子进程以 `detached` 起在独立进程组里），
 *   失败再退化为只杀自己——**退化是显式的**，返回值会如实反映是否成功。
 */
export function killProcessTree(pid: number | undefined): boolean {
	if (!isKillablePid(pid)) return false;
	if (WIN32) {
		try {
			const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
				timeout: KILL_TIMEOUT_MS,
				windowsHide: true,
			});
			return result.error === undefined && result.status === 0;
		} catch {
			return false;
		}
	}
	// 类 Unix：优先整组（子进程需以 detached:true 起，才能形成自己的进程组）
	try {
		process.kill(-pid, "SIGKILL");
		return true;
	} catch {
		/* 不在独立进程组里：退化为只杀直接进程（显式退化） */
	}
	try {
		process.kill(pid, "SIGKILL");
		return true;
	} catch {
		return false;
	}
}

/** 类 Unix 下让子进程自成进程组（`kill(-pid)` 才有意义）。Windows 忽略此参数。 */
export function detachedForTree(): boolean {
	return !WIN32;
}
