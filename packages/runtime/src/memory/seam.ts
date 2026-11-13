/**
 * 记忆缝（ADR-011 / ADR-016 / ADR-033）。
 *
 * 纪律：
 *  - **注入即记录**：检索结果先落 `memory/injected` 事件，再由 `deriveMessages` 投影成
 *    模型可见的前缀（不变量 1：模型可见 ⟺ 已记录）；
 *  - **只投影最新一次**由投影侧负责（见 `session/derive.ts`），本缝只负责"落事件"；
 *  - **失败不阻塞**：适配器报错只返回 `failed`，**绝不抛错**（记忆是增强，不是依赖）；
 *  - **检索跨会话**（ADR-033）：检索用 `session: "*"`（该 user+agent 下所有会话），
 *    写入用**真实** session id（见 `write.ts`）——否则写进去的记忆只有本会话可见；
 *  - `after_turn` 写入（ADR-033/034）由 `write.ts` 提供；**未配置写入时不暴露 `afterTurn`**
 *    ⇒ 既有行为逐字节不变。
 */
import {
	type EventDraft,
	type EventType,
	MEMORY_ANY_SESSION,
	type MemoryAdapter,
	type MemoryRecord,
	type MemoryScope,
	type SessionEvent,
} from "@aster/schema";
import type { MemoryWriteSeam } from "./write.js";

/** 单次注入条数上限（R13 质量地板的兜底）。 */
const DEFAULT_LIMIT = 5;
/** 单条注入内容长度上限（超出截断）。 */
const DEFAULT_MAX_CONTENT_LENGTH = 500;

export interface MemorySeamOptions {
	readonly adapter: MemoryAdapter;
	/** `memory/injected` 事件里的 `source` 标签（审计用，例如 `mcp:memory/search_memory`）。 */
	readonly source: string;
	readonly scope: MemoryScope;
	readonly limit?: number;
	readonly maxContentLength?: number;
	/**
	 * 写入缝（ADR-033）。**缺省不暴露 `afterTurn`** ⇒ 未配置写入时行为逐字节不变。
	 * 作用域在这里被**补成跨会话检索**（`session: "*"`），写入侧仍用真实 id。
	 */
	readonly writer?: MemoryWriteSeam;
}

/** 注入结果：调用方据此打印**可读提示**。 */
export type MemoryInjectionOutcome =
	| { readonly kind: "none"; readonly reason: string }
	| { readonly kind: "injected"; readonly memoryIds: readonly string[] }
	| { readonly kind: "failed"; readonly reason: string };

export interface MemorySeam {
	readonly source: string;
	/** 在 `runTurn` **之前**调用（由 CLI 层调用，`loop` 一行不改）。 */
	beforeTurn(
		query: string,
		append: <T extends EventType>(draft: EventDraft<T>) => Promise<SessionEvent>,
	): Promise<MemoryInjectionOutcome>;
	/** 在 `runTurn` **之后**调用（ADR-033）：只有配置了写入时才存在。 */
	readonly afterTurn?: MemoryWriteSeam["afterTurn"];
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createMemorySeam(options: MemorySeamOptions): MemorySeam {
	const limit = options.limit ?? DEFAULT_LIMIT;
	const maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;

	const beforeTurn: MemorySeam["beforeTurn"] = async (query, append) => {
		const trimmed = query.trim();
		if (trimmed === "") return { kind: "none", reason: "empty query" };
		if (limit <= 0) return { kind: "none", reason: "limit is 0 (injection disabled)" };

		let records: readonly MemoryRecord[];
		try {
			const result = await options.adapter.search({
				query: trimmed,
				// ADR-033：跨会话检索（`*` = 该 user+agent 下所有会话）；写入侧用真实 session id
				scope: { ...options.scope, session: MEMORY_ANY_SESSION },
				limit,
			});
			// 宽容：外部服务器可能返回形状不符的东西，一律按「无记忆」处理
			records = Array.isArray(result?.records) ? result.records : [];
		} catch (error) {
			return { kind: "failed", reason: errorMessage(error) };
		}

		const usable = records
			.filter((record) => typeof record.content === "string" && record.content.trim() !== "")
			.slice(0, limit);
		if (usable.length === 0) return { kind: "none", reason: "no memory matched" };

		const memoryIds = usable.map((record) => record.id);
		const content = usable
			.map((record) => truncate(record.content.trim(), maxContentLength))
			.join("\n");
		await append({
			type: "memory/injected",
			payload: { target: "user-prefix", source: options.source, content, memoryIds },
		});
		return { kind: "injected", memoryIds };
	};

	return {
		source: options.source,
		beforeTurn,
		...(options.writer === undefined ? {} : { afterTurn: options.writer.afterTurn }),
	};
}
