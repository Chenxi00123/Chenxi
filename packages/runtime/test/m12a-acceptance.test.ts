/**
 * M12a 验收测试（总工程师独立编写）：best-effort 沙箱（ADR-027）。
 *
 * 覆盖（**只断言本批真做的三件事 + "默认 off = 恒等"**，绝不断言"隔离"）：
 *  - **默认 off**：`createNullSandbox()` 的 `prepare` 与不启用时**逐字节相同**、`killTree` 恒 false、
 *    未知模式**返回 undefined**（调用方快速失败，绝不静默退回 off）；
 *  - **best-effort 环境收敛**：环境变量**白名单**（密钥类不外传）+ 显式 `ASTER_SANDBOX=best-effort` +
 *    `cwd` 越界给出**可读拒绝**（且**真的不执行**）；
 *  - **进程树击杀（真进程、真断言）**：父进程 + 孙子进程在超时/中止时**一起消失**（这是本批唯一真正减少事故面的部分）；
 *  - **provider 接线**：超时确实走 `killTree`；越界 cwd 由**两个 provider** 一致地可读拒绝（exitCode 126）；
 *  - **数据根 ACL 围栏**：注入 runner 覆盖"成功 / 仍有继承项 (I) / icacls 失败"三种判定 + **真机 icacls 实测一次**；
 *  - **CLI**：`--sandbox` 解析与缺值快速失败。
 *
 * ⚠️ 本批**不是隔离**（ADR-027 的否定句）：不限制工具能写哪里、不做网络隔离、不做受限令牌。
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/main.js";
import {
	auditDataRootAcl,
	createBestEffortSandbox,
	createNullSandbox,
	createSandbox,
	currentPrincipal,
	isKillablePid,
	killProcessTree,
	resolveSandboxMode,
	SANDBOX_MARKER_ENV,
	tightenCommand,
} from "../src/sandbox/index.js";
import { createBashProvider } from "../src/shell/bash.js";
import { createPwshProvider } from "../src/shell/pwsh.js";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

/**
 * 造一对"根内 / 根外"路径：根内 = 新建的临时目录；根外 = 它的父目录（**故意不建**，
 * 说明拒绝判定是**纯字符串逻辑**，不需要目标真的存在——本机不允许写死绝对路径，故相对构造）。
 */
function workspacePair(): { readonly workspaceRoot: string; readonly outside: string } {
	const workspaceRoot = newTemp("aster-m12a-ws-");
	return { workspaceRoot, outside: dirname(workspaceRoot) };
}

/** 进程是否还活着（Windows 上 `kill(pid, 0)` 同样可用：不存在就抛 ESRCH）。 */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("M12a 默认 off = 恒等（任何'默认行为变了'都是 bug）", () => {
	it("`prepare` 与不启用时逐字节相同；`killTree` 恒 false；`altersExecution` 为 false", () => {
		const sandbox = createNullSandbox();
		expect(sandbox.mode).toBe("off");
		expect(sandbox.altersExecution).toBe(false);
		const prepared = sandbox.prepare({ command: "echo hi", cwd: "D:\\w", env: { A: "1" } });
		expect(prepared.refusal).toBeUndefined();
		expect(prepared.env.A).toBe("1");
		expect(prepared.env.PATH).toBe(process.env.PATH); // 不收敛、不裁剪
		expect(sandbox.killTree(12345)).toBe(false); // 不杀树 ⇒ provider 退回 child.kill()（行为不变）
		expect(sandbox.auditDataRoot("D:\\w").tight).toBe(false);
	});

	it("模式解析：缺省 off；`best-effort` 两种写法等价；未知取值 -> undefined（**不静默退回**）", () => {
		expect(resolveSandboxMode(undefined)).toBe("off");
		expect(resolveSandboxMode("off")).toBe("off");
		expect(resolveSandboxMode("best-effort")).toBe("best-effort");
		expect(resolveSandboxMode("Best_Effort")).toBe("best-effort");
		expect(resolveSandboxMode("strong")).toBeUndefined();
		expect(createSandbox("strong")).toBeUndefined();
		expect(createSandbox(undefined)?.mode).toBe("off");
		expect(createSandbox("best-effort")?.mode).toBe("best-effort");
	});

	it("`isKillablePid`：0 / 负数 / 非整数一律拒绝（避免误杀进程组）", () => {
		expect(isKillablePid(1234)).toBe(true);
		expect(isKillablePid(0)).toBe(false);
		expect(isKillablePid(-1)).toBe(false);
		expect(isKillablePid(1.5)).toBe(false);
		expect(isKillablePid(undefined)).toBe(false);
	});
});

describe("M12a best-effort：环境收敛 + cwd 越界可读拒绝", () => {
	it("环境变量**白名单**：密钥类不外传、PATH 保留、并显式打标 `ASTER_SANDBOX`", () => {
		process.env.ASTER_TEST_SECRET = "leak-me";
		try {
			const sandbox = createBestEffortSandbox();
			expect(sandbox.altersExecution).toBe(true);
			expect(sandbox.label).toContain("experimental");
			expect(sandbox.label).toContain("非隔离");
			const prepared = sandbox.prepare({ command: "echo hi", cwd: "D:\\w", env: { EXTRA: "x" } });
			expect(prepared.env.ASTER_TEST_SECRET).toBeUndefined(); // 白名单外：不传给子进程
			expect(prepared.env.PATH).toBe(process.env.PATH);
			expect(prepared.env.EXTRA).toBe("x"); // 调用方显式给的照旧生效
			expect(prepared.env[SANDBOX_MARKER_ENV]).toBe("best-effort"); // 让脚本知道自己没被真隔离
		} finally {
			delete process.env.ASTER_TEST_SECRET;
		}
	});

	// 用例用 Windows 盘符路径（`D:\workspace`）表达"在根内 / 在根外"；Linux 上这些不是绝对路径，语义不同。
	it.skipIf(process.platform !== "win32")(
		"`cwd` 越出工作区根 -> **可读拒绝**（不是抛异常）；根内则是正常准备",
		() => {
			const sandbox = createBestEffortSandbox();
			const refused = sandbox.prepare({
				command: "echo hi",
				cwd: "D:\\outside\\dir",
				workspaceRoot: "D:\\workspace",
			});
			expect(refused.refusal).toContain("sandbox refused");
			expect(refused.refusal).toContain("Do not retry");
			const ok = sandbox.prepare({
				command: "echo hi",
				cwd: "D:\\workspace\\sub",
				workspaceRoot: "D:\\workspace",
			});
			expect(ok.refusal).toBeUndefined();
		},
	);
});

describe("M12a 进程树击杀（真进程）：超时/中止不留孤儿", () => {
	// 进程树击杀的 Windows 实现走 `taskkill /T`；Linux 分支未做验收（1.0 只承诺 Windows），故只在 win32 上跑。
	it.skipIf(process.platform !== "win32")(
		"父进程 + 孙子进程一起消失（`taskkill /T` / 进程组）",
		async () => {
			// 父：起一个孙子并打印两个 pid，然后自己也长睡
			const script = [
				"const { spawn } = require('node:child_process');",
				"const grand = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
				"console.log(process.pid + ' ' + grand.pid);",
				"setInterval(() => {}, 1000);",
			].join(" ");
			const parent = spawn(process.execPath, ["-e", script], {
				stdio: ["ignore", "pipe", "ignore"],
			});

			const pids = await new Promise<{ parent: number; grand: number }>((resolve, reject) => {
				let buffer = "";
				const timer = setTimeout(() => reject(new Error("no pids in time")), 8000);
				parent.stdout.on("data", (chunk: Buffer) => {
					buffer += chunk.toString();
					const match = /(\d+)\s+(\d+)/.exec(buffer);
					if (match !== null) {
						clearTimeout(timer);
						resolve({ parent: Number(match[1]), grand: Number(match[2]) });
					}
				});
				parent.on("error", reject);
			});

			expect(alive(pids.parent)).toBe(true);
			expect(alive(pids.grand)).toBe(true);
			expect(killProcessTree(pids.parent)).toBe(true);
			// 孙悟空也要走：这正是 `child.kill()` 做不到的部分
			await waitFor(() => !alive(pids.parent) && !alive(pids.grand));
			expect(alive(pids.parent)).toBe(false);
			expect(alive(pids.grand)).toBe(false);
		},
		20000,
	);

	it("非法 pid 直接返回 false（不抛）", () => {
		expect(killProcessTree(undefined)).toBe(false);
		expect(killProcessTree(0)).toBe(false);
	});
});

describe("M12a provider 接线：超时走 killTree；越界 cwd 两个 provider 一致拒绝", () => {
	it("超时确实调用了 `killTree`（注入桩，断言 300ms 内被叫到）", async () => {
		const calls: (number | undefined)[] = [];
		const sandbox = createBestEffortSandbox({
			killTree: (pid) => {
				calls.push(pid);
				return true;
			},
		});
		const provider = createPwshProvider({ sandbox });
		if (!provider.isAvailable()) return; // 无 PowerShell 的环境：本机可证的部分到此为止
		const { workspaceRoot } = workspacePair();
		const result = await provider.run({
			command: "Start-Sleep -Seconds 5",
			cwd: workspaceRoot,
			timeoutMs: 300,
		});
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toBeGreaterThan(0);
	});

	it("越界 cwd -> 可读拒绝（exitCode 126，stderr 含 sandbox refused）；off 模式不拦", async () => {
		const sandbox = createBestEffortSandbox();
		const { workspaceRoot, outside } = workspacePair();
		const request = { command: "echo hi", cwd: outside, workspaceRoot };
		const refusing = await createPwshProvider({ sandbox }).run(request);
		expect(refusing.exitCode).toBe(126);
		expect(refusing.stderr).toContain("sandbox refused");

		// off（默认）：同一请求**不**被拒（恒等语义）
		const permissive = await createNullSandbox().prepare(request);
		expect(permissive.refusal).toBeUndefined();
	});

	it("bash provider 同一套接线（同一个沙箱对象传给两个后端）", async () => {
		const sandbox = createBestEffortSandbox();
		const bash = createBashProvider({ sandbox });
		if (!bash.isAvailable()) return; // Windows 上通常没有 bash：跳过即可，不影响契约
		const { workspaceRoot, outside } = workspacePair();
		const result = await bash.run({ command: "echo hi", cwd: outside, workspaceRoot });
		expect(result.exitCode).toBe(126);
		expect(result.stderr).toContain("sandbox refused");
	});
});

describe("M12a 数据根权限体检（**只读**：我们只检测 + 给命令，绝不动 ACL）", () => {
	it("注入 runner：已收紧 / 有继承项 (I) / 有 Everyone 授权 / 读不到 ACL 四种判定都能被断言", () => {
		const principal = currentPrincipal() ?? "DOMAIN\\user";
		/** 模拟 icacls 的**只读**输出（体检只发一条命令，故 runner 只面对单参调用）。 */
		const runnerOf = (acl: string) => (_args: readonly string[]) => ({
			status: 0,
			stdout: acl,
			stderr: "",
			failed: false,
		});
		const tight = runnerOf(`${"D:\\x"} ${principal}:(F)`);
		const inherited = runnerOf(
			`${"D:\\x"} BUILTIN\\Users:(I)(OI)(CI)(RX)\n${"D:\\x"} ${principal}:(F)`,
		);
		const broad = runnerOf(`${"D:\\x"} Everyone:(OI)(CI)(F)`);
		const unreadable = () => ({ status: 5, stdout: "", stderr: "Access is denied.", failed: true });

		const dir = newTemp("aster-m12a-acl-");
		if (process.platform === "win32") {
			expect(auditDataRootAcl(dir, tight).tight).toBe(true);
			expect(auditDataRootAcl(dir, tight).hint).toContain("icacls");
			const inheritedAudit = auditDataRootAcl(dir, inherited);
			expect(inheritedAudit.tight).toBe(false);
			expect(inheritedAudit.reason).toContain("(I)");
			expect(inheritedAudit.reason).toContain("继承");
			const broadAudit = auditDataRootAcl(dir, broad);
			expect(broadAudit.tight).toBe(false);
			expect(broadAudit.reason).toContain("Everyone");
			const failedAudit = auditDataRootAcl(dir, unreadable);
			expect(failedAudit.tight).toBe(false);
			expect(failedAudit.reason).toContain("Access is denied");
		} else {
			expect(auditDataRootAcl(dir, tight).reason).toContain("只有 Windows 实现");
		}
	});

	it("真机 icacls 实测一次：结论必须**可读**且**不改动任何 ACL**（不做手术 = 不会把用户锁在门外）", () => {
		const dir = newTemp("aster-m12a-acl-real-");
		const file = join(dir, "session.jsonl");
		writeFileSync(file, "{}\n", "utf8");
		const before = spawnSync("icacls", [dir], { encoding: "utf8", windowsHide: true }).stdout ?? "";

		const audit = auditDataRootAcl(dir);
		expect(typeof audit.reason).toBe("string");
		expect(audit.reason.length).toBeGreaterThan(0);
		if (process.platform === "win32") {
			// 新建的临时目录从父目录继承权限 ⇒ 本机应当被判为"未收紧"，并给出可复制的收紧命令
			expect(audit.tight).toBe(false);
			expect(audit.hint).toContain("icacls");
			expect(audit.hint).toContain("/inheritance:r");
		} else {
			expect(audit.tight).toBe(false);
			expect(audit.hint).toBe("");
		}
		// **ACL 一个字节都没变**（只读体检），且清理时仍能删掉（M12a 实现期踩过的坑：动手术会 EPERM）
		const after = spawnSync("icacls", [dir], { encoding: "utf8", windowsHide: true }).stdout ?? "";
		expect(after).toBe(before);
		expect(tightenCommand(dir, currentPrincipal())).toContain(dir);
		rmSync(file, { force: true });
	});
});

describe("M12a CLI：`--sandbox` 解析", () => {
	it("取值可解析；缺值快速失败（与其它 flag 同一条纪律）", () => {
		expect(parseArgs(["--sandbox", "best-effort"]).sandbox).toBe("best-effort");
		expect(parseArgs(["--sandbox", "off"]).sandbox).toBe("off");
		expect(parseArgs([]).sandbox).toBeUndefined();
		expect(() => parseArgs(["--sandbox"])).toThrow(/--sandbox requires a mode/);
	});
});
