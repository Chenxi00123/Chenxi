/**
 * 中立中间层 `PortableTurn`（ADR-019）。
 *
 * 厂商适配器之间**不互相转换**：每个适配器只做「自己的形状 ↔ 这个中立层」，
 * 因此新增一个厂商不需要动已有适配器（否则会退化成 N×N 的转换矩阵）。
 *
 * 这一层只承载**厂商侧真实存在的事实**：用户/助手的文本 + 时间。工具轨迹、审批、
 * 模式切换等在我们的模型里有事实、在厂商侧**没有对应物**，所以一律不进入这一层
 * （有损清单见 ADR-019）。
 */
import type { EventDraft, SessionEvent } from "@aster/schema";

export interface PortableTurn {
	/** 厂商侧只区分这两种角色（我们的 `tool` 角色在厂商侧不存在）。 */
	readonly role: "user" | "assistant";
	readonly content: string;
	/** ISO-8601；厂商侧能给出时间就保留，供导出时回写。 */
	readonly at?: string;
}

/** 从会话事件里抽出「厂商可移植的文本轮次」（空白的 assistant 步骤直接丢弃）。 */
export function eventsToTurns(events: readonly SessionEvent[]): PortableTurn[] {
	const turns: PortableTurn[] = [];
	for (const event of events) {
		if (event.type === "user/message") {
			turns.push({ role: "user", content: event.payload.content, at: event.at });
			continue;
		}
		if (event.type === "assistant/message" && event.payload.content.trim() !== "") {
			turns.push({ role: "assistant", content: event.payload.content, at: event.at });
		}
	}
	return turns;
}

/** 把可移植轮次变成**我们自己的**事件草稿（导入路径的唯一出口）。 */
export function turnsToDrafts(turns: readonly PortableTurn[]): EventDraft[] {
	return turns.map((turn): EventDraft => {
		const at = turn.at;
		if (turn.role === "assistant") {
			return {
				type: "assistant/message",
				payload: { content: turn.content },
				...(at === undefined ? {} : { at }),
			};
		}
		return {
			type: "user/message",
			payload: { content: turn.content },
			...(at === undefined ? {} : { at }),
		};
	});
}

/** epoch 毫秒 -> ISO-8601（厂商侧常用数字时间戳）。 */
export function epochMsToIso(ms: number): string {
	return new Date(ms).toISOString();
}

/** ISO-8601 -> epoch 毫秒；非法时间返回 `undefined`（不臆造时间）。 */
export function isoToEpochMs(iso: string | undefined): number | undefined {
	if (iso === undefined) return undefined;
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? parsed : undefined;
}
