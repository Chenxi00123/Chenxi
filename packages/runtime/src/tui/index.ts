/**
 * tui 模块门面（ADR-020）：差分渲染的终端前端。
 *
 * 分层：
 *  - `width`：显示列宽（全角 / 组合字符 / ANSI 感知）——**纯函数**；
 *  - `theme`：深色极简语义配色 + 光标/同步输出等 ANSI 常量——**纯函数**；
 *  - `format`：把**非事实行**（横幅 / 命令输出 / 交互提示）归类上色——**纯函数**
 *    （ADR-023：会话事实改由 `events` 的 `describeEvent` 直接映射，这里只做配色）；
 *  - `diff`：行级差分与整帧 ANSI 组装——**纯函数**（ADR-020 的"只重绘变更区间"）；
 *  - `screen`：帧模型 + 合帧调度（16ms）；
 *  - `input`：按键解码（含 SGR 鼠标 / 括号粘贴）与行编辑——**纯函数**；
 *  - `editor`：多行输入的文本/光标几何（窗口跟随光标、显示列、垂直移动）——**纯函数**（ADR-025）；
 *  - `completion`：Tab 补全（命令 / 参数 / 路径）——**纯函数**（目录列举由调用方注入，ADR-024）；
 *  - `events`：结构化事件/帧 → 屏幕行（ADR-022/023）——**纯函数**（消掉前缀嗅探）；
 *  - `rich-text`：**流式文本通道**的极简 markdown + 工具载荷 → 行（ADR-026）——**纯函数**；
 *  - `spinner`：spinner 帧选择与"忙碌才走"的节拍器（ADR-026）——帧选择是**纯函数**；
 *  - `transcript`：行模型（文本通道 + 结构化事件合流；mode / 会话 id 只认事件）；
 *  - `app`：把上面这些接到既有 `runSessionRepl` 上（前端壳）。
 */

export * from "./app.js";
export * from "./completion.js";
export * from "./diff.js";
export * from "./editor.js";
export * from "./events.js";
export * from "./format.js";
export * from "./input.js";
export * from "./rich-text.js";
export * from "./screen.js";
export * from "./spinner.js";
export * from "./theme.js";
export * from "./transcript.js";
export * from "./width.js";
