/**
 * M15 验收测试（总工程师独立编写）：**windows-job = Windows-only 的内核强制围栏**（ADR-031）。
 *
 * 覆盖（Windows-only 的真进程测试用 `describe.skipIf` 守卫，其余纯逻辑在任意平台可跑）：
 *  - **口径**：`windows-job` 是**内核强制**（作业对象），但**不是文件/网络隔离**——`label` 与能力声明必须同时写清；
 *  - **不可用要吵**：非 Windows 传 `windows-job` ⇒ **抛**（绝不静默退回 off / best-effort）；
 *  - **资产落盘**：包装脚本带 UTF-8 BOM、C# 源不带 BOM、幂等、指纹稳定（源码一变 DLL 缓存自然失效）；
 *  - **包装执行端到端**（真进程）：正常输出 / 退出码透传 / **命令文本一字不改**（中文 + 引号 + 换行）；
 *  - **围栏是活的**：内层进程自检 `IsProcessInJob` 为真；
 *  - **整树击杀**：中止/超时 ⇒ 内层起的**孙进程**随之消失（内核 kill-on-close，不留孤儿）；
 *  - **进程数上限**：超过上限的进程**入不了作业**（内核拒绝）；
 *  - **拿不到围栏就拒绝执行**：包装计划抛错 ⇒ 可读失败 + exitCode 126，且**内层命令没跑**。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import {
	createSandbox,
	createWindowsJobSandbox,
	isWindowsJobAvailable,
	jobSourceFingerprint,
	materializeJobAssets,
	resolveSandboxMode,
	SANDBOX_MODES,
	SandboxModeError,
	WINDOWS_JOB_PROCESS_LIMIT,
	WINDOWS_JOB_UI_RESTRICTIONS,
} from "../src/sandbox/index.js";
import { createPwshProvider } from "../src/shell/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const isWindows = process.platform === "win32";
const PS = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/** 数一下当前有几个 ping 进程（用**另一条** powershell 数，避免污染被测路径）。 */
function countPing(): number {
	const out = execFileSync(
		PS,
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"(Get-Process -Name ping -ErrorAction SilentlyContinue | Measure-Object).Count",
		],
		{ encoding: "utf8" },
	);
	return Number.parseInt(out.trim(), 10);
}

function killAllPing(): void {
	try {
		execFileSync(
			PS,
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Get-Process -Name ping -ErrorAction SilentlyContinue | Stop-Process -Force",
			],
			{ encoding: "utf8" },
		);
	} catch {
		/* 没有 ping 时 Get-Process 无输出，忽略。 */
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 内层命令自检作业隶属（内嵌最小 P/Invoke；与产品 C# 无关，故不复用）。 */
const JOB_MEMBERSHIP_PROBE = [
	'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public static class P{[DllImport("kernel32.dll")]public static extern IntPtr GetCurrentProcess();[DllImport("kernel32.dll",SetLastError=true)]public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool r);}\';',
	'$r=$false; [void][P]::IsProcessInJob([P]::GetCurrentProcess(),[IntPtr]::Zero,[ref]$r); Write-Output "IN-JOB=$r"',
].join(" ");

describe("M15 口径与取值域（ADR-031）", () => {
	it("`windows-job` 在取值域里；解析大小写不敏感；未知值仍是 undefined（不静默退回）", () => {
		expect(SANDBOX_MODES).toEqual(["off", "best-effort", "windows-job"]);
		expect(resolveSandboxMode("windows-job")).toBe("windows-job");
		expect(resolveSandboxMode("WINDOWS_JOB")).toBe("windows-job");
		expect(resolveSandboxMode("best-effort")).toBe("best-effort");
		expect(resolveSandboxMode("off")).toBe("off");
		expect(resolveSandboxMode("strong")).toBeUndefined();
		expect(createSandbox("strong")).toBeUndefined();
		expect(createSandbox(undefined)?.mode).toBe("off");
	});

	it("非 Windows 请求 `windows-job` ⇒ **抛**（明确不可用，绝不静默降级）", () => {
		try {
			createSandbox("windows-job", { platform: "linux" });
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(SandboxModeError);
			expect((error as Error).message).toContain("只在 Windows 可用");
		}
	});

	it("Windows 下建得出来：**内核强制**要写清，**不是**文件/网络隔离也要写清", () => {
		const sandbox = createSandbox("windows-job", {
			platform: "win32",
			home: newTemp("chenxi-m15-home-"),
		});
		expect(sandbox?.mode).toBe("windows-job");
		expect(isWindowsJobAvailable("win32")).toBe(true);
		expect(isWindowsJobAvailable("linux")).toBe(false);
		expect(sandbox?.altersExecution).toBe(true);
		expect(sandbox?.label).toContain("内核强制");
		expect(sandbox?.label).toContain("不是");
		expect(sandbox?.label).toContain("文件/网络隔离");
		// 保守默认：不含 DESKTOP(0x40) / EXITWINDOWS(0x80)，但覆盖剪贴板与外窗句柄
		expect(WINDOWS_JOB_UI_RESTRICTIONS).toBe(0x3f);
		expect(WINDOWS_JOB_UI_RESTRICTIONS & 0x02).toBe(0x02); // READCLIPBOARD
		expect(WINDOWS_JOB_UI_RESTRICTIONS & 0x40).toBe(0x00);
		expect(WINDOWS_JOB_PROCESS_LIMIT).toBeGreaterThan(16);
	});

	it("`off` 仍是恒等（默认行为不变）；`best-effort` 的分寸一字未改", () => {
		const off = createSandbox(undefined);
		expect(off?.altersExecution).toBe(false);
		expect(off?.prepareLaunch).toBeUndefined();
		const best = createSandbox("best-effort");
		expect(best?.label).toContain("experimental");
		expect(best?.label).toContain("非隔离");
		expect(best?.prepareLaunch).toBeUndefined(); // best-effort **不**改 spawn 路径
	});
});

describe("M15 包装资产落盘（幂等 / BOM / 指纹）", () => {
	it("ps1 **带 UTF-8 BOM**、C# 源**不带 BOM**、重复落盘幂等、指纹稳定", () => {
		const home = newTemp("chenxi-m15-assets-");
		const first = materializeJobAssets(home);
		expect(existsSync(first.scriptPath)).toBe(true);
		expect(existsSync(first.csPath)).toBe(true);
		const ps1 = readFileSync(first.scriptPath, "utf8");
		expect(ps1.charCodeAt(0)).toBe(0xfeff); // PowerShell 5.1 无 BOM 会按 ANSI 读 ⇒ 中文注释会崩
		expect(ps1).toContain("CHENXI_JOB_INNER_B64");
		expect(readFileSync(first.csPath, "utf8").charCodeAt(0)).not.toBe(0xfeff);
		expect(readFileSync(first.csPath, "utf8")).toContain("CreateJobObjectW");

		const second = materializeJobAssets(home);
		expect(second.scriptPath).toBe(first.scriptPath);
		expect(readFileSync(second.scriptPath, "utf8")).toBe(ps1); // 幂等：不重写、不改内容

		const fp = jobSourceFingerprint();
		expect(fp).toMatch(/^[0-9a-f]{16}$/);
		expect(jobSourceFingerprint()).toBe(fp); // 同一份源码 ⇒ 同一个 DLL 缓存名
	});
});

describe.skipIf(!isWindows)("M15 包装执行（真进程）", () => {
	function providerFor(
		home: string,
		options: { processLimit?: number; materialize?: (h: string) => never } = {},
	) {
		const sandbox = createWindowsJobSandbox({
			home,
			...(options.processLimit === undefined ? {} : { processLimit: options.processLimit }),
			...(options.materialize === undefined ? {} : { materialize: options.materialize }),
		});
		return { sandbox, provider: createPwshProvider({ sandbox }) };
	}

	it("正常命令：exitCode 0，且命令文本**一字不改**（中文 + 引号 + 换行；经内层写文件按 UTF-8 读回）", async () => {
		const home = newTemp("chenxi-m15-run-");
		const { provider } = providerFor(home);
		const payload = '中文 " 引号 & 百分号 %';
		const outFile = join(home, "echoed.txt");
		// 说明：**不用 stdout 断言中文**——PS 5.1 重定向输出按 OS OEM 代码页（本机 936），这是**既有行为**
		// （对照实验：不启用沙箱时一模一样），不是 M15 引入的；改用文件 IO 才能断言"命令文本一字不改"。
		const tricky = [
			`Set-Content -Path '${outFile}' -Value '${payload}' -Encoding utf8`,
			"exit 0",
		].join("\n");
		const result = await provider.run({ command: tricky, cwd: home, workspaceRoot: home });
		expect(result.stderr).not.toContain("sandbox refused");
		expect(result.exitCode).toBe(0);
		expect(readFileSync(outFile, "utf8").trim()).toBe(payload); // 引号 / 中文都没被转义吃掉
	}, 30000);

	it("退出码透传：`exit 7` ⇒ exitCode 7", async () => {
		const home = newTemp("chenxi-m15-exit-");
		const { provider } = providerFor(home);
		const result = await provider.run({ command: "exit 7", cwd: home, workspaceRoot: home });
		expect(result.exitCode).toBe(7);
	}, 30000);

	it("围栏是活的：内层进程自检 `IsProcessInJob` 为真", async () => {
		const home = newTemp("chenxi-m15-injob-");
		const { provider } = providerFor(home);
		const result = await provider.run({
			command: JOB_MEMBERSHIP_PROBE,
			cwd: home,
			workspaceRoot: home,
		});
		expect(result.stdout).toContain("IN-JOB=True");
	}, 30000);

	it("整树击杀：中止当前回合 ⇒ 内层起的**孙进程**随之消失（内核 kill-on-close）", async () => {
		const home = newTemp("chenxi-m15-kill-");
		const { provider } = providerFor(home);
		killAllPing();
		await sleep(300);
		const controller = new AbortController();
		const running = provider.run({
			command: "cmd /c ping -n 60 127.0.0.1",
			cwd: home,
			workspaceRoot: home,
			signal: controller.signal,
		});
		await sleep(2600);
		expect(countPing()).toBeGreaterThan(0); // 孙进程真的起了
		controller.abort();
		await running;
		await sleep(1400);
		expect(countPing()).toBe(0); // 包装进程一死，作业内整棵树由**内核**带走
		killAllPing();
	}, 30000);

	it("进程数上限被内核强制：超限的进程**入不了作业**", async () => {
		const home = newTemp("chenxi-m15-limit-");
		const { provider } = providerFor(home, { processLimit: 4 });
		const spawner = [
			"$ok=0",
			"for($i=0;$i -lt 12;$i++){",
			"  try { Start-Process -NoNewWindow -FilePath $env:SystemRoot\\System32\\ping.exe -ArgumentList '-n','30','127.0.0.1' -PassThru | Out-Null; $ok++ } catch { break }",
			"}",
			'Write-Output "SPAWNED=$ok"',
		].join("\n");
		const result = await provider.run({ command: spawner, cwd: home, workspaceRoot: home });
		const spawned = /SPAWNED=(\d+)/.exec(result.stdout)?.[1];
		expect(spawned).toBeDefined();
		expect(Number.parseInt(spawned as string, 10)).toBeLessThan(12); // 上限 4（含内层 pwsh 自己）
		killAllPing();
	}, 30000);

	it("拿不到围栏就**拒绝执行**：包装计划抛错 ⇒ 可读失败 + exitCode 126，内层命令没跑", async () => {
		const home = newTemp("chenxi-m15-refuse-");
		const { provider } = providerFor(home, {
			materialize: () => {
				throw new Error("disk is full (simulated)");
			},
		});
		const result = await provider.run({
			command: "Write-Output 'SHOULD-NOT-RUN'",
			cwd: home,
			workspaceRoot: home,
		});
		expect(result.exitCode).toBe(126);
		expect(result.stderr).toContain("sandbox refused");
		expect(result.stderr).toContain("disk is full");
		expect(result.stdout).not.toContain("SHOULD-NOT-RUN");
	});

	it("cwd 越界仍走同一套**可读拒绝**（与 best-effort 同源）", async () => {
		const home = newTemp("chenxi-m15-cwd-");
		const outside = newTemp("chenxi-m15-outside-");
		const { provider } = providerFor(home);
		const result = await provider.run({
			command: "Write-Output 'x'",
			cwd: outside,
			workspaceRoot: home,
		});
		expect(result.exitCode).toBe(126);
		expect(result.stderr).toContain("sandbox refused");
		expect(result.stderr).toContain("Do not retry");
	});
});

describe("M15 CLI 接线", () => {
	it("`--sandbox` 取值域含 windows-job；缺值报错把三个值都列出来", () => {
		expect(parseArgs(["--sandbox", "windows-job"]).sandbox).toBe("windows-job");
		expect(parseArgs(["--sandbox", "off"]).sandbox).toBe("off");
		expect(() => parseArgs(["--sandbox"])).toThrowError(/off \| best-effort \| windows-job/);
	});
});
