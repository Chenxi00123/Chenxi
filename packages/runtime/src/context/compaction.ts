/**
 * 长会话上下文压缩（M23，ADR-041）——**纯函数**，不 append、不调模型、不看时间。
 *
 * 为什么放在"回合"这一层：`assistant(toolCalls)` 与 `tool/result` 必须成对出现，一旦按
 * "消息条数"切断，投影里就会留下孤儿 tool 消息（真实 API 会直接报错）。按整回合压缩，
 * 边界天然落在 `turn/start` 之前，配对永远不会被切断。
 *
 * 纪律：
 *  - 只产出**计划**；落盘由调用方（`executeTurn`）经唯一写入路径 append `context/compacted`；
 *  - 阈值按**字符数**（更贴近真实上下文压力），缺省 120000 字符；
 *  - 新区间从**上一段压缩的 `toSeq + 1`** 开始 ⇒ 区间永不重叠；
 *  - 摘要文本确定性生成：同样的输入永远得到同样的文本（回放 / resume 后投影一致）。
 */
import type { SessionEvent } from "@chenxi/schema";

export interface CompactionConfig {
	/** 触发阈值：所有消息事件正文的字符总数超过它才压缩。 */
	readonly maxChars: number;
	/** 保留最近的回合数（≥1：最新回合绝不能被压掉）。 */
	readonly keepTurns: number;
}

export const DEFAULT_COMPACTION_MAX_CHARS = 120_000;
export const DEFAULT_COMPACTION_KEEP_TURNS = 2;

export interface CompactionPlan {
	readonly fromSeq: number;
	readonly toSeq: number;
	readonly removedMessages: number;
	readonly removedChars: number;
	readonly keepTurns: number;
	readonly summary: string;
}

/** 计入"消息"的事件类型（与 `deriveMessages` 投影出消息的那几类一致）。 */
function isMessageEvent(event: SessionEvent): boolean {
	return (
		event.type === "user/message" ||
		event.type === "assistant/message" ||
		event.type === "tool/result"
	);
}

/** 一条消息事件的正文长度（估算上下文压力；tool/call 的参数由 assistant 消息携带，不重复计）。 */
function messageChars(event: SessionEvent): number {
	if (event.type === "user/message" || event.type === "assistant/message") {
		return event.payload.content.length;
	}
	if (event.type === "tool/result") {
		const payload = event.payload;
		if (!payload.ok) return payload.error?.message.length ?? 0;
		if (typeof payload.output === "string") return payload.output.length;
		try {
			return JSON.stringify(payload.output ?? null).length;
		} catch {
			return 0;
		}
	}
	return 0;
}

function renderSummary(count: number, chars: number): string {
	return (
		`[context compacted] 已省略 ${count} 条较早消息（约 ${chars} 字符）。` +
		"它们属于更早的回合，不再逐字保留；如果需要其中的细节，请让用户重新提供。"
	);
}

/**
 * 计算本次压缩计划；**不需要压缩就返回 `undefined`**（调用方据此保持逐字节不变）。
 *
 * 注意：调用时机是「本回合 user/message 落盘之后、runTurn 之前」——所以最新回合已经在
 * 事件序列里，`keepTurns >= 1` 保证它不会被压。
 */
export function planCompaction(
	events: readonly SessionEvent[],
	config: CompactionConfig,
): CompactionPlan | undefined {
	const keepTurns = Math.max(1, Math.floor(config.keepTurns));
	const maxChars = Math.max(1, Math.floor(config.maxChars));

	// 总字符数没超阈值 ⇒ 什么都不做（默认关闭 / 长会话才触发）
	let totalChars = 0;
	for (const event of events) {
		if (isMessageEvent(event)) totalChars += messageChars(event);
	}
	if (totalChars <= maxChars) return undefined;

	// 回合起点（数组下标）：只按 turn/start 切，保证 tool 配对不被切断
	const turnStarts: number[] = [];
	for (const [index, event] of events.entries()) {
		if (event.type === "turn/start") turnStarts.push(index);
	}
	if (turnStarts.length <= keepTurns) return undefined;
	const keepFrom = turnStarts[turnStarts.length - keepTurns] as number;

	// 上一段压缩的结束位置：新区间一定从它之后开始（不重叠、也不重复计数）
	let lowerBound = -1;
	for (const event of events) {
		if (event.type === "context/compacted" && event.payload.toSeq > lowerBound) {
			lowerBound = event.payload.toSeq;
		}
	}

	let fromSeq = Number.POSITIVE_INFINITY;
	let toSeq = -1;
	let removedMessages = 0;
	let removedChars = 0;
	for (const [index, event] of events.entries()) {
		if (index >= keepFrom) break;
		if (!isMessageEvent(event)) continue;
		if (event.seq <= lowerBound) continue;
		if (event.seq < fromSeq) fromSeq = event.seq;
		if (event.seq > toSeq) toSeq = event.seq;
		removedMessages += 1;
		removedChars += messageChars(event);
	}

	if (removedMessages === 0 || toSeq < 0) return undefined;
	return {
		fromSeq,
		toSeq,
		removedMessages,
		removedChars,
		keepTurns,
		summary: renderSummary(removedMessages, removedChars),
	};
}
