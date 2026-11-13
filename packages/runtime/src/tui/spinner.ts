/**
 * 回合内指示（ADR-026）：spinner 帧 + 一个"**忙碌才走**"的合帧节拍器。
 *
 * 两条纪律：
 *  - **只用已记录的事实**：忙碌态来自"`turn/start` 之后未见 `turn/end`"这一**结构化判据**（绝不嗅探文本）；
 *    耗时是**本机时钟**测出来的（状态条上明写 `(local)`），**不是**事件里的字段；
 *  - **空闲不空转**：`setInterval` 只在忙碌期间存在，`turn/end` 到达即停（否则白耗电、白刷屏）。
 *
 * 帧选择是**纯函数**（`elapsedMs` → 字形），因此可被单测逐值断言。
 */

/** spinner 帧（半圆四相；这些字符占 1 显示列）。 */
export const SPINNER_FRAMES: readonly string[] = ["◐", "◓", "◑", "◒"];

/** 帧切换周期（毫秒）：与合帧窗口（16ms）同量级，但慢得多——"舒缓、不闪"（用户偏好）。 */
export const SPINNER_PERIOD_MS = 120;

/** 状态条要显示的忙碌事实（**本地测量**，见 ADR-026）。 */
export interface BusyFacts {
	readonly glyph: string;
	readonly elapsedMs: number;
}

/** 按已过毫秒选帧（**确定函数**，不引随机 / 不读时钟）。 */
export function spinnerGlyph(
	elapsedMs: number,
	frames: readonly string[] = SPINNER_FRAMES,
): string {
	if (frames.length === 0) return "";
	const index = Math.floor(Math.max(0, elapsedMs) / SPINNER_PERIOD_MS) % frames.length;
	return frames[index] ?? "";
}

/** 由"回合开始时刻 + 本地时钟"算出忙碌事实；回合未开始则 `undefined`。 */
export function busyFacts(startedAt: number | undefined, now: () => number): BusyFacts | undefined {
	if (startedAt === undefined) return undefined;
	const elapsedMs = Math.max(0, now() - startedAt);
	return { glyph: spinnerGlyph(elapsedMs), elapsedMs };
}

export interface SpinnerTicker {
	/** 按当前忙碌状态启动 / 停止节拍（幂等，可在每次事件后调用）。 */
	sync(): void;
	/** 无条件停止（退出时必须调用）。 */
	stop(): void;
}

/** 合帧节拍器：忙碌时每 `periodMs` 调一次 `onTick`，空闲即停。 */
export function createSpinnerTicker(options: {
	readonly busy: () => boolean;
	readonly onTick: () => void;
	readonly periodMs?: number;
}): SpinnerTicker {
	const periodMs = options.periodMs ?? SPINNER_PERIOD_MS;
	let timer: ReturnType<typeof setInterval> | null = null;
	return {
		sync() {
			if (options.busy() && timer === null) {
				timer = setInterval(options.onTick, periodMs);
			} else if (!options.busy() && timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
		stop() {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
