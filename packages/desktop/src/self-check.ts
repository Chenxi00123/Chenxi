/**
 * `--self-check` 的端到端自检（从 `main.ts` 拆出，见架构门禁的 400 行上限）。
 *
 * 只在**真窗口**里做事：按固定脚本读 DOM、点真实按钮、断言"事件真的变成了界面"。
 * 它**不写业务**：发 prompt / resume / 切模式全部走 `sessions` 的既有入口（单一写入路径）。
 */
import type { BrowserWindow } from "electron";
import { app } from "electron";
import { pollDom } from "./dom-probe.js";
import { type DesktopHost, toEventCards } from "./host.js";
import type { DesktopSessions } from "./session.js";

/** 端到端自检：在 renderer 里断言 DOM（列表 + 卡片），并**真的发一条 prompt** 看卡片增加。 */
export async function runSelfCheck(
	window: BrowserWindow,
	url: string,
	sessions: DesktopSessions,
	host: DesktopHost,
	bootLines: readonly string[],
): Promise<void> {
	const failures: string[] = [];
	// renderer 侧的报错要能看到（否则自检失败时只剩"没渲染"这种无从下手的结论）
	window.webContents.on("console-message", (_event, level, message) => {
		if (level >= 2) process.stderr.write(`renderer-console[${level}] ${message}\n`);
	});
	window.webContents.on("preload-error", (_event, preloadPath, error) => {
		process.stderr.write(`preload-error ${preloadPath}: ${String(error)}\n`);
	});
	await window.loadURL(url);

	const readDom = `(() => {
		const meta = document.querySelector("#data-dir");
		const failure = document.querySelector("#stream .empty");
		return {
			rows: document.querySelectorAll("#sessions li[data-id]").length,
			cards: document.querySelectorAll("#stream .card").length,
			user: document.querySelectorAll('#stream .card[data-role="user"]').length,
			csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null,
			// M13d-2：可折叠的工具结果卡（data-foldable）——这是"折叠真的渲染出来"的可断言形态
			foldable: document.querySelectorAll('#stream .card[data-foldable="1"]').length,
			// M13d-3：规则/策略面板的行数（等价于 /approvals 与 /policy 的可见形态）
			panel: document.querySelectorAll("#panel-body li").length,
			home: meta ? meta.textContent : "",
			boot: document.body.dataset.ready === "1",
			note: failure ? failure.textContent : "",
			// M20：双主题 + 模式工具栏的可断言形态（都只是呈现层，不改变任何事实）
			theme: document.documentElement.dataset.theme || "",
			themeStored: (() => {
				try { return localStorage.getItem("chenxi.theme") || ""; } catch { return ""; }
			})(),
			modes: document.querySelectorAll("#mode-switch button").length,
			modePressed: Array.from(document.querySelectorAll('#mode-switch button[aria-pressed="true"]'))
				.map((button) => button.dataset.mode)
				.join(","),
			modeCards: document.querySelectorAll('#stream .card[data-type="mode/changed"]').length,
			// M21：模型接入设置弹层（只是界面；密钥永远不在这里）
			settingsOpen: document.getElementById("settings").hidden === false,
			settingsFields: document.querySelectorAll("#settings .field input").length,
			// M22：搜索 / 预览 / 改名（都是视图层；标题落桌面配置，不进 JSONL）
			search: document.getElementById("search") !== null,
			titleText:
				document.querySelector("#sessions .title")?.textContent ??
				document.querySelector("#sessions .id")?.textContent ??
				"",
			previews: document.querySelectorAll("#sessions .preview").length,
		};
	})()`;

	// ① 等 renderer 完成 boot（它注册好推送监听后才会置 data-ready）
	let probe = await pollDom(window, readDom, (p) => p.boot, 15000);
	if (!probe.boot) failures.push("renderer did not finish boot");
	if (!probe.csp) failures.push("CSP meta missing in renderer");
	// 「绝不碰 C 盘」的可断言形态：界面上显示的数据根**必须**在仓库所在盘（不接受 C 盘，也不接受空）
	if (probe.home.trim() === "") failures.push("data dir not shown");
	else if (/^c:/i.test(probe.home.trim()))
		failures.push(`data dir is on the C drive: ${probe.home}`);

	// ② **真的发一条 prompt**（无模型端点也成立：`user/message` 是事实，照落卡片）
	sessions.sendPrompt("desktop self-check ping");
	probe = await pollDom(window, readDom, (p) => p.user > 0, 15000);
	if (probe.user === 0)
		failures.push(
			`prompt did not produce a user card${probe.note === "" ? "" : ` (${probe.note})`}`,
		);
	if (probe.rows === 0) failures.push("session list did not render the new session");
	if (probe.cards === 0) failures.push("event cards did not render");

	// ③ **续跑同一条会话**（M13d-1）：先收掉它（EOF），再 `resume` **同一个 id**，然后发第二条 prompt
	// ⇒ 新事实落进**同一条 JSONL**（seq 继续、同一 sessionId）。这是"恢复旧会话"在真窗口里的可断言形态。
	const firstId = sessions.activeSessionId();
	let resumedId: string | null = null;
	let userAfterResume = probe.user;
	if (firstId === null) {
		failures.push("no active session id to resume");
	} else {
		const userBeforeResume = probe.user;
		sessions.reset();
		await sessions.resume(firstId);
		sessions.sendPrompt("desktop self-check resume ping");
		probe = await pollDom(window, readDom, (p) => p.user > userBeforeResume, 15000);
		resumedId = sessions.activeSessionId();
		userAfterResume = probe.user;
		if (resumedId !== firstId) {
			failures.push(
				`resume did not continue the same session (${firstId} -> ${String(resumedId)})`,
			);
		}
		if (userAfterResume <= userBeforeResume)
			failures.push("resumed session did not record the second prompt");
	}

	// 记下报告口径（④ 会切到别的会话视图，别让它把这些数字覆盖掉）
	const promptRows = probe.rows;
	const promptCards = probe.cards;
	const promptUser = probe.user;

	// ④ **折叠**（M13d-2）：回放一条含**多行工具结果**的已记录会话，断言"折叠卡"在真 DOM 里真的渲染出来。
	// 这一步同时证明：工具结果**按载荷本身**渲染（对象走 JSON 缩进，不再是 "[object Object]"）。
	let folded = false;
	let foldableId: string | null = null;
	for (const summary of await host.list()) {
		const replay = await host.read(summary.sessionId);
		if (toEventCards(replay.events).some((card) => card.defaultFolded === true)) {
			foldableId = summary.sessionId;
			break;
		}
	}
	if (foldableId === null) {
		failures.push("no recorded session with a foldable tool result (seed one with a tool call)");
	} else {
		await window.webContents.executeJavaScript(
			`document.querySelector('#sessions li[data-id="${foldableId}"]').click()`,
			true,
		);
		probe = await pollDom(window, readDom, (p) => p.foldable > 0, 15000);
		folded = probe.foldable > 0;
		if (!folded) failures.push("foldable tool result card did not render");
	}

	// ⑤ **规则 / 策略面板**（M13d-3）：点一下按钮，断言真 DOM 里出现了行（等价于 `/approvals` + `/policy`）
	await window.webContents.executeJavaScript(
		`document.getElementById("rules-button").click()`,
		true,
	);
	probe = await pollDom(window, readDom, (p) => p.panel > 0, 15000);
	const panelRows = probe.panel;
	if (panelRows === 0) failures.push("rules/policy panel did not render");

	// ⑥ **双主题**（M20）：工具栏按钮真的切换 ⇒ `data-theme` 变了、偏好落进 localStorage（只是呈现）
	probe = await pollDom(window, readDom, (p) => p.modes === 2, 15000);
	if (probe.modes !== 2) failures.push("mode switch buttons missing");
	const themeBefore = probe.theme;
	await window.webContents.executeJavaScript(
		`document.getElementById("theme-toggle").click()`,
		true,
	);
	probe = await pollDom(
		window,
		readDom,
		(p) => p.theme !== themeBefore && p.themeStored !== "",
		15000,
	);
	const themeAfter = probe.theme;
	const themeStored = probe.themeStored;
	if (themeAfter === themeBefore) failures.push(`theme did not toggle (${themeBefore})`);
	if (themeStored === "") failures.push("theme preference not persisted");

	// ⑦ **模式工具栏**（M20）：点非当前模式 ⇒ 走既有 `/mode` 路径落 `mode/changed`，选中态**由事件驱动**
	const modeBefore = probe.modePressed;
	const targetMode = modeBefore === "plan" ? "build" : "plan";
	await window.webContents.executeJavaScript(
		`document.querySelector('#mode-switch button[data-mode="${targetMode}"]').click()`,
		true,
	);
	probe = await pollDom(
		window,
		readDom,
		(p) => p.modePressed === targetMode && p.modeCards > 0,
		15000,
	);
	const modeAfter = probe.modePressed;
	if (modeAfter !== targetMode)
		failures.push(`mode switch did not take effect (${modeBefore} -> ${modeAfter})`);
	if (probe.modeCards === 0)
		failures.push("mode change did not produce a recorded mode/changed card");

	// ⑧ **模型接入设置弹层**（M21）：打开 ⇒ 三个字段出现；关掉。只验证界面，不保存（保存会重启）
	await window.webContents.executeJavaScript(
		`document.getElementById("settings-button").click()`,
		true,
	);
	probe = await pollDom(window, readDom, (p) => p.settingsOpen && p.settingsFields === 3, 15000);
	if (!probe.settingsOpen) failures.push("settings sheet did not open");
	if (probe.settingsFields !== 3)
		failures.push(`settings fields = ${probe.settingsFields} (expected 3)`);
	await window.webContents.executeJavaScript(`document.getElementById("s-cancel").click()`, true);
	probe = await pollDom(window, readDom, (p) => !p.settingsOpen, 15000);
	if (probe.settingsOpen) failures.push("settings sheet did not close");

	// ⑨ **搜索 + 改名**（M22）：输入不存在的词 ⇒ 列表清空；改名 ⇒ 主行变成标题（标题只落桌面配置）
	probe = await pollDom(window, readDom, (p) => p.search, 15000);
	if (!probe.search) failures.push("search box missing");
	// 搜索前的快照要**先存**：过滤后列表为空，就再也读不到 preview 了（这里是先前取错的坑）
	const previews = probe.previews;
	await window.webContents.executeJavaScript(
		`(() => {
			const input = document.getElementById("search");
			input.value = "zzz-no-such-session";
			input.dispatchEvent(new Event("input"));
		})()`,
		true,
	);
	probe = await pollDom(window, readDom, (p) => p.rows === 0, 15000);
	const searchFiltered = probe.rows === 0;
	if (!searchFiltered) failures.push(`search did not filter (${probe.rows} rows left)`);
	await window.webContents.executeJavaScript(
		`(() => {
			const input = document.getElementById("search");
			input.value = "";
			input.dispatchEvent(new Event("input"));
		})()`,
		true,
	);
	probe = await pollDom(window, readDom, (p) => p.rows > 0, 15000);
	if (probe.rows === 0) failures.push("clearing search did not restore the list");

	const renameTo = "self-check 改名";
	await window.webContents.executeJavaScript(
		`(() => {
			const item = document.querySelector("#sessions li[data-id]");
			item.querySelector('button[data-action="rename"]').click();
			const input = item.querySelector(".rename-input");
			input.value = ${JSON.stringify(renameTo)};
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		})()`,
		true,
	);
	probe = await pollDom(window, readDom, (p) => p.titleText === renameTo, 15000);
	const renamed = probe.titleText === renameTo;
	if (!renamed) failures.push(`rename did not apply (title=${probe.titleText})`);

	process.stderr.write(
		`SELFCHECK ${JSON.stringify({
			ok: failures.length === 0,
			failures,
			rows: promptRows,
			cards: promptCards,
			user: promptUser,
			resumed: resumedId === firstId && resumedId !== null,
			userAfterResume,
			folded,
			panel: panelRows,
			theme: `${themeBefore} -> ${themeAfter}`,
			themeStored,
			mode: `${modeBefore} -> ${modeAfter}`,
			settings: `${probe.settingsFields} fields`,
			search: searchFiltered,
			renamed,
			previews,
			provider: bootLines.find((line) => line.startsWith("desktop settings")) ?? "",
			home: probe.home,
			bootLines: bootLines.length,
		})}\n`,
	);
	if (failures.length > 0) app.exit(3);
}
