/**
 * 投影：从事件日志派生模型历史（ADR-003，核心不变量 1「模型可见 <=> 已记录」）。
 *
 * **必须幂等**：同一事件序列任意次调用结果深等（纯函数，无隐藏状态）。
 * **必须确定性**：resume 前后同一序列投影一致。
 *
 * 投影规则：
 *   user/message -> role:user
 *   assistant/message -> role:assistant（含 toolCalls）
 *   tool/result -> role:tool
 *   memory/injected -> **只取最后一条**，作为**最后一条 user/message 的 content 前缀**（ADR-016）。
 *     仅当该注入事件在日志中**晚于**那条用户消息时才投影（否则它属于更早的回合，已被取代）。
 *   subagent/context-imported -> **展开**为逐条记录在案的父会话投影（ADR-018「导入即记录」）。
 *   subagent/result -> **只取「晚于最后一条 assistant/message」的那些**，作为 user 角色的
 *     `<subagent-result …>` 通知（ADR-018）：模型一旦产生新的 assistant 消息，该结果即被"确认"，
 *     不再重复送达（不堆积、不重复，且不需要任何额外状态）。
 * 其余事件（session/turn/permission/mode）属**审计事实**，不进模型历史。
 */
import type {
	ModelMessage,
	SessionEvent,
	SubagentResultPayload,
	ToolCallRef,
} from "@chenxi/schema";

export interface DeriveOptions {
	/** 可选的 system 首条消息（由 `context` 模块生成，v0.1 M2 接入）。 */
	readonly system?: string;
}

function stringifyOutput(output: unknown): string {
	if (typeof output === "string") return output;
	if (output === undefined) return "";
	try {
		const s = JSON.stringify(output);
		return s === undefined ? String(output) : s;
	} catch {
		return String(output);
	}
}

/** 记忆块渲染（ADR-016）：包成可辨识的标签，便于审计与模型识别。 */
function renderMemoryBlock(source: string, content: string): string {
	return `<memory source="${source}">\n${content}\n</memory>`;
}

/** 子代理结果渲染（ADR-018）：同样包成可辨识标签，且**不含**子代理的工具轨迹。 */
function renderSubagentResult(payload: SubagentResultPayload): string {
	const status = payload.ok ? "completed" : "failed";
	const body = payload.ok
		? (payload.summary ?? "(no summary)")
		: (payload.error ?? "subagent failed");
	return (
		`<subagent-result childSessionId="${payload.childSessionId}" kind="${payload.kind}" status="${status}">\n` +
		`${body}\n</subagent-result>`
	);
}

/**
 * 一次扫描定位三处下标（-1 表示不存在）：最后一条注入、最后一条 user/message、
 * 最后一条 assistant/message。**必须全局定位**——若边扫边更新 `lastAssistantIndex`，
 * 早于"全局最后一条 assistant 消息"的结果会被错误投影。
 */
function locateProjection(events: readonly SessionEvent[]): {
	readonly injection:
		| { readonly index: number; readonly source: string; readonly content: string }
		| undefined;
	readonly lastUserIndex: number;
	readonly lastAssistantIndex: number;
} {
	let injection: { index: number; source: string; content: string } | undefined;
	let lastUserIndex = -1;
	let lastAssistantIndex = -1;
	for (const [index, event] of events.entries()) {
		if (event.type === "memory/injected") {
			injection = { index, source: event.payload.source, content: event.payload.content };
		}
		if (event.type === "user/message") lastUserIndex = index;
		if (event.type === "assistant/message") lastAssistantIndex = index;
	}
	return { injection, lastUserIndex, lastAssistantIndex };
}

/**
 * 收集所有压缩区间（M23，ADR-041）：被省略的事件按 `seq` 判断。
 *
 * 用 `seq` 而不是数组下标：`seq` 是**事件自身携带**的字段，跨 resume / 重建索引稳定；
 * 下标会因"读进多少行"而变。
 */
function collectCompactions(
	events: readonly SessionEvent[],
): readonly { readonly fromSeq: number; readonly toSeq: number }[] {
	const ranges: { fromSeq: number; toSeq: number }[] = [];
	for (const event of events) {
		if (event.type !== "context/compacted") continue;
		ranges.push({ fromSeq: event.payload.fromSeq, toSeq: event.payload.toSeq });
	}
	return ranges;
}

/** 该事件是否已被压缩（区间是闭区间；区间之间不重叠）。 */
function isCompacted(
	seq: number,
	ranges: readonly { readonly fromSeq: number; readonly toSeq: number }[],
): boolean {
	for (const range of ranges) {
		if (seq >= range.fromSeq && seq <= range.toSeq) return true;
	}
	return false;
}

export function deriveMessages(
	events: readonly SessionEvent[],
	opts: DeriveOptions = {},
): ModelMessage[] {
	const messages: ModelMessage[] = [];

	if (opts.system !== undefined) {
		messages.push({ role: "system", content: opts.system });
	}

	// ADR-016：只投影**最新一条**注入，且仅当它晚于最后一条用户消息（= 该回合的注入）
	const { injection, lastUserIndex, lastAssistantIndex } = locateProjection(events);
	const memoryPrefix =
		injection !== undefined && injection.index > lastUserIndex && lastUserIndex >= 0
			? renderMemoryBlock(injection.source, injection.content)
			: undefined;
	// M23：被压缩的区间整体跳过，并在压缩事件自身的位置插入摘要（摘要也是**已记录的事实**）
	const compactions = collectCompactions(events);

	for (const [index, event] of events.entries()) {
		if (isCompacted(event.seq, compactions)) continue;
		switch (event.type) {
			case "context/compacted": {
				// 用 user 角色送达（system 只能在首条；tool 会破坏配对）——文本自带可辨识标签
				messages.push({ role: "user", content: event.payload.summary });
				break;
			}
			case "user/message": {
				const content = event.payload.content;
				messages.push({
					role: "user",
					content:
						index === lastUserIndex && memoryPrefix !== undefined
							? `${memoryPrefix}\n\n${content}`
							: content,
				});
				break;
			}
			case "assistant/message": {
				const payload = event.payload;
				messages.push({
					role: "assistant",
					content: payload.content,
					...(payload.toolCalls ? { toolCalls: payload.toolCalls as ToolCallRef[] } : {}),
				});
				break;
			}
			case "tool/result": {
				const payload = event.payload;
				const content = payload.ok
					? stringifyOutput(payload.output)
					: (payload.error?.message ?? "tool execution failed");
				messages.push({
					role: "tool",
					content,
					toolCallId: payload.callId,
				});
				break;
			}
			case "subagent/context-imported": {
				// ADR-018：导入即记录——把**当时记下的**父会话投影逐条展开
				for (const message of event.payload.messages) {
					messages.push({ ...message });
				}
				break;
			}
			case "subagent/result": {
				// ADR-018：只送达「尚未被父模型确认」的结果（晚于最后一条 assistant/message）
				if (index > lastAssistantIndex) {
					messages.push({ role: "user", content: renderSubagentResult(event.payload) });
				}
				break;
			}
			default:
				break;
		}
	}

	return messages;
}
