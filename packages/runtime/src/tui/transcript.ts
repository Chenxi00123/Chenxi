/**
 * 会话视图的**行模型**（ADR-020 / ADR-023 / ADR-026）：把两条来源合成同一个行数组——
 *  1. **文本通道**（`Output`）：横幅 / 命令输出 / **流式 assistant 正文** / 交互提示
 *     —— 都是"没有对应事件"或"本来就是增量"的东西；
 *  2. **结构化事件**（`onEvent`）：会话事实（用户 / 工具 / 模式 / 记忆 / 审批 / 子代理 / 收尾），
 *     按 `describeEvent` **直接映射**。
 *
 * ADR-023 消掉两处文本启发式（状态条不再回读横幅、会话事实不再靠前缀嗅探）。
 *
 * ADR-026 起本文件还持有两样**视图状态**（都**不进 JSONL**）：
 *  - **折叠**：`expanded: Set<seq>` —— 哪些 `tool/result` 被展开了；
 *  - **围栏**：`rich-text` 的代码块状态 —— 富文本只作用于**文本通道的已收全行**。
 *  另外它按**结构化判据**回答"是否在回合中"（`turn/start` 之后未见 `turn/end`）。
 *
 * 不变量：`lines` 的**末元素永远是"未收全的流式半行"**（可为空串）——差分重绘依赖它；
 * `owner` 与 `lines` **等长**且一一对应（转录行 → 渲染它的那条事件 `seq`，非事件行是 `undefined`）。
 */
import type { SessionEvent } from "@chenxi/schema";
import type { Output } from "../cli/session-loop.js";
import { type DescribeOptions, describeEvent, toolResultHiddenLines } from "./events.js";
import { formatLine } from "./format.js";
import { INITIAL_RICH_TEXT, type RichTextState, renderRichLine } from "./rich-text.js";
import type { Theme } from "./theme.js";

export interface TranscriptOptions {
	readonly theme: Theme;
	/** 初始模式（来自 CLI 参数 / 配置）；此后由 `mode/changed` **事件**更新。 */
	readonly mode: string;
	/** 行变化时的回调（TUI 用它请求合帧重绘）。 */
	readonly onChange: () => void;
	/** 事件呈现策略（**前端差异**，见 `DescribeOptions`）。 */
	readonly describe?: DescribeOptions;
	/** 富文本（ADR-026）：文本通道的已收全行按**极简 markdown** 呈现。缺省 false（`--attach` 不开）。 */
	readonly rich?: boolean;
	/** 本地时钟（ADR-026：回合耗时是**本地测量**，不是事件字段）。缺省 `Date.now`。 */
	readonly now?: () => number;
}

export interface Transcript {
	/** 交给 `runSessionRepl` 的文本出口。 */
	readonly output: Output;
	/** 当前屏幕行（末元素是"未收全的流式半行"）。 */
	readonly lines: readonly string[];
	/** 状态条事实：模式（**来自事件**，不回读文本）。 */
	readonly mode: string;
	/** 状态条事实：会话 id（**来自事件 / `onSessionReady`**，不回读文本）。 */
	readonly sessionId: string;
	/** 是否**在回合中**（结构化判据：`turn/start` 之后未见 `turn/end`）。 */
	readonly busy: boolean;
	/** 当前回合在**本客户端**开始的毫秒（缺省 `undefined`）。 */
	readonly turnStartedAt: number | undefined;
	setSessionId(sessionId: string): void;
	/** 每条**已记录事件**：先更新结构化状态，再渲染成行。 */
	renderEvent(event: SessionEvent): void;
	/** 推一条**提示行**（Tab 补全候选之类；走"非事实"通道并上色，不进会话事实）。 */
	notice(text: string): void;
	/** 转录行下标 → 渲染它的事件 `seq`（非事件行返回 `undefined`）；供点击折叠定位。 */
	eventSeqAt(index: number): number | undefined;
	/** 切换某条 `tool/result` 的展开（视图状态）。**没有可展开内容时返回 false**。 */
	toggle(seq: number): boolean;
	/** 全部展开 / 全部收起（有任一已展开则收起，否则全展）。返回是否有变化。 */
	toggleAll(): boolean;
}

export function createTranscript(options: TranscriptOptions): Transcript {
	const { theme, onChange } = options;
	const lines: string[] = [""];
	/** 与 `lines` 等长：每行由哪条事件渲染（非事件行 `undefined`）。 */
	const owner: (number | undefined)[] = [undefined];
	const events = new Map<number, SessionEvent>();
	const expanded = new Set<number>();
	const now = options.now ?? Date.now;
	let raw = "";
	let fence: RichTextState = INITIAL_RICH_TEXT;
	let mode = options.mode;
	let sessionId = "…";
	let turnStartedAt: number | undefined;

	/** 把一整行放到"流式半行"的位置并起一条新的空行（同时维护 `owner`）。 */
	const emit = (rendered: string, seq?: number): void => {
		lines[lines.length - 1] = rendered;
		owner[lines.length - 1] = seq;
		lines.push("");
		owner.push(undefined);
	};

	const describeOptions = (): DescribeOptions => ({ ...options.describe, expanded });

	/** 折叠 / 展开切换后，**只重画这一条事件占用的那几行**（不重建整份历史）。 */
	const reRender = (seq: number): void => {
		const event = events.get(seq);
		const first = owner.indexOf(seq);
		if (event === undefined || first === -1) return;
		let last = first;
		while (last + 1 < owner.length && owner[last + 1] === seq) last += 1;
		const rendered = describeEvent(event, theme, describeOptions());
		lines.splice(first, last - first + 1, ...rendered);
		owner.splice(first, last - first + 1, ...rendered.map(() => seq));
	};

	/** 可展开的 `tool/result`（已到场的事件里，藏了内容的那些）。 */
	const expandable = (): number[] =>
		[...events.values()]
			.filter((event) => event.type === "tool/result" && toolResultHiddenLines(event) > 0)
			.map((event) => event.seq);

	return {
		output: {
			write(text: string): void {
				const parts = `${raw}${text}`.split("\n");
				raw = parts.pop() ?? "";
				for (const complete of parts) {
					if (options.rich === true) {
						const rich = renderRichLine(complete, fence, theme);
						fence = rich.state;
						emit(rich.rendered);
					} else {
						emit(formatLine(complete, theme));
					}
				}
				lines[lines.length - 1] = raw; // 未收全的半行按原样显示（流式输出）
				onChange();
			},
		},
		get lines(): readonly string[] {
			return lines;
		},
		get mode(): string {
			return mode;
		},
		get sessionId(): string {
			return sessionId;
		},
		get busy(): boolean {
			return turnStartedAt !== undefined;
		},
		get turnStartedAt(): number | undefined {
			return turnStartedAt;
		},
		setSessionId(next: string): void {
			sessionId = next;
		},
		renderEvent(event: SessionEvent): void {
			// 会话身份随**任意**事件到达（`session/start` 不进流，故不依赖它）
			sessionId = event.sessionId;
			if (event.type === "mode/changed") mode = event.payload.to;
			// 回合边界是**结构化判据**：`turn/start` 记本机时刻，`turn/end` / `session/end` 清账
			if (event.type === "turn/start") turnStartedAt = now();
			if (event.type === "turn/end" || event.type === "session/end") turnStartedAt = undefined;
			events.set(event.seq, event);
			for (const line of describeEvent(event, theme, describeOptions())) emit(line, event.seq);
			onChange();
		},
		notice(text: string): void {
			emit(formatLine(text, theme));
			onChange();
		},
		eventSeqAt(index: number): number | undefined {
			return index >= 0 && index < owner.length ? owner[index] : undefined;
		},
		toggle(seq: number): boolean {
			const event = events.get(seq);
			if (event === undefined || toolResultHiddenLines(event) === 0) return false;
			if (expanded.has(seq)) expanded.delete(seq);
			else expanded.add(seq);
			reRender(seq);
			onChange();
			return true;
		},
		toggleAll(): boolean {
			const seqs = expandable();
			if (seqs.length === 0) return false;
			const collapseAll = seqs.some((seq) => expanded.has(seq));
			for (const seq of seqs) {
				if (collapseAll) expanded.delete(seq);
				else expanded.add(seq);
				reRender(seq);
			}
			onChange();
			return true;
		},
	};
}
