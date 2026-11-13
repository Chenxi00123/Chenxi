import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createBashProvider,
	createPwshProvider,
	detectUnixisms,
	selectShellProvider,
} from "../src/shell/index.js";

/** 仓库根目录（测试仅在该目录及其子路径下执行 shell，绝不触碰 C 盘）。 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("selectShellProvider", () => {
	it("win32 优先 pwsh", () => {
		expect(selectShellProvider({ platform: "win32" }).id).toBe("pwsh");
	});

	it("linux 回退为 bash 或 pwsh", () => {
		expect(["bash", "pwsh"]).toContain(selectShellProvider({ platform: "linux" }).id);
	});
});

describe("detectUnixisms", () => {
	it("识别 ls / cat 并给出 PowerShell 等价写法", () => {
		const hints = detectUnixisms("ls -la && cat a.txt");
		expect(hints.length).toBeGreaterThan(0);
		expect(hints.some((h) => h.includes("Get-ChildItem"))).toBe(true);
		expect(hints.some((h) => h.includes("Get-Content"))).toBe(true);
	});

	it("纯 PowerShell 命令不误报", () => {
		expect(detectUnixisms("Get-ChildItem -Force")).toEqual([]);
	});
});

describe("pwsh provider", () => {
	const pwsh = createPwshProvider();

	it("正常执行：捕获 stdout 与退出码", async () => {
		const result = await pwsh.run({ command: "Write-Output 'hello-aster'", cwd: repoRoot });
		expect(result.providerId).toBe("pwsh");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello-aster");
	});

	it("失败命令：回传退出码", async () => {
		const result = await pwsh.run({ command: "Write-Output oops; exit 3", cwd: repoRoot });
		expect(result.exitCode).toBe(3);
	});

	it("Unix 惯用法：照常执行并附带提示", async () => {
		const result = await pwsh.run({ command: "ls", cwd: repoRoot });
		expect(Array.isArray(result.hints)).toBe(true);
		expect(result.hints?.length ?? 0).toBeGreaterThan(0);
	});

	it("超时：真的杀掉子进程并置 timedOut", async () => {
		const result = await pwsh.run({
			command: "Start-Sleep -Seconds 10",
			cwd: repoRoot,
			timeoutMs: 700,
		});
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
	});

	it("超限输出：截断并置 truncated", async () => {
		const result = await pwsh.run({
			command: "Write-Output ('x' * 5000)",
			cwd: repoRoot,
			maxOutputBytes: 100,
		});
		expect(result.truncated).toBe(true);
	});
});

describe("bash provider", () => {
	it("可用性探测返回 boolean 且不抛异常；可用则执行 echo", async () => {
		const bash = createBashProvider();
		let available = false;
		expect(() => {
			available = bash.isAvailable();
		}).not.toThrow();
		expect(typeof available).toBe("boolean");
		expect(bash.id).toBe("bash");

		if (available) {
			const result = await bash.run({ command: "echo hi", cwd: repoRoot });
			expect(result.stdout).toContain("hi");
		}
	});
});
