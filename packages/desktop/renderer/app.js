/**
 * 桌面版渲染脚本（ADR-029 / 增补 M13b/M13d-1：**可交互** + **可续跑旧会话**；M20：双主题 + 工具栏）。
 *
 * 纪律：**只做 DOM 组装**，不重算任何业务——
 * 事件 → 卡片（role / type / seq / text / meta / mode）的映射在 **main 侧**（`src/host.ts`）**唯一一处**完成；
 * 审批视图同样是 main 侧给出的**结构化字段**（`src/session.ts`）。renderer **不嗅探任何文本**
 * （模式取自卡片的 `mode` 字段，而不是去解析正文）。
 *
 * 无 Node、无网络（CSP `connect-src 'none'`）：唯一外部能力是 `window.aster`（preload 的窄接口）。
 * 主题偏好（`aster.theme`）与折叠状态一样是**纯视图状态**：只落在 localStorage / 闭包里，**绝不进 JSONL**。
 */
const state = {
	/** 当前**显示**的会话 id。 */
	sessionId: "",
	/** main 侧**正在驱动**（活动）的会话 id；为空表示还没有活动会话。 */
	liveId: "",
	cards: [],
	/** 主题偏好："auto"（跟随系统）/ "light" / "dark"——只影响呈现。 */
	theme: "auto",
	/** 当前生效的 agent 模式（来自 `session/start` 或 `mode/changed` 事件）。 */
	mode: "",
	/** 是否在回合中（`turn/start` 到 `turn/end`）——只控制"中断"按钮与忙碌提示。 */
	busy: false,
	/** 是否让视图贴着底部：用户往上滚了就**不再**抢他的滚动位置。 */
	stick: true,
	/** 底栏两段文本：守卫结论（meta 给）与装配审计（boot 推）——各自到达的时机不同，合并渲染。 */
	guarded: "…",
	boot: "",
	/** M22：会话列表全量 + 搜索词（过滤只在视图层做，不重新读盘）。 */
	sessions: [],
	query: "",
};

const THEME_KEY = "aster.theme";
const MAX_PROMPT_HEIGHT = 180;

/** 语义角色 → 界面标签（英文 role 是事实，中文只是**显示**）。 */
const ROLE_LABELS = {
	user: "你",
	assistant: "Aster",
	tool: "工具",
	permission: "审批",
	mode: "模式",
	memory: "记忆",
	session: "会话",
	unknown: "事件",
};

/** 元素工厂（只用 createElement / textContent 组装 DOM，**不注入任何 HTML 字符串** ⇒ 没有注入面）。 */
function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/**
 * 一张卡片 → 一个 DOM 节点（与 `main` 侧的结构化卡片一一对应）。
 *
 * M13d-2：正文多行的卡片（`detail` 非空）**默认折叠**、**点卡头切换**；`defaultFolded` 是 main 侧给的
 * **唯一判据**（前端**不自己算**"多少行才折"）。展开状态只活在这个闭包里 —— **只改视图、不进 JSONL**。
 */
function cardNode(card) {
	const node = el("div", "card");
	node.dataset.role = card.role;
	node.dataset.type = card.type;
	const head = el("div", "card-head");
	head.append(el("span", "role", ROLE_LABELS[card.role] ?? card.role));
	head.append(el("span", "type", card.type));
	head.append(el("span", "seq", `#${card.seq}`));
	if (card.meta) head.append(el("span", "meta", card.meta));
	node.append(head);

	const body = el("div", "body");
	// M22：助手正文按 Markdown 渲染（纯 DOM 构造，零依赖）；其余角色仍是"逐行文本"，
	// 因为用户输入 / 工具输出 / 审计行**不该**被当成 markdown 解释（那是改变事实的呈现）。
	if (card.role === "assistant" && typeof window.renderMarkdown === "function") {
		body.append(window.renderMarkdown(card.text));
	} else {
		for (const line of String(card.text ?? "").split("\n")) body.append(el("div", "line", line));
	}
	node.append(body);

	const detail = typeof card.detail === "string" && card.detail !== "" ? card.detail : null;
	if (detail === null) return node;

	const detailNode = el("div", "detail");
	for (const line of detail.split("\n")) detailNode.append(el("div", "line", line));
	node.append(detailNode);
	node.dataset.foldable = "1";

	const mark = el("span", "fold-mark");
	let expanded = card.defaultFolded !== true;
	const sync = () => {
		node.classList.toggle("folded", !expanded);
		mark.textContent = `${card.lines ?? 0} 行 · ${expanded ? "收起" : "展开"}`;
	};
	head.append(mark);
	head.classList.add("clickable");
	head.addEventListener("click", () => {
		expanded = !expanded;
		sync();
	});
	sync();
	return node;
}

/** 视图是否贴着底部（留 40px 余量：贴底时的抖动不算"用户滚上去了"）。 */
function nearBottom() {
	const stream = document.getElementById("stream");
	return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40;
}

function renderEmpty() {
	const stream = document.getElementById("stream");
	stream.textContent = "";
	const box = el("div", "empty");
	box.append(el("p", "empty-title", "这条会话还没有事件"));
	box.append(el("p", "empty-hint", "输入一条 prompt 开始（会话数据与 CLI / TUI 同一个根）。"));
	stream.append(box);
}

function renderCards() {
	const stream = document.getElementById("stream");
	stream.textContent = "";
	if (state.cards.length === 0) {
		renderEmpty();
		return;
	}
	for (const card of state.cards) stream.append(cardNode(card));
	stream.scrollTop = stream.scrollHeight;
	state.stick = true;
}

function appendCard(card) {
	const stream = document.getElementById("stream");
	const empty = stream.querySelector(".empty");
	if (empty) empty.remove();
	stream.append(cardNode(card));
	// 只在用户本来就贴着底部时跟随；往上滚了就**不抢**他的位置（否则回看历史会被一直拽回底部）
	if (state.stick) stream.scrollTop = stream.scrollHeight;
}

/* ---- 回合内瞬时区（ADR-029 增补 ④）：流式正文进这里，`turn/end` **事件**一到即清 ---- */

function setLive(text) {
	const live = document.getElementById("live");
	live.textContent = text;
	live.hidden = text === "";
	if (state.stick) live.scrollTop = live.scrollHeight;
}

function clearLive() {
	setLive("");
}

/* ---- 回合状态（只影响按钮可用性，不改变任何事实） ---- */

function setBusy(busy) {
	state.busy = busy;
	document.body.classList.toggle("busy", busy);
	const interrupt = document.getElementById("interrupt");
	interrupt.disabled = !busy;
	interrupt.title = busy ? "中断当前回合（合成 SIGINT）" : "当前没有进行中的回合";
}

/* ---- 审批卡 ---- */

function showApproval(view) {
	document.getElementById("approval-detail").textContent = view.detail;
	document.getElementById("approval").hidden = false;
}

function hideApproval() {
	document.getElementById("approval").hidden = true;
}

/* ---- 规则 / 策略面板（M13d-3）：**只读 main 给的结论**，renderer 不自己算规则 ---- */

async function refreshPanel() {
	const data = await window.aster.query();
	const body = document.getElementById("panel-body");
	body.textContent = "";
	body.append(el("li", "panel-section", "审批规则（本会话沉淀）"));
	const rules = data.rules ?? [];
	if (rules.length === 0) {
		body.append(el("li", "muted", "（暂无——答「本次会话始终允许」后会出现在这里）"));
	}
	for (const rule of rules) body.append(el("li", "mono", rule));
	body.append(el("li", "panel-section", "策略（生效的「模式 → 权限」）"));
	for (const entry of data.policy ?? []) {
		body.append(
			el("li", "mono", `${entry.mode}: ${entry.rules.join(" | ") || "(no rule: everything denied)"}`),
		);
	}
}

function togglePanel() {
	const panel = document.getElementById("panel");
	panel.hidden = !panel.hidden;
	if (!panel.hidden) void refreshPanel();
}

/* ---- 主题（只影响呈现；偏好存 localStorage，不进会话文件） ---- */

function effectiveTheme() {
	if (state.theme === "light" || state.theme === "dark") return state.theme;
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
	state.theme = theme;
	document.documentElement.dataset.theme = theme;
	const light = effectiveTheme() === "light";
	const icon = document.getElementById("theme-icon");
	icon.textContent = light ? "☾" : "☀";
	document
		.getElementById("theme-toggle")
		.setAttribute("title", light ? "切换到深色（当前浅色）" : "切换到浅色（当前深色）");
}

function initTheme() {
	let saved = null;
	try {
		saved = localStorage.getItem(THEME_KEY);
	} catch {
		saved = null; // localStorage 不可用（理论上不会）⇒ 就当没存过
	}
	applyTheme(saved === "light" || saved === "dark" ? saved : "auto");
	// 跟随系统：系统主题变了就跟着变（用户显式选过就不跟）
	window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
		if (state.theme === "auto") applyTheme("auto");
	});
}

function toggleTheme() {
	const next = effectiveTheme() === "light" ? "dark" : "light";
	try {
		localStorage.setItem(THEME_KEY, next);
	} catch {
		// 存不下也照样切（只是下次启动回到跟随系统）
	}
	applyTheme(next);
}

/* ---- 模式切换（走既有 `/mode` 命令路径；选中态**只由事件**驱动，不乐观更新） ---- */

function renderMode(mode) {
	state.mode = mode;
	for (const button of document.querySelectorAll("#mode-switch button")) {
		button.setAttribute("aria-pressed", button.dataset.mode === mode ? "true" : "false");
	}
}

/* ---- 会话列表 ---- */

/** 相对时间（纯呈现；绝对时间放 `title` 里，随时可查）。 */
function relativeTime(iso) {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return iso;
	const diff = Date.now() - then;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return iso.slice(0, 10);
}

/** 列表项：主行 = 标题（没标题用 sessionId）、副行 = 内容摘要、操作行 = 恢复 / 改名。 */
function sessionItem(session) {
	const item = el("li");
	item.dataset.id = session.sessionId;
	const row1 = el("div", "row1");
	const label = el("span", session.title ? "title" : "id", session.title ?? session.sessionId);
	label.title = session.title ? `${session.title}\n${session.sessionId}` : session.sessionId;
	row1.append(label);
	const when = el("span", "when", relativeTime(session.updatedAt));
	when.title = session.updatedAt.replace("T", " ").slice(0, 19);
	row1.append(when);
	item.append(row1);

	if (session.preview) item.append(el("div", "preview", session.preview));

	// 操作行：hover / active 才显现（默认不抢视觉）
	const row2 = el("div", "row2");
	// M13d-1：**恢复**（接着跑这条会话）——与 CLI 的 `--resume <sessionId>` 同一份语义
	const resume = el("button", "ghost small", "恢复");
	resume.dataset.action = "resume";
	resume.addEventListener("click", (event) => {
		event.stopPropagation(); // 别触发整行的"只读打开"
		void resumeSession(session.sessionId);
	});
	row2.append(resume);
	// M22：**改名**（桌面标题，不写 JSONL）
	const rename = el("button", "ghost small", "改名");
	rename.dataset.action = "rename";
	rename.addEventListener("click", (event) => {
		event.stopPropagation();
		startRename(item, session);
	});
	row2.append(rename);
	item.append(row2);

	item.addEventListener("click", () => void openSession(session.sessionId));
	return item;
}

/** 行内改名：把主行换成输入框，Enter 提交、Esc 取消、失焦取消（不弹任何对话框）。 */
function startRename(item, session) {
	const row1 = item.querySelector(".row1");
	if (row1 === null) return;
	const input = el("input", "rename-input");
	input.value = session.title ?? "";
	input.placeholder = "输入名称（留空 = 恢复 id）";
	input.maxLength = 60;
	const done = (commit) => {
		if (!item.isConnected) return;
		if (commit) void applyRename(session.sessionId, input.value);
		else void refreshList().then(highlightActive);
	};
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			done(true);
		}
		if (event.key === "Escape") {
			event.preventDefault();
			done(false);
		}
	});
	input.addEventListener("blur", () => done(false));
	input.addEventListener("click", (event) => event.stopPropagation());
	row1.textContent = "";
	row1.append(input);
	input.focus();
	input.select();
}

async function applyRename(sessionId, title) {
	await window.aster.rename(sessionId, title);
	await refreshList();
	highlightActive();
}

function renderList(sessions) {
	state.sessions = sessions;
	drawList();
}

/** 搜索是**纯视图过滤**：不重新读盘、不改任何事实。 */
function drawList() {
	const list = document.getElementById("sessions");
	list.textContent = "";
	if (state.sessions.length === 0) {
		const item = el("li", "empty", "（还没有会话）");
		item.dataset.empty = "1";
		list.append(item);
		return;
	}
	const query = state.query.trim().toLowerCase();
	const filtered =
		query === ""
			? state.sessions
			: state.sessions.filter((session) =>
					`${session.sessionId} ${session.title ?? ""} ${session.preview ?? ""}`
						.toLowerCase()
						.includes(query),
				);
	if (filtered.length === 0) {
		const item = el("li", "empty", `没有匹配「${state.query.trim()}」的会话`);
		item.dataset.empty = "1";
		list.append(item);
		return;
	}
	for (const session of filtered) list.append(sessionItem(session));
}

async function refreshList() {
	const sessions = await window.aster.list();
	renderList(sessions);
}

function highlightActive() {
	for (const item of document.querySelectorAll("#sessions li")) {
		item.classList.toggle("active", item.dataset.id === state.sessionId);
	}
}

/** 让视图**跟着活动会话走**（否则会把别的会话的事实混进当前回放里）；只在确实不是它时才切。 */
function followLive() {
	const live = state.liveId;
	if (live === "" || state.sessionId === live) return;
	state.sessionId = live;
	state.cards = [];
	hideApproval();
	clearLive();
	renderCards();
	highlightActive();
}

/** 打开一条**已记录**会话（只读回放；仍是同一套卡片映射）。 */
async function openSession(sessionId) {
	state.sessionId = sessionId;
	hideApproval();
	clearLive();
	highlightActive();
	const replay = await window.aster.read(sessionId);
	state.cards = replay.cards ?? [];
	renderCards();
}

/* ---- 推送处理（**在脚本顶层订阅**：早于 main 发第一条推送） ---- */

/**
 * 会话句柄就绪。**刻意不在这里读历史**（那会与"实时事实已到达"抢时序 ⇒ 读回来的旧快照会把刚到的事实抹掉）：
 *  - 新会话（第一条 prompt 触发）本就没有历史 ⇒ 清空并跟着它走；
 *  - 要"接着上次"时由 `resumeSession` **先**把历史铺好、**再**让它成为活动会话（见下）。
 */
function onReady(sessionId) {
	state.liveId = sessionId;
	if (state.sessionId !== sessionId) {
		state.sessionId = sessionId;
		state.cards = [];
		hideApproval();
		clearLive();
		renderCards();
	}
	highlightActive();
	document.getElementById("session-id").textContent = sessionId;
	void refreshList().then(highlightActive);
}

/** M13d-1：先只读铺上历史，**再**让这条会话成为活动会话（顺序反过来就有"读到旧快照抹掉新事实"的竞态）。 */
async function resumeSession(sessionId) {
	await openSession(sessionId);
	await window.aster.resume(sessionId);
}

function onEvent(card) {
	followLive();
	// `turn/start` / `turn/end` 是结构化判据（不嗅探文本）：回合边界决定"中断"按钮可用性
	if (card.type === "turn/start") setBusy(true);
	if (card.type === "turn/end") {
		setBusy(false);
		clearLive();
	}
	if (card.type === "session/start" || card.type === "mode/changed") {
		if (card.mode) renderMode(card.mode);
	}
	state.cards.push(card);
	appendCard(card);
	// 刚做的判定会改变「审批规则」——面板开着就顺手刷新（renderer 只读 main 的结论）
	if (card.type === "permission/decision" && document.getElementById("panel").hidden === false) {
		void refreshPanel();
	}
}

function onText(text) {
	setLive(`${document.getElementById("live").textContent}${text}`);
}

function onApproval(view) {
	showApproval(view);
}

function onBoot(text) {
	// 装配审计（config / mcp / memory / subagents）：只作为底栏提示，不在对话流里制造"假事件"
	state.boot = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => line.split(":")[0])
		.join(" / ");
	const guarded = document.getElementById("guarded");
	guarded.title = text.trim();
	renderStatus();
}

function renderStatus() {
	document.getElementById("guarded").textContent =
		state.boot === "" ? state.guarded : `${state.guarded} · 装配 ${state.boot}`;
}

window.aster.onEvent(onEvent);
window.aster.onText(onText);
window.aster.onApproval(onApproval);
window.aster.onReady(onReady);
window.aster.onBoot(onBoot);

/* ---- 模型接入设置（M21）：密钥只在 main 进程解密，界面永远拿不到 ---- */

function settingsStatus(text, kind) {
	const box = document.getElementById("s-status");
	box.hidden = text === "";
	box.textContent = text;
	box.dataset.kind = kind ?? "";
}

function settingsInput() {
	return {
		baseUrl: document.getElementById("s-base-url").value,
		apiKey: document.getElementById("s-api-key").value,
		model: document.getElementById("s-model").value,
	};
}

function closeSettings() {
	document.getElementById("settings").hidden = true;
	settingsStatus("", "");
}

async function openSettings() {
	settingsStatus("", "");
	document.getElementById("settings").hidden = false;
	document.getElementById("s-api-key").value = "";
	const view = await window.aster.getSettings();
	document.getElementById("s-base-url").value = view.baseUrl ?? "";
	document.getElementById("s-model").value = view.model ?? "";
	const bits = [];
	if (view.source === "file") {
		bits.push(view.hasKey ? "已保存密钥（Windows DPAPI 加密）" : "端点已保存，但密钥不可用");
	} else if (view.source === "invalid") {
		bits.push(`设置文件不可用：${view.problem ?? "未知原因"}`);
	} else {
		bits.push("尚未配置（当前回退到环境变量）");
	}
	if (view.encryptionAvailable === false) bits.push("⚠ 当前环境 DPAPI 不可用，保存会被拒绝");
	if (view.problem && view.source !== "invalid") bits.push(view.problem);
	settingsStatus(
		bits.join(" · "),
		view.source === "invalid" || view.encryptionAvailable === false ? "err" : "",
	);
	document.getElementById("s-base-url").focus();
}

async function testSettings() {
	const button = document.getElementById("s-test");
	button.disabled = true;
	settingsStatus("正在请求 /chat/completions…", "");
	try {
		const result = await window.aster.testSettings(settingsInput());
		settingsStatus(result.message, result.ok ? "ok" : "err");
	} catch (error) {
		settingsStatus(`测试失败：${String(error)}`, "err");
	} finally {
		button.disabled = false;
	}
}

async function saveSettings() {
	const result = await window.aster.saveSettings(settingsInput());
	if (!result.ok) {
		settingsStatus(result.error, "err");
		return;
	}
	if (state.busy && !window.confirm("当前回合进行中，重启会中断它。仍要重启？")) {
		settingsStatus("已保存；下次重启应用后生效。", "ok");
		return;
	}
	settingsStatus("已保存，正在重启应用（会话文件不受影响）…", "ok");
	await window.aster.restartApp();
}

async function clearSettings() {
	if (!window.confirm("删除本机保存的模型端点与密钥？删除后回退到环境变量。")) return;
	const result = await window.aster.saveSettings({ baseUrl: "", apiKey: "", model: "" });
	if (!result.ok) {
		settingsStatus(result.error, "err");
		return;
	}
	settingsStatus("已清除，正在重启应用…", "ok");
	await window.aster.restartApp();
}

/* ---- 交互 ---- */

function autosizePrompt() {
	const input = document.getElementById("prompt");
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, MAX_PROMPT_HEIGHT)}px`;
}

function sendPrompt() {
	const input = document.getElementById("prompt");
	const text = input.value.trim();
	if (text === "") return;
	input.value = "";
	autosizePrompt();
	state.stick = true;
	void window.aster.sendPrompt(text);
}

function newSession() {
	void window.aster.newSession();
	state.liveId = "";
	state.sessionId = "";
	state.cards = [];
	hideApproval();
	clearLive();
	setBusy(false);
	renderCards();
	document.getElementById("session-id").textContent = "（尚未开始）";
	highlightActive();
}

function wireInteractions() {
	const form = document.getElementById("composer");
	const input = document.getElementById("prompt");
	// Enter 发送、Shift+Enter 换行（多行经 main 侧编码成**一条** user/message）
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			sendPrompt();
		}
	});
	input.addEventListener("input", autosizePrompt);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		sendPrompt();
	});
	document.getElementById("interrupt").addEventListener("click", () => {
		void window.aster.interrupt();
	});
	document.getElementById("new-session").addEventListener("click", newSession);
	// M22：搜索（输入即过滤；Esc 清空）
	const search = document.getElementById("search");
	search.addEventListener("input", () => {
		state.query = search.value;
		drawList();
		highlightActive();
	});
	search.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			search.value = "";
			state.query = "";
			drawList();
			highlightActive();
		}
	});
	document.getElementById("rules-button").addEventListener("click", togglePanel);
	document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
	// M21：模型接入设置（弹层 + 测试 + 保存后重启）
	document.getElementById("settings-button").addEventListener("click", () => void openSettings());
	document.getElementById("settings-close").addEventListener("click", closeSettings);
	document.getElementById("s-cancel").addEventListener("click", closeSettings);
	document.getElementById("s-test").addEventListener("click", () => void testSettings());
	document.getElementById("s-save").addEventListener("click", () => void saveSettings());
	document.getElementById("s-clear").addEventListener("click", () => void clearSettings());
	document.getElementById("settings").addEventListener("click", (event) => {
		// 点遮罩关闭；点弹层内部不关（遮罩本身就是 .sheet）
		if (event.target.id === "settings") closeSettings();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !document.getElementById("settings").hidden) closeSettings();
	});
	for (const button of document.querySelectorAll("#mode-switch button")) {
		button.addEventListener("click", () => {
			if (button.dataset.mode === state.mode) return;
			// 不乐观更新：选中态等 `mode/changed` 事件回来再变（界面不臆断结果）
			void window.aster.setMode(button.dataset.mode);
		});
	}
	for (const button of document.querySelectorAll("#approval .approval-actions button")) {
		button.addEventListener("click", () => {
			// 乐观隐藏：判定本身仍由 main 侧落 `permission/decision` 事件（界面不臆断结果）
			hideApproval();
			void window.aster.answerApproval(button.dataset.choice);
		});
	}
	document.getElementById("stream").addEventListener("scroll", () => {
		state.stick = nearBottom();
	});
}

async function boot() {
	initTheme();
	wireInteractions();
	setBusy(false);
	const meta = await window.aster.meta();
	renderMode(meta.agentMode ?? "plan");
	document.getElementById("data-dir").textContent = meta.home;
	state.guarded = meta.guarded;
	renderStatus();
	await refreshList();
	// 自检据 `data-ready` 判定"renderer 已经就绪、监听已注册"（不要靠 sleep 猜）
	document.body.dataset.ready = "1";
}

// 出错要**看得见**（否则界面只剩"空的"，无从诊断；自检也据此如实报失败）
boot().catch((error) => {
	const stream = document.getElementById("stream");
	stream.textContent = "";
	const note = el("p", "empty", `加载失败：${String(error)}`);
	stream.append(note);
});
