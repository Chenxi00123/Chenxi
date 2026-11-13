/**
 * M16 验收测试：**子进程输出统一 UTF-8**（修掉「`bash` 工具中文 stdout 乱码」）。
 *
 * 背景（实测，不是推理）：PowerShell 5.1 在 **stdout 被重定向**（Node 用管道接）时，按 **OS OEM 代码页**
 * （本机 936/GBK）写字节，而我们按 UTF-8 解码 ⇒ 中文变 `����`。修法 = 在命令前加一段前言：
 * `[Console]::OutputEncoding = UTF8`（连带把控制台输出代码页设成 65001，**原生命令也跟着变**）+ `$OutputEncoding = UTF8`。
 *
 * 覆盖：
 *  - **cmdlet 输出**中文正确回来（含引号 / 百分号 / emoji 之外的全角标点）；
 *  - **原生命令**输出中文也正确（`cmd /c echo 中文`）——证明控制台代码页确实被改了，不只是 .NET 流编码；
 *  - **windows-job 沙箱下**同样正确（前言在一份共享脚本文本里，两条路径共用）；
 *  - **ASCII 回归**：纯英文输出逐字节不变；
 *  - **退出码回归**：`exit 7` 仍透传 7；
 *  - **命令文本一字不改**：`Write-Output` 的实参里带引号与中文，输出逐字符相等。
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createWindowsJobSandbox } from "../src/sandbox/index.js";
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

describe("M16 输出编码（真进程）", () => {
	it("cmdlet 的输出是 UTF-8：中文 + 引号 + 全角标点逐字符相等", async () => {
		const home = newTemp("chenxi-m16-cmdlet-");
		const provider = createPwshProvider({});
		const payload = '中文 "引号" 与 & 百分号 % 【全角】';
		const result = await provider.run({ command: `Write-Output '${payload}'`, cwd: home });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(payload);
	});

	// `cmd /c` 只在 Windows 存在；Linux runner 上这条没有对应物（cmdlet 路径仍照常验证）
	it.skipIf(!isWindows)("**原生命令**的输出也是 UTF-8（控制台代码页确实被改了）", async () => {
		const home = newTemp("chenxi-m16-native-");
		const provider = createPwshProvider({});
		const result = await provider.run({ command: "cmd /c echo 中文-原生命令", cwd: home });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("中文-原生命令");
	});

	it("ASCII 与退出码回归：纯英文输出不变、`exit 7` 仍透传", async () => {
		const home = newTemp("chenxi-m16-regress-");
		const provider = createPwshProvider({});
		const plain = await provider.run({ command: "Write-Output plain-ascii", cwd: home });
		expect(plain.stdout.trim()).toBe("plain-ascii");
		const code = await provider.run({ command: "exit 7", cwd: home });
		expect(code.exitCode).toBe(7);
	});

	describe.skipIf(!isWindows)("windows-job 下同样 UTF-8（前言与包装路径共用同一份脚本）", () => {
		it("沙箱内中文输出正确回来", async () => {
			const home = newTemp("chenxi-m16-job-");
			const sandbox = createWindowsJobSandbox({ home });
			const provider = createPwshProvider({ sandbox });
			const payload = "沙箱里的中文【123】";
			const result = await provider.run({
				command: `Write-Output '${payload}'`,
				cwd: home,
				workspaceRoot: home,
			});
			expect(result.stderr).not.toContain("sandbox refused");
			expect(result.stdout.trim()).toBe(payload);
		});
	});
});
