/**
 * 键盘输入解析与行编辑（ADR-020）。
 *
 * 为什么自写：raw 模式下拿到的是**字节流**（不是行），而且
 *  - 中文/emoji 是多字节 UTF-8，可能在**分片边界**被截断；
 *  - 方向键是 ESC 序列，也可能被截断；
 * 因此需要一个小状态机 + 待决缓冲。
 *
 * 两者都是**纯函数**（不碰 IO），可被单测逐事件断言。
 *
 * ADR-025 起还认两类"多行输入"的输入源：
 *  - **换行键**：`Ctrl+J`（0x0A，所有终端都发得出）、`Alt+Enter`（`ESC\r`）、
 *    以及终端**若已开启** CSI-u / modifyOtherKeys 时会发来的 `ESC[13;2u` / `ESC[27;2;13~`
 *    —— 我们**不主动**改终端模式，只是"认得出就认"（不假装 Shift+Enter 到处可用）；
 *  - **括号粘贴**：`ESC[200~ … ESC[201~`（bracketed paste）整段作为**一个** `paste` 事件，
 *    因此"粘贴多行"不会被当成一串回车逐行提交。
 */
import { caretLineOf, lineStarts } from "./editor.js";

export type KeyEvent =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "enter" }
	| { readonly kind: "newline" }
	/** 括号粘贴（整段；可能含换行）。 */
	| { readonly kind: "paste"; readonly text: string }
	| { readonly kind: "complete" }
	| { readonly kind: "backspace" }
	| { readonly kind: "delete" }
	| { readonly kind: "left" }
	| { readonly kind: "right" }
	| { readonly kind: "home" }
	| { readonly kind: "end" }
	| { readonly kind: "up" }
	| { readonly kind: "down" }
	| { readonly kind: "page-up" }
	| { readonly kind: "page-down" }
	| { readonly kind: "clear-line" }
	/** 全部展开 / 收起工具结果（Ctrl+O，ADR-026；**不用裸 `F`**：裸字母键必须留给输入框）。 */
	| { readonly kind: "toggle-tools" }
	| { readonly kind: "interrupt" }
	| { readonly kind: "eof" }
	/**
	 * 鼠标（SGR 扩展编码，`ESC[<b;x;yM|m`）：`x`/`y` 是**1 起的终端坐标**。
	 * 只启用 `?1000h`（点击/滚轮）——**不启用拖拽跟踪**（`?1002/?1003`），
	 * 因此终端原生选中不受影响（拖拽由终端自己处理，Shift 是终端的约定旁路）。
	 */
	| {
			readonly kind: "mouse";
			readonly button: number;
			readonly x: number;
			readonly y: number;
			readonly pressed: boolean;
	  }
	| { readonly kind: "unknown" };

/** 已知 ESC 序列表（`\x1bOA` 形态是"应用光标键"模式，某些终端会用）。 */
const ESCAPE_SEQUENCES: ReadonlyMap<string, KeyEvent["kind"]> = new Map([
	// 换行键（ADR-025）：Alt+Enter 与"终端已开启扩展键上报"时的 Shift+Enter
	["\u001b\r", "newline"],
	["\u001b[13;2u", "newline"],
	["\u001b[13;3u", "newline"],
	["\u001b[27;2;13~", "newline"],
	["\u001b[27;3;13~", "newline"],
	["\u001b[A", "up"],
	["\u001b[B", "down"],
	["\u001b[C", "right"],
	["\u001b[D", "left"],
	["\u001bOA", "up"],
	["\u001bOB", "down"],
	["\u001bOC", "right"],
	["\u001bOD", "left"],
	["\u001b[H", "home"],
	["\u001b[F", "end"],
	["\u001b[1~", "home"],
	["\u001b[4~", "end"],
	["\u001b[7~", "home"],
	["\u001b[8~", "end"],
	["\u001b[3~", "delete"],
	["\u001b[5~", "page-up"],
	["\u001b[6~", "page-down"],
]);

/** ESC 字符（运行期拼出，避免在源码里写控制字符）。 */
const ESC_CHAR = String.fromCharCode(27);

/** CSI 形态（`ESC[` + 参数 + 终结符）：无法识别时按这个长度整体吞掉，避免漏出垃圾字符。 */
const CSI_RE = new RegExp(`^${ESC_CHAR}\\[[0-9;?]*[A-Za-z~]`);

/** SGR 鼠标（`ESC[<b;x;yM` 按下 / `ESC[<b;x;y m` 松开）。 */
const MOUSE_RE = new RegExp(`^${ESC_CHAR}\\[<(\\d+);(\\d+);(\\d+)([Mm])`);
/** 鼠标序列的**未完成前缀**（刚收到 `ESC[<0;3` 之类）：等下一片，绝不当成垃圾吞掉。 */
const MOUSE_PREFIX_RE = new RegExp(`^${ESC_CHAR}\\[<\\d*(;\\d+){0,2}$`);

/** 控制字节 → 事件。 */
const CONTROL_KEYS: ReadonlyMap<number, KeyEvent["kind"]> = new Map([
	[0x03, "interrupt"],
	[0x04, "eof"],
	[0x08, "backspace"],
	[0x09, "complete"], // Tab：补全（ADR-024）
	[0x0a, "newline"], // Ctrl+J：换行（ADR-025；所有终端都发得出）
	[0x0d, "enter"], // Enter：提交
	[0x0f, "toggle-tools"], // Ctrl+O：全部展开 / 收起工具结果（ADR-026）
	[0x15, "clear-line"],
	[0x7f, "backspace"],
]);

/** UTF-8 前导字节 -> 该字符的总字节数（非法前导按 1 处理）。 */
function utf8Length(lead: number): number {
	if (lead < 0x80) return 1;
	if (lead >= 0xc0 && lead <= 0xdf) return 2;
	if (lead >= 0xe0 && lead <= 0xef) return 3;
	if (lead >= 0xf0 && lead <= 0xf7) return 4;
	return 1;
}

/** 括号粘贴的起止标记（ADR-025）。 */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

export interface KeyDecoder {
	/** 投喂一段字节，返回**已经完整**的按键事件（不完整的部分留在内部等待后续分片）。 */
	push(chunk: Buffer | string): KeyEvent[];
	/** 是否还有未完成的字节（测试用）。 */
	pending(): number;
}

export function createKeyDecoder(): KeyDecoder {
	let buffer = Buffer.from([]);
	/** 括号粘贴的累积缓冲（`null` = 不在粘贴中）。 */
	let paste: Buffer | null = null;

	return {
		pending: () => buffer.length,
		push(chunk) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			buffer = Buffer.concat([buffer, bytes]);
			const events: KeyEvent[] = [];

			while (buffer.length > 0) {
				// 0) 粘贴中：只看终止标记（跨分片安全），整段作为**一个** paste 事件
				if (paste !== null) {
					const text = buffer.toString("latin1");
					const end = text.indexOf(PASTE_END);
					if (end === -1) {
						paste = Buffer.concat([paste, buffer]);
						buffer = Buffer.from([]);
						break;
					}
					paste = Buffer.concat([paste, buffer.subarray(0, end)]);
					buffer = buffer.subarray(end + PASTE_END.length);
					events.push({ kind: "paste", text: paste.toString("utf8") });
					paste = null;
					continue;
				}

				// 1) ESC 序列：要么匹配已知表，要么按 CSI 整体吞掉，要么等更多字节
				if (buffer[0] === 0x1b) {
					const asText = buffer.toString("latin1");
					// 括号粘贴的起点（先于已知序列判断：`\u001b[200~` 不在表里）
					if (asText.startsWith(PASTE_START)) {
						paste = Buffer.from([]);
						buffer = buffer.subarray(PASTE_START.length);
						continue;
					}
					if (asText.length < PASTE_START.length && PASTE_START.startsWith(asText)) return events;
					let matched = false;
					for (const [sequence, kind] of ESCAPE_SEQUENCES) {
						if (asText.startsWith(sequence)) {
							events.push({ kind } as KeyEvent);
							buffer = buffer.subarray(sequence.length);
							matched = true;
							break;
						}
						// 只是某个已知序列的前缀（例如刚收到 `\x1b[`）：等下一片
						if (asText.length < sequence.length && sequence.startsWith(asText)) return events;
					}
					if (matched) continue;
					// SGR 鼠标：整条解析成坐标事件（滚轮 / 点击都走这里）
					const mouse = MOUSE_RE.exec(asText);
					if (mouse !== null) {
						events.push({
							kind: "mouse",
							button: Number(mouse[1]),
							x: Number(mouse[2]),
							y: Number(mouse[3]),
							pressed: mouse[4] === "M",
						});
						buffer = buffer.subarray(mouse[0].length);
						continue;
					}
					// 可能是鼠标序列的**前缀**（分片边界）：等下一片，绝不吞成垃圾
					if (MOUSE_PREFIX_RE.test(asText)) return events;
					const csi = CSI_RE.exec(asText);
					if (csi !== null) {
						events.push({ kind: "unknown" });
						buffer = buffer.subarray(csi[0].length);
						continue;
					}
					if (asText.length < 6) return events; // 可能还没收全，等下一片
					events.push({ kind: "unknown" }); // 未知的裸 ESC：吞掉 1 字节
					buffer = buffer.subarray(1);
					continue;
				}

				// 2) 控制字节
				const byte = buffer[0] as number;
				if (byte < 0x20 || byte === 0x7f) {
					events.push({ kind: CONTROL_KEYS.get(byte) ?? "unknown" } as KeyEvent);
					buffer = buffer.subarray(1);
					continue;
				}

				// 3) UTF-8 文本（可能被分片截断 -> 等下一片）
				const length = utf8Length(byte);
				if (buffer.length < length) return events;
				const text = buffer.subarray(0, length).toString("utf8");
				events.push({ kind: "text", text });
				buffer = buffer.subarray(length);
			}

			return events;
		},
	};
}

export interface EditState {
	/** 输入文本（按**字符**而非字节编辑，保证宽字符不会被切半）。 */
	readonly text: string;
	/** 插入点（字符下标）。 */
	readonly caret: number;
}

/** 光标左移/右移/退格/删字都按**字符**操作。 */
export function applyEdit(state: EditState, event: KeyEvent): EditState {
	const chars = [...state.text];
	const caret = Math.min(Math.max(0, state.caret), chars.length);
	switch (event.kind) {
		case "text":
			return {
				text: [...chars.slice(0, caret), event.text, ...chars.slice(caret)].join(""),
				caret: caret + [...event.text].length,
			};
		case "backspace":
			if (caret === 0) return state;
			return {
				text: [...chars.slice(0, caret - 1), ...chars.slice(caret)].join(""),
				caret: caret - 1,
			};
		case "delete":
			if (caret >= chars.length) return state;
			return { text: [...chars.slice(0, caret), ...chars.slice(caret + 1)].join(""), caret };
		case "left":
			return { ...state, caret: Math.max(0, caret - 1) };
		case "right":
			return { ...state, caret: Math.min(chars.length, caret + 1) };
		case "home": {
			// **行首**（多行时是"本行行首"，不是全文行首 —— ADR-025）
			const lines = state.text.split("\n");
			const { line } = caretLineOf(lines, caret);
			return { ...state, caret: lineStarts(lines)[line] ?? 0 };
		}
		case "end": {
			// **行尾**（多行时是"本行行尾"）
			const lines = state.text.split("\n");
			const { line } = caretLineOf(lines, caret);
			const start = lineStarts(lines)[line] ?? 0;
			return { ...state, caret: start + [...(lines[line] ?? "")].length };
		}
		case "clear-line":
			// 沿用既有语义：**清空整个输入**（多行时 = 丢弃整份草稿）。
			// 刻意不改成 readline 的"只清本行到光标"——那会让"多行草稿怎么一键丢掉"变得没有答案（ADR-025）
			return { text: "", caret: 0 };
		default:
			return state;
	}
}
