/**
 * M13a 验收测试（总工程师独立编写）：桌面版窗口的**可自动断言部分**（ADR-029）。
 *
 * 本机**能**跑 Electron（`--self-check` 冒烟会在真窗口 + 真 renderer 里断言 DOM），
 * 但 `vitest` 里**不**该拉起 Electron ⇒ 这一层测的是"窗口与 IPC 之外"的一切：
 *  - **「绝不碰 C 盘」守卫**（纯函数）：路径布局 / 越界判定 / 缺路径 / 数据根解析；
 *  - **会话宿主（纯 Node）**：列会话 + 读一条会话的已记录事件，且**读路径不产生任何写入**（JSONL 逐字节不变）；
 *  - **事件 → 卡片映射**（纯函数）：角色 / 元信息 / 多行正文 / **未知类型不丢事实**；
 *  - **契约与纪律（源码级断言，防漂移）**：CSP 存在、preload 用 `contextBridge` 且不碰 Node、
 *    **IPC 频道名 main ↔ preload 一致**、main 真的做了四路径改道 + 越界即拒绝启动。
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { cli, createStubProvider } from "@aster/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopHost, toEventCard, toEventCards } from "../src/host.js";
import {
	auditDesktopPaths,
	desktopDataRoot,
	desktopPaths,
	isInside,
	resolveDesktopHome,
} from "../src/paths.js";
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

/** 跑一条**真实会话**（stub provider；只用于给 GUI 造"已记录的事实"）。 */
async function runRecordedSession(home: string): Promise<string> {
	const result = await cli.runSessionRepl({
		home,
		provider: createStubProvider([{ content: "hi from stub", stopReason: "end_turn" }]),
		model: "stub-model",
		mode: "plan",
		input: Readable.from(["hello\n", "/exit\n"]),
		output: { write: () => undefined },
		// 不给 tools/permission：本用例只关心"事实被记下来了"，与工具无关
		noTools: undefined,
	} as Parameters<typeof cli.runSessionRepl>[0]);
	return result.sessionId;
}

function sessionFile(home: string): string {
	const dir = join(home, "sessions");
	const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
	if (file === undefined) throw new Error("no session file");
	return join(dir, file);
}

describe("M13a 「绝不碰 C 盘」守卫（纯函数）", () => {
	it("路径布局：四个受管路径都在 `<home>\\desktop` 之下", () => {
		const home = join("D:", "data", "aster", "desktop");
		const paths = desktopPaths(home);
		expect(Object.keys(paths).sort()).toEqual(["cache", "logs", "sessionData", "userData"]);
		for (const value of Object.values(paths)) expect(isInside(home, value)).toBe(true);
		expect(paths.userData).toBe(home);
	});

	it("越界 / 缺路径 / 全在内：三种判定与可读原因", () => {
		const home = desktopDataRoot("D:\\data\\aster");
		const paths = desktopPaths(home);
		const all = auditDesktopPaths(home, (key) => paths[key as "userData"]);
		expect(all.ok).toBe(true);
		expect(all.reason).toContain("全部路径都在数据根内");

		// 一项落到 C 盘 ⇒ 必须判"不通过"，且原因里**点名是哪个键**
		const leak = auditDesktopPaths(home, (key) =>
			key === "cache" ? "C:\\Users\\someone\\AppData\\Local\\Temp" : paths[key as "userData"],
		);
		expect(leak.ok).toBe(false);
		expect(leak.reason).toContain("cache=");
		expect(leak.reason).toContain("绝不碰 C 盘");

		// Electron 没给出某个键（取不到 / 抛）⇒ 也算不通过（绝不默认放行）
		const missing = auditDesktopPaths(home, (key) =>
			key === "logs" ? "" : paths[key as "userData"],
		);
		expect(missing.ok).toBe(false);
		expect(missing.entries.find((entry) => entry.key === "logs")?.path).toBe("(缺)");
	});

	it("数据根解析：显式 `ASTER_HOME` 优先；否则落在仓库所在的盘", () => {
		expect(resolveDesktopHome({ ASTER_HOME: "D:\\elsewhere" }, "D:\\repo")).toBe("D:\\elsewhere");
		expect(resolveDesktopHome({}, "D:\\repo")).toBe("D:\\repo\\.aster");
		expect(desktopDataRoot("D:\\repo\\.aster")).toBe("D:\\repo\\.aster\\desktop");
		expect(isInside("D:\\repo", "D:\\repo2")).toBe(false); // 前缀陷阱：`repo2` 不在 `repo` 内
	});
});

describe("M13a 会话宿主（纯 Node；只读）", () => {
	it("列会话 + 读事件：能拿到真实会话的已记录事件，且**读路径零写入**（JSONL 逐字节不变）", async () => {
		const home = newTemp("aster-m13a-home-");
		const sessionId = await runRecordedSession(home);
		const file = sessionFile(home);
		const before = readFileSync(file);

		const host = createDesktopHost({ home });
		try {
			const list = await host.list();
			expect(list.map((item) => item.sessionId)).toContain(sessionId);
			expect(list[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

			const replay = await host.read(sessionId);
			expect(replay.sessionId).toBe(sessionId);
			expect(replay.events[0]?.type).toBe("session/start");
			expect(replay.events.at(-1)?.type).toBe("session/end");
			expect(replay.events.some((event) => event.type === "user/message")).toBe(true);
		} finally {
			await host.dispose();
		}

		// 「GUI 只读」的可断言形态：事实源一个字节都没变
		expect(readFileSync(file).equals(before)).toBe(true);
		expect(host.home).toBe(home);
	});
});

describe("M13a 事件 → 卡片（纯函数；**不复制终端行模型**）", () => {
	const base = { seq: 7, id: "evt_7", sessionId: "ses_x", at: "at" } as const;

	it("角色与元信息来自**事件类型**（不靠文本启发式）", () => {
		expect(toEventCard({ ...base, type: "user/message", payload: { content: "多\n行" } })).toEqual({
			role: "user",
			type: "user/message",
			seq: 7,
			text: "多\n行",
		});
		const toolResult = toEventCard({
			...base,
			type: "tool/result",
			payload: { callId: "c", toolName: "read", ok: true, output: "out", durationMs: 3 },
		});
		expect(toolResult.role).toBe("tool");
		expect(toolResult.meta).toBe("read ok · 3ms");
		const mode = toEventCard({
			...base,
			type: "mode/changed",
			payload: { from: "plan", to: "build", reason: "user command" },
		});
		expect(mode).toMatchObject({ role: "mode", text: "plan → build" });
	});

	it("失败的工具结果给可读原因（首行）；未知类型**不丢事实**", () => {
		const failed = toEventCard({
			...base,
			type: "tool/result",
			payload: {
				callId: "c",
				toolName: "write",
				ok: false,
				error: { code: "permission_denied", message: "nope\nstack", retryable: false },
				durationMs: 1,
			},
		});
		expect(failed.text).toBe("permission_denied: nope");
		expect(failed.meta).toContain("write error");

		const unknown = toEventCard({ ...base, type: "future/thing", payload: {} } as never);
		expect(unknown.role).toBe("unknown");
		expect(unknown.text).toBe("[event] future/thing");
		expect(
			toEventCards([{ ...base, type: "turn/start", payload: { turnId: "t", index: 0 } }]),
		).toHaveLength(1);
	});
});

describe("M13a 契约与纪律（源码级断言，防漂移）", () => {
	const mainSource = readFileSync(join(PKG, "src", "main.ts"), "utf8");
	const preloadSource = readFileSync(join(PKG, "preload.cjs"), "utf8");
	const htmlSource = readFileSync(join(PKG, "renderer", "index.html"), "utf8");
	const rendererSource = readFileSync(join(PKG, "renderer", "app.js"), "utf8");

	it("IPC 频道名 main ↔ preload **一致**（preload 是 CJS，故只能用源码比对钉住）", () => {
		const channels = [...mainSource.matchAll(/"(aster:[a-z:]+)"/g)].map((match) => match[1]);
		expect(channels.length).toBeGreaterThanOrEqual(3);
		for (const channel of new Set(channels)) {
			expect(preloadSource).toContain(channel);
		}
		// preload 暴露的就是这三个方法（**只增不改**）
		expect(preloadSource).toContain("contextBridge.exposeInMainWorld");
		for (const api of ["meta:", "list:", "read:"]) expect(preloadSource).toContain(api);
	});

	it("renderer 拿不到 Node / 不碰 ipcRenderer：只有 `window.aster` 这一条窄接口", () => {
		expect(rendererSource).not.toContain("require(");
		expect(rendererSource).not.toContain("ipcRenderer");
		// 只做 DOM 组装 ⇒ 不注入 HTML 字符串（没有注入面）
		expect(/\.innerHTML\s*=/.test(rendererSource)).toBe(false);
		expect(rendererSource).not.toContain("insertAdjacentHTML");
		expect(preloadSource).not.toContain('require("node:');
		expect(preloadSource).not.toContain('require("fs');
	});

	it("renderer 页有 CSP（`default-src 'none'`）——连一次网络请求都发不出去", () => {
		expect(htmlSource).toContain('http-equiv="Content-Security-Policy"');
		expect(htmlSource).toContain("default-src 'none'");
		expect(htmlSource).toContain("connect-src 'none'");
		expect(htmlSource).not.toContain("http://");
	});

	it("安全基线写死在 main 里：隔离开启 + 四路径改道 + 越界即拒绝启动", () => {
		expect(mainSource).toContain("contextIsolation: true");
		expect(mainSource).toContain("nodeIntegration: false");
		expect(mainSource).toContain("sandbox: true");
		expect(mainSource).toContain("app.setPath");
		expect(mainSource).toContain("auditDesktopPaths");
		expect(mainSource).toContain("app.exit(2)"); // 不通过就退出码 2，不静默落到 C 盘
	});

	it("本地托管只读、且不做远程加载（renderer 由同进程 loopback 托管）", () => {
		const uiSource = readFileSync(join(PKG, "src", "ui-server.ts"), "utf8");
		expect(uiSource).toContain('"127.0.0.1"'); // 只绑回环
		expect(uiSource).toContain("405"); // 非 GET/HEAD 一律拒绝（**没有写方法**）
		expect(uiSource).not.toContain("POST"); // 不处理任何写方法
		expect(uiSource).toContain("not found"); // 越界 / 非白名单类型一律 404，不泄漏文件系统布局
	});
});
