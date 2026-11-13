/**
 * renderer 的 DOM 轮询探针（从 `main.ts` 拆出，见架构门禁的 400 行上限）。
 *
 * 只服务 `--self-check`：在**真窗口**里按固定脚本取一份 DOM 快照，直到某个条件成立（或超时）。
 * 之所以独立成模块：它只依赖 `BrowserWindow.webContents.executeJavaScript`，与 main 的窗口/IPC
 * 接线无关，单独放着更清楚。
 */
import type { BrowserWindow } from "electron";

/** renderer 的 DOM 快照（自检用）。 */
export interface SelfCheckProbe {
	rows: number;
	cards: number;
	user: number;
	csp: boolean;
	foldable: number;
	panel: number;
	home: string;
	boot: boolean;
	note: string;
	/** M20：`auto` / `light` / `dark`（`<html data-theme>`；只是呈现，不进会话文件）。 */
	theme: string;
	/** M20：落盘的偏好（localStorage `chenxi.theme`）。 */
	themeStored: string;
	/** M20：模式工具栏按钮数（应为 2：plan / build）。 */
	modes: number;
	/** M20：当前被标记为选中的模式（只由 `session/start` / `mode/changed` 事件驱动）。 */
	modePressed: string;
	/** M20：当前视图里可见的 `mode/changed` 卡片数。 */
	modeCards: number;
	/** M21：模型接入设置弹层是否打开。 */
	settingsOpen: boolean;
	/** M21：弹层里的字段数（Base URL / API Key / 模型 = 3）。 */
	settingsFields: number;
	/** M22：搜索框是否存在。 */
	search: boolean;
	/** M22：列表第一项的主行文本（有标题时是标题，否则是 sessionId）。 */
	titleText: string;
	/** M22：列表里的内容摘要行数（有 preview 的会话才会渲染）。 */
	previews: number;
}

/** 轮询 renderer 的 DOM 直到条件成立（或超时），返回最后一次快照。 */
export async function pollDom(
	window: BrowserWindow,
	script: string,
	done: (probe: SelfCheckProbe) => boolean,
	timeoutMs: number,
): Promise<SelfCheckProbe> {
	const deadline = Date.now() + timeoutMs;
	let last: SelfCheckProbe = {
		rows: 0,
		cards: 0,
		user: 0,
		csp: false,
		foldable: 0,
		panel: 0,
		home: "",
		boot: false,
		note: "",
		theme: "",
		themeStored: "",
		modes: 0,
		modePressed: "",
		modeCards: 0,
		settingsOpen: false,
		settingsFields: 0,
		search: false,
		titleText: "",
		previews: 0,
	};
	while (Date.now() < deadline) {
		last = (await window.webContents.executeJavaScript(script, true)) as SelfCheckProbe;
		if (done(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return last;
}
