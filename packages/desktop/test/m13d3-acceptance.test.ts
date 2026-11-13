/**
 * M13d-3 验收测试（总工程师独立编写）：桌面版**让审批规则与权限策略看得见**（ADR-029 增补）。
 *
 * 对齐 CLI 的 `/approvals` 与 `/policy`：
 *  - **规则**：`runSessionRepl` 建好闸门后把**活的** `ApprovalRules` 对象交给前端一次
 *    （`RunReplOptions.onApprovalRules`）⇒ 刚答过「本次会话始终允许」就**立刻**读得到（无需轮询、无需重放）；
 *  - **策略**：生效的「模式 → 权限」表由 main 侧用 `describePermissionRule`（与 `/policy` **同一份实现**）格式化成文本行；
 *  - **renderer 不自己算**：它只 `window.aster.query()` 拿结论，然后做 DOM。
 *
 * `vitest` 里**不**拉 Electron ⇒ 这一层测纯 Node 的 `src/session.ts` + `cli` 的两个出口。
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cli } from "@aster/runtime";
import type { AgentMode } from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveSession } from "../src/session.js";
import { createDesktopSessions, createLiveSession } from "../src/session.js";
import { makeTempDir } from "./helpers/tmp.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const temps: string[] = [];

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("waitFor: condition not met within timeout");
}

async function bootstrap(extra: Partial<cli.CliOptions>) {
	const options: cli.CliOptions = { list: false, rebuildIndex: false, doctor: false, ...extra };
	return cli.bootstrapSessionRuntime({ options, output: { write: () => undefined } });
}

describe("M13d-3 审批规则实时可见（等价于 `/approvals`）", () => {
	it("答「本次会话始终允许」后，`approvalRules()` 立刻读到 `write@outside`（同一份**活的**规则对象）", async () => {
		const home = newTemp("aster-m13d3-home-");
		const cwd = newTemp("aster-m13d3-cwd-");
		const outside = join(newTemp("aster-m13d3-out-"), "out.txt");
		const runtime = await bootstrap({ home, demoWrite: outside });
		const sessions = createDesktopSessions({
			runtime,
			home,
			cwd,
			mode: "build",
			callbacks: {
				onReady: () => undefined,
				onEvent: () => undefined,
				onText: () => undefined,
				// 现场答「本次会话始终允许」（回调在 createDesktopSessions 返回后才触发 ⇒ 引用 `sessions` 是安全的）
				onApproval: () => void sessions.answerApproval("always"),
			},
		});

		// 还没开会话 ⇒ 规则为空（界面据此显示"暂无"）
		expect(sessions.approvalRules()).toEqual([]);

		sessions.sendPrompt("please write outside the workspace");
		await waitFor(() => sessions.approvalRules().length > 0);

		// 规则就是 `/approvals` 看到的那一份：`工具@作用域`
		expect(sessions.approvalRules().map((rule) => `${rule.toolName}@${rule.scope}`)).toEqual([
			"write@outside",
		]);

		await sessions.dispose();
		await runtime.dispose();
	});
});

describe("M13d-3 `onApprovalRules` 的回调语义（既有前端不受影响）", () => {
	it("有权限系统 ⇒ 闸门建好后回调**一次**（给的是那份活的规则对象，不抛）", async () => {
		const home = newTemp("aster-m13d3-callback-");
		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const list: { toolName: string; scope: string }[][] = [];
		const session: LiveSession = createLiveSession({
			runtime,
			home,
			mode: "plan",
			callbacks: {
				onReady: () => undefined,
				onEvent: () => undefined,
				onText: () => undefined,
				onApproval: () => undefined,
				onApprovalRules: (rules) => void list.push([...rules.list()]),
			},
		});
		session.sendPrompt("hello");
		session.close();
		await session.done;
		await runtime.dispose();
		expect(list).toHaveLength(1);
		expect(list[0]).toEqual([]); // 还没批过任何操作 ⇒ 空
	});
});

describe("M13d-3 策略表（等价于 `/policy`）", () => {
	it("生效的「模式 → 权限」表按模式给出**可读文本行**（与 `/policy` 同一份 formatter）", async () => {
		const home = newTemp("aster-m13d3-policy-");
		const runtime = await bootstrap({ home, stub: "hi", noTools: true });
		const policy = runtime.permission.policy();
		const modes: AgentMode[] = ["plan", "build"];
		const rows = modes.map((mode) => policy[mode].map((rule) => cli.describePermissionRule(rule)));

		for (const list of rows) {
			expect(list.length).toBeGreaterThan(0);
			expect(list.join(" | ")).toContain("="); // 形如 `工具[条件]=判定`
		}
		// plan 的第一条就是「只读 / 非破坏性工具一律放行」（ADR-013）——这条断言把"策略真的被读到"钉住
		expect(rows[0]?.some((row) => row.includes("readonly") && row.endsWith("allow"))).toBe(true);

		await runtime.dispose();
	});
});

describe("M13d-3 契约（源码级断言，防漂移）", () => {
	const replSource = readFileSync(join(PKG, "..", "runtime", "src", "cli", "repl.ts"), "utf8");
	const mainSource = readFileSync(join(PKG, "src", "main.ts"), "utf8");
	const preloadSource = readFileSync(join(PKG, "preload.cjs"), "utf8");
	const rendererSource = readFileSync(join(PKG, "renderer", "app.js"), "utf8");

	it("REPL 只多一个**可选**回调（缺省 ⇒ CLI/TUI 行为不变），且转出的是**活的**规则对象", () => {
		expect(replSource).toContain("onApprovalRules?.");
		expect(replSource).toContain("ApprovalRules");
	});

	it("IPC 只增：main 的 `aster:query` 在 preload 里有对应方法；策略文本复用同一 formatter", () => {
		expect(mainSource).toContain('"aster:query"');
		expect(preloadSource).toContain("aster:query");
		expect(preloadSource).toContain("query:");
		expect(mainSource).toContain("describePermissionRule");
	});

	it("renderer 不自己算规则/策略：只 `query()` 拿结论再做 DOM", () => {
		expect(rendererSource).toContain("window.aster.query");
		// 规则/策略是 main 给的；renderer 里不该出现"自己查策略/规则"的动作
		expect(rendererSource).not.toMatch(/aster\.(policy|approvals)/i);
	});
});
