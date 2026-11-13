/**
 * TUI 应用（ADR-020 / ADR-023）：把键盘输入与屏幕渲染接到**既有 `runSessionRepl`** 上。
 *
 * 两个适配器（这就是"前端只负责渲染"的全部机制）：
 *  - **输入适配器**：自建 `Readable`，把"按回车"变成一行文本推给 REPL。
 *    于是 `/命令`、审批问答（REPL 用"下一行输入"当答案）**全部照旧**走同一条路径；
 *  - **输出适配器**：**两条来源**合到同一个行模型（`tui/transcript.ts`）——
 *    ① 文本通道（`Output`）：横幅 / 命令输出 / **流式 assistant 正文** / 交互提示；
 *    ② **结构化事件**（`onEvent`）：会话事实按 `describeEvent` 直接映射（不再前缀嗅探）。
 *    为此 `runSessionRepl` 收到 `trace: false`：**已有事件的事实不再打印文本轨迹**（不然会两遍）。
 *
 * ADR-023 消掉的两处启发式：状态条的 `mode` / 会话 id **不再回读横幅**
 * （分别来自 `mode/changed` 事件与 `onSessionReady`）。
 *
 * ADR-024（M10b-2）起还接了**交互**：
 *  - **Tab 补全**（`tui/completion.ts`）：命令 / 命令参数 / 路径；候选多于 1 时**列出来**（不替用户猜）；
 *  - **鼠标**：滚轮滚动、**左键点在输入区**按 (行,列) 定位插入点（只上报点击/滚轮，**不跟踪拖拽** ⇒ 原生选中不受影响）。
 *
 * ADR-025（M10b-3）起输入区可以**多行**（`tui/editor.ts` 管几何）：
 *  - **换行**：`Ctrl+J` / `Alt+Enter`（终端若上报 Shift+Enter 也认）；`Enter` 提交**整份草稿**；
 *  - **括号粘贴**（`?2004h`）：粘贴多行**原样插入**，不会被当成一串回车逐行提交；
 *  - 上/下键先在**草稿内**移动，到边界才翻历史；**草稿以哨兵编码换行**后交给 readline（见 `NEWLINE_ESCAPE`）；
 *  - `Ctrl+U` 沿用"清空整个输入"（= 丢弃整份草稿）。
 *
 * ADR-026（M10b-4）起还是**富文本前端**：
 *  - **流式正文**走 `rich-text`（极简 markdown：标题 / 列表 / 代码框 / 行内代码）；
 *  - **工具结果默认折叠**（`← tool_result: read ok · 5 行 · 3ms · 折叠`）——
 *    **左键点该行**切换这一条、**`Ctrl+O`** 全部展开 / 收起（折叠是**视图状态**，不入 JSONL）；
 *  - **回合内指示**：状态条按**本机时钟**显示 `◐ 1.3s (local)`（忙碌判据是"`turn/start` 之后未见 `turn/end`"）；
 *    节拍只在忙碌时存在（`tui/spinner.ts`），空闲不空转。
 *
 * 其它纪律：
 *  - **Ctrl+C = 合成 `process.emit("SIGINT")`**：raw 模式下终端不再发信号，而 REPL 已经把
 *    "一次中止回合 / 拒绝审批 / 二次退出"的语义注册在 SIGINT 上——合成即可**精确复用**；
 *  - **Ctrl+D = EOF**（推 `null`），让 readline 关闭 -> REPL 正常收尾（落 `session/end`）；
 *  - **alt screen 严格还原**：进入/离开都写在 `finally`，并额外监听 `exit` 兜底，
 *    绝不让用户把终端留在备用屏里；
 *  - 渲染是**合帧**的（16ms），但输入回显**立即 flush**（打字必须跟手）。
 */
import { Readable } from "node:stream";
import { DEFAULT_AGENT_MODE } from "@aster/schema";
import {
	NEWLINE_ESCAPE,
	REPL_COMMANDS,
	type RunReplOptions,
	type RunReplResult,
	runSessionRepl,
} from "../cli/repl.js";
import { complete, createPathLister } from "./completion.js";
import { charIndexAtColumn, layoutEditor, lineStarts, moveVertical } from "./editor.js";
import { applyEdit, createKeyDecoder, type EditState, type KeyEvent } from "./input.js";
import {
	createScreen,
	maxInputRows,
	PROMPT_WIDTH,
	type Screen,
	type Sink,
	type StatusFacts,
	transcriptIndexAt,
} from "./screen.js";
import { busyFacts, createSpinnerTicker } from "./spinner.js";
import { ansi, createTheme, type Theme } from "./theme.js";
import { createTranscript } from "./transcript.js";

const ENTER_ALT_SCREEN = "\u001b[?1049h";
const LEAVE_ALT_SCREEN = "\u001b[?1049l";
/** 历史记录上限（只影响上/下翻，不影响会话事实）。 */
const HISTORY_LIMIT = 200;
/** 鼠标滚轮一格滚动的行数。 */
const WHEEL_STEP = 3;

/** 键来源：缺省 `process.stdin`；测试可注入（只要有 `on/off` 即可）。 */
export interface KeySource {
	on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
	off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
	readonly setRawMode?: (mode: boolean) => void;
}

export interface SizeSource {
	on(event: "resize", listener: () => void): unknown;
	off(event: "resize", listener: () => void): unknown;
	readonly columns?: number;
	readonly rows?: number;
}

export interface TuiSessionOptions extends RunReplOptions {
	/** 渲染目标（缺省 `process.stdout`）。 */
	readonly sink?: Sink & SizeSource;
	/** 按键来源（缺省 `process.stdin`）。 */
	readonly keys?: KeySource;
	/** 主题（缺省按环境探测：`NO_COLOR` / `COLORTERM`）。 */
	readonly theme?: Theme;
	/** 合帧窗口（缺省 16ms；测试传 0 以同步渲染）。 */
	readonly intervalMs?: number;
	/** 本地时钟（ADR-026：回合耗时是**本地测量**；测试可注入以确定化 spinner）。缺省 `Date.now`。 */
	readonly now?: () => number;
}

/** 环境是否支持 TUI（两个流都必须是 TTY；否则明确回落朴素 REPL，不假装）。 */
export function isTuiSupported(): boolean {
	return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/** 输入适配器：把"按回车"变成一行，交给 REPL 的 readline。 */
function createLineStream(): {
	stream: Readable;
	pushLine: (line: string) => void;
	eof: () => void;
} {
	const stream = new Readable({
		read() {
			// 输入由按键驱动（下面 push），无需实现
		},
	});
	return {
		stream,
		// 多行草稿：换行先编码成哨兵（readline 会按 `\n` 切行）——见 `NEWLINE_ESCAPE`
		pushLine: (line) => {
			stream.push(`${line.split("\n").join(NEWLINE_ESCAPE)}\n`);
		},
		eof: () => {
			stream.push(null);
		},
	};
}

/**
 * 运行一次 TUI 会话。返回与 `runSessionRepl` 相同的 `{ sessionId, eventCount }`。
 * `runSessionRepl` 的**全部语义**（命令 / 记忆缝 / 审批 / SIGINT / `session/end`）原样生效。
 */
export async function runTuiSession(options: TuiSessionOptions): Promise<RunReplResult> {
	const theme = options.theme ?? createTheme();
	const sink: Sink & SizeSource = options.sink ?? (process.stdout as unknown as Sink & SizeSource);
	const keys: KeySource = options.keys ?? (process.stdin as unknown as KeySource);
	const columns = (): number => (Number(sink.columns) > 0 ? Number(sink.columns) : 80);
	const rows = (): number => (Number(sink.rows) > 0 ? Number(sink.rows) : 24);
	const size = (): { columns: number; rows: number } => ({ columns: columns(), rows: rows() });
	const now = options.now ?? Date.now;

	// 行模型（ADR-023）：文本通道 + 结构化事件；mode / 会话 id 都**只认事件，不回读横幅**
	// ADR-026：文本通道开**富文本**、工具结果**默认折叠**（`expanded` 由行模型自己持有）
	const transcript = createTranscript({
		theme,
		mode: options.mode ?? DEFAULT_AGENT_MODE,
		rich: true,
		now,
		// ⚠️ 状态条事实（mode / 会话 id）**来自事件** ⇒ 每次行模型变化都要同步进屏幕状态，
		// 否则状态条会一直显示旧 mode（旧实现靠"下一次按键才 syncState"而滞后）。
		onChange: () => {
			screen.update({ status: status(), transcript: transcript.lines });
			screen.requestRender();
		},
		// assistant 正文走**流式文本通道**、回合收尾另有 `[assistant stopped: …]` 文本行
		describe: { assistantContent: false, turnEnd: false, collapse: true },
	});
	const status = (): StatusFacts => ({
		mode: transcript.mode,
		cwd: options.cwd ?? process.cwd(),
		sessionId: transcript.sessionId,
		...(options.model === undefined ? {} : { model: options.model }),
		// 忙碌事实是**本地测量**（`(local)` 会显示在状态条上）；空闲时干脆不出现这个字段
		...(transcript.turnStartedAt === undefined
			? {}
			: { busy: busyFacts(transcript.turnStartedAt, now) }),
	});

	const screen: Screen = createScreen({
		sink,
		theme,
		size,
		intervalMs: options.intervalMs,
		initial: {
			status: status(),
			transcript: transcript.lines,
			input: "",
			caret: 0,
			scrollOffset: 0,
		},
	});

	const lineStream = createLineStream();
	const decoder = createKeyDecoder();
	const pathLister = createPathLister();
	const history: string[] = [];
	let historyIndex = -1;
	let editing: EditState = { text: "", caret: 0 };
	let scrollOffset = 0;

	const syncState = (): void => {
		screen.update({
			transcript: transcript.lines,
			input: editing.text,
			caret: editing.caret,
			scrollOffset,
			status: status(),
		});
	};

	// 回合内指示（ADR-026）：忙碌时起节拍、`turn/end` 后停（空闲不空转）；
	// 每次 tick 只推一次"合帧重绘"（与流式输出共用 16ms 窗口，不逐帧硬刷）
	const spinner = createSpinnerTicker({
		busy: () => transcript.busy,
		onTick: () => {
			syncState();
			screen.requestRender();
		},
	});

	const onKey = (event: KeyEvent): void => {
		switch (event.kind) {
			case "interrupt":
				// 合成 SIGINT：REPL 按自己的语义处理（中止回合 / 拒绝审批 / 二次退出）
				process.emit("SIGINT");
				return;
			case "toggle-tools":
				// 全部展开 / 收起工具结果（ADR-026）：没有可展开的内容时**什么都不做**
				if (transcript.toggleAll()) {
					syncState();
					screen.flush();
				}
				return;
			case "eof":
				lineStream.eof();
				return;
			case "enter": {
				const line = editing.text;
				history.push(line);
				if (history.length > HISTORY_LIMIT) history.shift();
				historyIndex = -1;
				editing = { text: "", caret: 0 };
				scrollOffset = 0;
				// **不回显**用户那一行：`user/message` 是**事实**，由事件渲染（ADR-023），
				// 否则同一句话会出现两遍（回显 + 事件）。
				syncState();
				screen.flush(); // 输入框清空必须立刻可见
				lineStream.pushLine(line);
				return;
			}
			case "up":
			case "down": {
				// **多行草稿优先在草稿内移动**；已在草稿的上下边界才翻历史（ADR-025）
				const moved = moveVertical(editing.text, editing.caret, event.kind === "up" ? -1 : 1);
				if (moved !== undefined) {
					editing = { ...editing, caret: moved };
					break;
				}
				if (history.length === 0) return;
				if (event.kind === "up") {
					historyIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
				} else if (historyIndex !== -1) {
					// Down 走到最新一条之后再按 = 清空输入（常规 shell 行为）
					historyIndex = historyIndex + 1 >= history.length ? -1 : historyIndex + 1;
				}
				const line = historyIndex === -1 ? "" : (history[historyIndex] ?? "");
				editing = { text: line, caret: [...line].length };
				break;
			}
			case "newline":
				// 换行：草稿内插入 `\n`（Ctrl+J / Alt+Enter / 终端若上报的 Shift+Enter）
				editing = applyEdit(editing, { kind: "text", text: "\n" });
				break;
			case "paste":
				// 括号粘贴：整段插入（**换行原样保留**，不会被当成回车逐行提交）
				editing = applyEdit(editing, { kind: "text", text: event.text });
				break;
			case "page-up":
				scrollOffset += Math.max(1, Math.floor(rows() / 2));
				break;
			case "page-down":
				scrollOffset = Math.max(0, scrollOffset - Math.max(1, Math.floor(rows() / 2)));
				break;
			case "mouse":
				onMouse(event);
				return;
			case "complete": {
				// Tab 补全（命令 / 路径）；候选多于 1 时把候选**列出来**（不猜用户想要哪个）
				const result = complete({
					input: editing.text,
					caret: editing.caret,
					cwd: options.cwd ?? process.cwd(),
					commands: REPL_COMMANDS,
					listDir: pathLister,
				});
				editing = { text: result.text, caret: result.caret };
				if (result.candidates.length > 0) {
					transcript.notice(`  candidates: ${result.candidates.join("  ")}`);
				}
				break;
			}
			default:
				editing = applyEdit(editing, event);
				break;
		}
		syncState();
		screen.flush(); // 输入回显要跟手：立即画
	};

	/**
	 * 鼠标（ADR-024 / ADR-025 / ADR-026）：滚轮滚动、左键点在**输入区**按 (行,列) 定位插入点、
	 * 左键点在**工具结果行**切换该条的展开。只处理**按下**（滚轮也只发按下）。
	 */
	const onMouse = (event: KeyEvent & { kind: "mouse" }): void => {
		if (!event.pressed) return;
		if (event.button === 64 || event.button === 65) {
			scrollOffset =
				event.button === 64 ? scrollOffset + WHEEL_STEP : Math.max(0, scrollOffset - WHEEL_STEP);
		} else if (event.button === 0) {
			// 落在**输入区**的哪一行、哪一列？（与 `compose` 用同一套窗口算法）
			const layout = layoutEditor(editing.text, editing.caret, { maxRows: maxInputRows(rows()) });
			const top = rows() - layout.lines.length;
			if (event.y < top) {
				// 点在**转录区**（ADR-026）：命中工具结果行则切换该条展开；其它行**不处理**
				const index = transcriptIndexAt(screen.state, rows(), event.y);
				const seq = index === undefined ? undefined : transcript.eventSeqAt(index);
				if (seq === undefined || !transcript.toggle(seq)) return;
				syncState();
				screen.flush();
				return;
			}
			const visibleRow = Math.min(event.y - top, layout.lines.length - 1);
			const logical = layout.firstVisible + visibleRow;
			const lines = editing.text.split("\n");
			const text = lines[logical];
			if (text === undefined) return;
			const start = lineStarts(lines)[logical] ?? 0;
			const column = Math.max(0, event.x - 1 - PROMPT_WIDTH);
			editing = { ...editing, caret: start + charIndexAtColumn(text, column) };
		} else {
			return; // 其余按钮不处理（不改变屏幕）
		}
		syncState();
		screen.flush();
	};

	const onData = (chunk: Buffer | string): void => {
		for (const event of decoder.push(chunk)) onKey(event);
	};
	const onResize = (): void => {
		syncState();
		screen.flush();
	};

	sink.write(`${ENTER_ALT_SCREEN}${ansi.showCursor}${ansi.enableMouse}${ansi.enablePaste}`);
	const restore = (): void => {
		// 离开前先**关掉鼠标上报与括号粘贴**（否则终端会把它们一直发给一个已经退出的程序）
		sink.write(`${ansi.endSync}${ansi.disableMouse}${ansi.disablePaste}${LEAVE_ALT_SCREEN}`);
	};
	process.once("exit", restore);

	keys.on("data", onData);
	sink.on("resize", onResize);
	keys.setRawMode?.(true);

	syncState();
	screen.flush(); // 首帧

	try {
		const result = await runSessionRepl({
			...options,
			input: lineStream.stream,
			output: transcript.output,
			// 结构化事件 → 行（并把继承来的订阅者一起喂到：`--tui --serve` 同时要发 SSE）
			onEvent: (event) => {
				options.onEvent?.(event);
				transcript.renderEvent(event);
				spinner.sync(); // 回合开始 / 结束 ⇒ 起停节拍（结构化判据，不嗅探文本）
			},
			// 会话 id 走结构化通道（`onSessionReady`），**不回读** `session:` 横幅
			onSessionReady: (sessionId) => {
				transcript.setSessionId(sessionId);
				options.onSessionReady?.(sessionId);
			},
			// 已有事件的事实不再打印文本轨迹（否则同一事实两遍，ADR-023）
			trace: false,
		});
		transcript.setSessionId(result.sessionId);
		return result;
	} finally {
		spinner.stop(); // 退出前停掉节拍（否则会往一个已经还原的终端里继续画）
		keys.setRawMode?.(false);
		keys.off("data", onData);
		sink.off("resize", onResize);
		process.off("exit", restore);
		// 收尾前把最后一帧画完：否则 REPL 最后写入的几行（如 `(exit)`）会被"离开备用屏"抹掉
		syncState();
		screen.flush();
		restore();
	}
}
