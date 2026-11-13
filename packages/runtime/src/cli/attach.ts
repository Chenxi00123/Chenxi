/**
 * `--attach` 只读镜像客户端（ADR-022）：把远端会话**镜像**到本地终端。
 *
 * 复用 M10 的渲染内核（`createScreen` / `compose` / 差分重绘 / 语义配色），但**不驱动任何会话**：
 *  - TTY → 全屏差分渲染；**非 TTY → 退化为逐行打印**（诚实降级，不假装能画）；
 *  - 帧 → 行由 `tui/events.ts` 的**结构化映射**给出（不再靠前缀嗅探）；
 *  - `hello` 帧显示协议版本与 `resume`（明示**不做续传**）；
 *  - 断线（含 `subscriber_overflow`）一律提示「重连并**整段回放** `GET <url>/api/sessions/<id>`」；
 *  - **客户端不做任何写入**（镜像 = 只订阅）。
 */
import type { SessionId } from "@chenxi/schema";
import type { EventStream } from "../serve/index.js";
import { connectEventStream } from "../serve/index.js";
import {
	ansi,
	createKeyDecoder,
	createScreen,
	createTheme,
	describeFrame,
	type KeySource,
	type Screen,
	type Sink,
	type SizeSource,
	type StatusFacts,
	type Theme,
} from "../tui/index.js";

const ENTER_ALT_SCREEN = "\u001b[?1049h";
const LEAVE_ALT_SCREEN = "\u001b[?1049l";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface AttachOptions {
	/** 远端服务端地址（如 `http://127.0.0.1:8787`）。 */
	readonly url: string;
	/** 渲染目标（缺省 `process.stdout`）。 */
	readonly sink?: Sink & SizeSource;
	/** 按键来源（缺省 `process.stdin`；只用于退出）。 */
	readonly keys?: KeySource;
	readonly theme?: Theme;
	/** 合帧窗口（缺省 16ms；测试传 0 以同步渲染）。 */
	readonly intervalMs?: number;
	/** 是否用全屏差分渲染（缺省按 TTY 探测）。 */
	readonly tui?: boolean;
	/** 连接工厂（测试可注入假流）。 */
	readonly connect?: (url: string) => EventStream;
}

export interface AttachResult {
	/** 镜像到的会话 id（`session/start` 不进流，故随**第一条 event 帧**到达）。 */
	readonly sessionId?: SessionId;
	/** 收到的帧数。 */
	readonly frames: number;
}

/** 运行一次只读镜像，直到流结束（或用户中断）。 */
export async function runAttachSession(options: AttachOptions): Promise<AttachResult> {
	const theme = options.theme ?? createTheme();
	const tui = options.tui ?? (process.stdout.isTTY === true && process.stdin.isTTY === true);
	const base = options.url.replace(/\/+$/, "");
	const sink: Sink & SizeSource = options.sink ?? (process.stdout as unknown as Sink & SizeSource);
	const stream: EventStream = (options.connect ?? connectEventStream)(base);

	const transcript: string[] = [];
	let sessionId: SessionId | undefined;
	let frames = 0;
	let closedByUser = false;

	const statusOf = (): StatusFacts => ({
		mode: "attach",
		cwd: options.url,
		sessionId: sessionId ?? "…",
	});

	const screen: Screen | undefined = tui
		? createScreen({
				sink,
				theme,
				intervalMs: options.intervalMs,
				size: () => ({
					columns: Number(sink.columns) > 0 ? Number(sink.columns) : DEFAULT_COLUMNS,
					rows: Number(sink.rows) > 0 ? Number(sink.rows) : DEFAULT_ROWS,
				}),
				initial: { status: statusOf(), transcript, input: "", caret: 0, scrollOffset: 0 },
			})
		: undefined;

	/** 把已产出的行画出去：TUI 走差分重绘，非 TTY 直接逐行打印（并保持 transcript 供测试断言）。 */
	const paint = (lines: readonly string[]): void => {
		if (lines.length === 0) return;
		transcript.push(...lines);
		if (screen === undefined) {
			for (const line of lines) sink.write(`${line}\n`);
			return;
		}
		screen.update({ transcript: [...transcript], status: statusOf() });
		screen.flush();
	};

	// —— 退出与还原（**严格**：进/出都在 finally，并额外挂 `exit` 兜底）——
	const keys = options.keys ?? (process.stdin as unknown as KeySource);
	let onData: ((chunk: Buffer | string) => void) | undefined;
	let onResize: (() => void) | undefined;

	const requestStop = (): void => {
		closedByUser = true;
		stream.close();
	};
	const restore = (): void => {
		if (onData !== undefined) keys.off("data", onData);
		if (onResize !== undefined) sink.off("resize", onResize);
		if (screen !== undefined) {
			keys.setRawMode?.(false);
			sink.write(`${ansi.endSync}${LEAVE_ALT_SCREEN}`);
		}
	};
	const onSigint = (): void => requestStop();
	process.once("exit", restore);
	process.on("SIGINT", onSigint);

	if (screen !== undefined) {
		const decoder = createKeyDecoder();
		onData = (chunk) => {
			for (const event of decoder.push(chunk)) {
				if (event.kind === "interrupt" || event.kind === "eof") requestStop();
			}
		};
		onResize = () => {
			screen.update({ status: statusOf() });
			screen.flush();
		};
		keys.on("data", onData);
		sink.on("resize", onResize);
		sink.write(`${ENTER_ALT_SCREEN}${ansi.showCursor}`);
		keys.setRawMode?.(true);
	}

	try {
		paint([theme.paint("muted", `attach: ${options.url} (read-only mirror) — Ctrl+C to quit`)]);
		for await (const frame of stream) {
			frames += 1;
			if (frame.kind === "event") sessionId = frame.event.sessionId;
			paint(describeFrame(frame, theme));
			if (frame.kind === "error" && !frame.retryable) break; // 不可续：到此为止
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		paint([theme.paint("err", `  ! attach failed: ${message}`)]);
	} finally {
		if (closedByUser) {
			paint([theme.paint("muted", "attach: closed (read-only mirror)")]);
		} else {
			paint([
				theme.paint(
					"muted",
					sessionId === undefined
						? `attach: disconnected — reconnect to ${base}/api/event to resume mirroring`
						: `attach: disconnected — replay ${base}/api/sessions/${sessionId}`,
				),
			]);
		}
		process.off("SIGINT", onSigint);
		process.off("exit", restore);
		restore();
	}

	return { ...(sessionId === undefined ? {} : { sessionId }), frames };
}
