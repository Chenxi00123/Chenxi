/**
 * Electron main（ADR-029 / 增补 M13b）：**只做四件事**——① 落实「绝不碰 C 盘」并把关；
 * ② 托起窗口（本地资源 + 安全基线）；③ 装配**一次**会话运行时（与 CLI **共用 `cli/bootstrap.ts`**）；
 * ④ 把 IPC 转发给**纯 Node 的 `host.ts` / `session.ts`**。main **不写业务逻辑**。
 *
 * 安全基线（ADR-029 ③，写死）：`contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`，
 * renderer 只经 `preload.cjs` 的**窄接口**拿数据 / 发话 / 审批；窗口只加载**同进程 loopback** 托管的本地资源。
 *
 * M13b 起窗口是**可交互**的：会话在**本进程内**跑 `runSessionRepl`（审批 / 模式切换 / SIGINT 全部复用既有语义）。
 * 「窗口关闭 ≠ 中断回合」：关窗只给会话输入流 EOF（**等当前回合跑完**再 `session/end`），中断当前回合是显式按钮。
 *
 * `--self-check`：端到端自检（供冒烟用）——等窗口加载完，**在 renderer 里**断言列表与卡片真的渲染出来，
 * 并**真的发一条 prompt** 看卡片增加，打印一行 `SELFCHECK {...}` 后退出。
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli } from "@aster/runtime";
import { AGENT_MODES } from "@aster/schema";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { createDesktopHost, toEventCards } from "./host.js";
import { auditDesktopPaths, desktopDataRoot, desktopPaths, resolveDesktopHome } from "./paths.js";
import { runSelfCheck } from "./self-check.js";
import { createDesktopSessions } from "./session.js";
import { saveTitle } from "./session-titles.js";
import {
	applyDesktopProviderSettings,
	createSafeStorageBox,
	registerSettingsIpc,
} from "./settings-ipc.js";
import { startUiServer } from "./ui-server.js";

/**
 * 资源定位（M13c）：**开发形态与便携形态共用同一套目录布局**——main 与 `renderer/`、`preload.cjs` **同目录**。
 *  - 开发形态：`packages/desktop/dist/app/`（`tools/build-desktop-app.mjs` 摆出来的）
 *  - 便携形态：`<便携根>/resources/app/`（同一个脚本的产物被拷进去）
 * 因为布局一致，这里的路径推导**不必分叉**（少一处"打包后才错"的隐患）。
 */
const APP_DIR = fileURLToPath(new URL("./", import.meta.url));
const RENDERER_DIR = resolve(APP_DIR, "renderer");
const PRELOAD = resolve(APP_DIR, "preload.cjs");

/**
 * 默认**数据根 / 工作区**的基准（「绝不碰 C 盘」的可断言前提）：
 *  - **便携形态**（`app.isPackaged`）→ **便携根**（`<便携根>/resources/app/` 往上两级）⇒ 数据落在 **App 所在盘**；
 *  - **开发形态** → **仓库根**（`packages/desktop/dist/app/` 往上四级）。
 * 用户可用 `ASTER_HOME` 覆盖（优先级更高）。
 */
const BASE_ROOT = fileURLToPath(
	new URL(app.isPackaged ? "../../" : "../../../../", import.meta.url),
);

/** renderer → main 的**调用**频道（受契约约束：只增不改，改动必须进 ADR）。 */
export const CHANNELS = {
	meta: "aster:meta",
	list: "aster:sessions:list",
	read: "aster:sessions:read",
	prompt: "aster:prompt",
	setMode: "aster:mode",
	answerApproval: "aster:approval",
	interrupt: "aster:interrupt",
	newSession: "aster:new",
	/** M13d-1：续跑一条已记录会话（与 CLI 的 `--resume <sessionId>` 同一份语义）。 */
	resume: "aster:resume",
	/** M13d-3：查"生效的审批规则 + 模式→权限策略"（等价于 CLI 的 `/approvals` 与 `/policy`）。 */
	query: "aster:query",
	/** M21：模型接入设置（读 / 存 / 测 / 重启）。 */
	settingsGet: "aster:settings:get",
	settingsSave: "aster:settings:save",
	settingsTest: "aster:settings:test",
	settingsRestart: "aster:settings:restart",
	/** M22：会话改名（桌面标题，**不是**会话事实；不写 JSONL）。 */
	rename: "aster:sessions:rename",
} as const;

/** main → renderer 的**推送**频道（事件 / 文本 / 审批 / 会话就绪 / 装配审计）。 */
export const PUSH = {
	event: "aster:push:event",
	text: "aster:push:text",
	approval: "aster:push:approval",
	ready: "aster:push:ready",
	boot: "aster:boot",
} as const;

const selfCheck = process.argv.includes("--self-check");

/** ① 「绝不碰 C 盘」：先改道，再校验；不满足就**拒绝启动**（绝不静默落到 C 盘）。 */
function guardPaths(): { readonly dataHome: string; readonly report: string } {
	// 会话数据根与 CLI/TUI **同一个**（ASTER_HOME / 仓库内 `.aster`）：GUI 要能看到 CLI 跑出来的会话
	const dataHome = resolveDesktopHome(process.env, BASE_ROOT);
	// Electron 自己的内部路径（cookies / localStorage / GPU / 日志）统一落到 `<home>\desktop` 之下
	const guardRoot = desktopDataRoot(dataHome);
	const paths = desktopPaths(guardRoot);
	for (const [key, value] of Object.entries(paths)) {
		app.setPath(key, value);
	}
	const audit = auditDesktopPaths(guardRoot, (key) => app.getPath(key as "userData"));
	if (!audit.ok) {
		process.stderr.write(
			`aster-desktop: 拒绝启动 —— ${audit.reason}\n` +
				`（本项目红线：数据一律落在仓库所在盘；可用 ASTER_HOME 指定别处的 D 盘目录）\n`,
		);
		app.exit(2);
	}
	return { dataHome, report: `${audit.reason}；会话数据根 ${dataHome}` };
}

/** 非空字符串校验（IPC 边界：外部输入一律校验，绝不信任 renderer）。 */
function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "")
		throw new Error(`${field} must be a non-empty string`);
	return value;
}

/**
 * 路径守卫**必须在 app ready 之前**落实（M21 实测）：Chromium 启动时就会读 `userData` 下的
 * `Local State`（`safeStorage` 的 DPAPI 密钥存在那里）——等到 ready 之后再 `setPath` 就晚了，
 * 会生成/读到另一把钥匙，导致密文跨进程解不开。
 */
const guardedPaths = guardPaths();

async function run(): Promise<void> {
	const { dataHome, report } = guardedPaths;
	const host = createDesktopHost({ home: dataHome });
	const ui = await startUiServer(RENDERER_DIR);
	// ADR-029 增补：运行时装配与 CLI **共用一份**（ADR-014/015/016/017 的全部行为原样继承）。
	// 装配期的可读提示（config: / mcp: / memory: / subagents:）先缓存，窗口起来后一并发给 renderer（可审计）。
	const bootLines: string[] = [];
	// M21（ADR-039）：模型接入设置**先于装配**注入（provider 只在装配期解析一次）；
	// 密钥经 Windows DPAPI 加密落盘，这里只在进程内解密成环境变量。
	const secretBox = createSafeStorageBox();
	bootLines.push(`${applyDesktopProviderSettings({ home: dataHome, secretBox })}\n`);
	const runtime = await cli.bootstrapSessionRuntime({
		options: { home: dataHome, list: false, rebuildIndex: false, doctor: false },
		output: { write: (text: string) => void bootLines.push(text) },
	});
	registerSettingsIpc({
		home: dataHome,
		secretBox,
		channels: {
			get: CHANNELS.settingsGet,
			save: CHANNELS.settingsSave,
			test: CHANNELS.settingsTest,
			restart: CHANNELS.settingsRestart,
		},
	});

	let window: BrowserWindow | null = null;
	const send = (channel: string, payload: unknown): void => {
		if (window !== null && !window.isDestroyed()) window.webContents.send(channel, payload);
	};
	// 当前会话管理：无活动会话时发话即开新会话；切会话后旧会话的事实自动丢弃（见 session.ts）
	const sessions = createDesktopSessions({
		runtime,
		home: dataHome,
		cwd: BASE_ROOT, // 默认工作区 = 基准根（开发形态=仓库；便携形态=App 所在目录），不随双击时的 cwd 漂移
		callbacks: {
			onReady: (sessionId) => send(PUSH.ready, sessionId),
			onEvent: (card) => send(PUSH.event, card),
			onText: (text) => send(PUSH.text, text),
			onApproval: (view) => send(PUSH.approval, view),
		},
	});

	ipcMain.handle(CHANNELS.meta, () => ({
		home: dataHome,
		guarded: report,
		mode: "interactive (M13b)",
		// 默认模式（与 CLI 同一条解析链：CLI 旗标 > env > 配置文件 > 内置）——renderer 不必自己猜
		agentMode: runtime.defaultMode,
		version: app.getVersion(),
	}));
	ipcMain.handle(CHANNELS.list, () => host.list());
	ipcMain.handle(CHANNELS.read, async (_event, sessionId: unknown) => {
		const id = requireString(sessionId, "sessionId");
		const replay = await host.read(id);
		// 事件 → 卡片的映射**只在 AGENT 侧一处**（`host.ts`），renderer 只做 DOM 组装 ⇒ 两条前端不会各算一份
		return { sessionId: replay.sessionId, cards: toEventCards(replay.events) };
	});
	// 交互路径：全部转给纯 Node 的 session.ts（main 不做业务）
	ipcMain.handle(CHANNELS.prompt, (_event, text: unknown) => {
		sessions.sendPrompt(requireString(text, "prompt"));
		return true;
	});
	ipcMain.handle(CHANNELS.setMode, (_event, mode: unknown) => {
		if (mode !== "plan" && mode !== "build") throw new Error("mode must be plan or build");
		sessions.setMode(mode);
		return true;
	});
	ipcMain.handle(CHANNELS.answerApproval, (_event, choice: unknown) =>
		sessions.answerApproval(requireString(choice, "choice")),
	);
	ipcMain.handle(CHANNELS.interrupt, () => {
		sessions.interrupt();
		return true;
	});
	ipcMain.handle(CHANNELS.newSession, () => {
		sessions.reset();
		return true;
	});
	// M13d-1：续跑一条已记录会话（写入仍只经 persist 单一写入路径）
	ipcMain.handle(CHANNELS.resume, async (_event, sessionId: unknown) => {
		// 边界校验只保证"非空字符串"；语义上的合法性由 persist 的 resume 判定（不存在即抛错）
		await sessions.resume(requireString(sessionId, "sessionId"));
		return true;
	});
	// M13d-3：等价于 CLI 的 `/approvals` + `/policy`——renderer **不自己算**规则，只读 main 给的结论
	ipcMain.handle(CHANNELS.query, () => {
		const policy = runtime.permission.policy();
		return {
			// 会话内沉淀的 `always` 规则（**活的**对象 ⇒ 刚答过就能读到）
			rules: sessions.approvalRules().map((rule) => `${rule.toolName}@${rule.scope}`),
			// 生效的「模式 → 权限」表（文本格式与 `/policy` **同一份实现**，不各写一套）
			policy: AGENT_MODES.map((mode) => ({
				mode,
				rules: policy[mode].map((rule) => cli.describePermissionRule(rule)),
			})),
		};
	});
	// M22：会话改名——**桌面标题**，落 `<数据根>\desktop\session-titles.json`，**不写 JSONL**
	ipcMain.handle(CHANNELS.rename, (_event, sessionId: unknown, title: unknown) => {
		const id = requireString(sessionId, "sessionId");
		if (typeof title !== "string") throw new Error("title must be a string");
		return saveTitle(dataHome, id, title);
	});

	window = new BrowserWindow({
		width: 1100,
		height: 720,
		// 窗口底色跟随系统主题（M20 双主题）：首帧就不会先闪一块和界面相反的颜色
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0d11" : "#f6f7f9",
		title: "Aster",
		show: !selfCheck,
		webPreferences: {
			preload: PRELOAD,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	});

	/** 收尾：先让会话**优雅跑完**（关窗/退出 ≠ 中断回合），再收 MCP 子进程与本地托管。 */
	let shuttingDown = false;
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		await sessions.dispose();
		await runtime.dispose();
		await host.dispose();
		await ui.close();
	};

	if (selfCheck) {
		await runSelfCheck(window, ui.url, sessions, host, bootLines);
		await shutdown();
		app.exit(0);
		return;
	}

	// 装配审计（config/mcp/memory/subagents 行）在页面加载完后送；renderer 的推送监听在脚本顶层就注册好了
	window.webContents.on("did-finish-load", () => send(PUSH.boot, bootLines.join("")));
	await window.loadURL(ui.url);

	window.on("closed", () => {
		void shutdown();
	});
	// Electron 默认会在 window-all-closed 时退出；**注册监听即接管** ⇒ 可以等会话收尾再退（不中断回合）
	app.on("window-all-closed", () => {
		void shutdown().then(() => app.quit());
	});
}

void app.whenReady().then(run);
