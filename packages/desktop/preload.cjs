/**
 * preload（**CJS**，且**必须**是 CJS：`sandbox: true` 的 renderer 不支持 ESM preload）。
 *
 * 职责只有一个：用 `contextBridge` 暴露**窄接口**（ADR-029 ③ / 增补 ③）。**频道名与 `src/main.ts` 的
 * `CHANNELS` / `PUSH` 一致**；这是 renderer 能触及 main 的**全部**能力——没有 `ipcRenderer` 裸封装、
 * 没有文件系统、没有 Node。
 *
 * 两条纪律：
 *  - **只增不改**（改动要进 ADR-029；renderer 侧只能看到这里列出的方法）；
 *  - **结构化**：`sendPrompt` / `setMode` / `answerApproval` 传的都是**受控取值**，
 *    renderer **不嗅探任何文本**（事件由 main 侧映射成卡片，见 `src/host.ts`）。
 */
const { contextBridge, ipcRenderer } = require("electron");

/** 推送订阅：只把载荷交给回调，**不把 event 对象**（含 sender）泄漏给 renderer。 */
const subscribe = (channel, callback) => {
	ipcRenderer.on(channel, (_event, payload) => callback(payload));
};

contextBridge.exposeInMainWorld("chenxi", {
	/** 数据根 + 守卫结论 + 版本（界面显示"数据在哪"，也是"绝不碰 C 盘"的可读证据）。 */
	meta: () => ipcRenderer.invoke("chenxi:meta"),
	/** 会话列表（最近更新在前）。 */
	list: () => ipcRenderer.invoke("chenxi:sessions:list"),
	/** 读一条会话的**已记录事件**（只读回放）。 */
	read: (sessionId) => ipcRenderer.invoke("chenxi:sessions:read", sessionId),

	/** 发一条 prompt（无活动会话时 main 侧**自动开一条新会话**；写入仍只经 persist 单一写入路径）。 */
	sendPrompt: (text) => ipcRenderer.invoke("chenxi:prompt", text),
	/** 切换模式（plan|build；走既有 `/mode` 命令路径 ⇒ 落 `mode/changed` 事件）。 */
	setMode: (mode) => ipcRenderer.invoke("chenxi:mode", mode),
	/** 作答当前审批（once|always|reject）；无待决审批时返回 false。 */
	answerApproval: (choice) => ipcRenderer.invoke("chenxi:approval", choice),
	/** 中断当前回合（合成 SIGINT，与 TUI 同法）。 */
	interrupt: () => ipcRenderer.invoke("chenxi:interrupt"),
	/** 收掉当前会话（EOF，**不**中断回合）；下次发话再开新的。 */
	newSession: () => ipcRenderer.invoke("chenxi:new"),
	/** **续跑**一条已记录会话（与 CLI `--resume <sessionId>` 同一份语义）：新 prompt 落进同一条 JSONL。 */
	resume: (sessionId) => ipcRenderer.invoke("chenxi:resume", sessionId),
	/** 本会话的审批规则 + 生效的「模式 → 权限」策略（等价于 CLI 的 `/approvals` 与 `/policy`）。 */
	query: () => ipcRenderer.invoke("chenxi:query"),

	/** M21 模型接入设置：读（**只回 hasKey，不回密钥**）、存（密文落盘）、测连通、重启生效。 */
	getSettings: () => ipcRenderer.invoke("chenxi:settings:get"),
	saveSettings: (input) => ipcRenderer.invoke("chenxi:settings:save", input),
	testSettings: (input) => ipcRenderer.invoke("chenxi:settings:test", input),
	restartApp: () => ipcRenderer.invoke("chenxi:settings:restart"),
	/** M22 会话改名（桌面标题，**不写 JSONL**）；空标题 = 恢复显示 sessionId。 */
	rename: (sessionId, title) => ipcRenderer.invoke("chenxi:sessions:rename", sessionId, title),

	/** 一条**已记录**事件的结构化卡片 `{role,type,seq,text,meta}`。 */
	onEvent: (callback) => subscribe("chenxi:push:event", callback),
	/** 文本通道（横幅 / 流式正文 / `[assistant stopped]` / 错误）。 */
	onText: (callback) => subscribe("chenxi:push:text", callback),
	/** 需要用户审批：结构化视图 `{toolName,scope,mode,reason,detail}`。 */
	onApproval: (callback) => subscribe("chenxi:push:approval", callback),
	/** 会话句柄就绪（真实 sessionId）。 */
	onReady: (callback) => subscribe("chenxi:push:ready", callback),
	/** 装配审计（config / mcp / memory / subagents 行）。 */
	onBoot: (callback) => subscribe("chenxi:boot", callback),
});
