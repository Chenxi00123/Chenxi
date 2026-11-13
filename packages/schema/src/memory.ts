/**
 * 长期记忆契约（ADR-010 / ADR-011）。
 *
 * harness **不自研**记忆层：这里定义的 `MemoryAdapter` 是**我方**的契约，
 * v0.1 只支持 mem0 式 MCP 记忆层的形状；Graphiti / TencentDB 未来可插拔。
 *
 * 契约原则（ADR-010）：
 * - 作用域三键（user/agent/session）**必填**，且写入时从 metadata 剥离身份键防越权写；
 * - 返回值统一为**相似度语义**；
 * 写入带 **provenance**（prompt id/version/hash，**不存正文**）。
 */
import type { ExchangeProducer } from "./portable.js";
import type { MemoryExchangeFormatVersion } from "./version.js";

/** 作用域三键。**必填**，用于跨 user/agent/session 的隔离（05 §3.3 断言 3）。 */
export interface MemoryScope {
	readonly user: string;
	readonly agent: string;
	readonly session: string;
}

/**
 * **跨会话检索**的通配值（ADR-033）。
 *
 * 为什么必须显式定义：写入的记忆带的是**当次会话 id**（溯源），而"长期记忆"的意义在于**后续会话也能检索到**。
 * 今天的检索缝按当前 `sessionId` 查 ⇒ 写进去的记忆只有本会话可见（结构性缺陷，不是配置问题）。
 * 契约：`session: "*"` = "该 `user` + `agent` 下的**所有**会话"，由记忆服务器负责解释；
 * **写入永远用真实会话 id**（`*` 只用于检索）。
 */
export const MEMORY_ANY_SESSION = "*" as const;

/** 失效一条记忆的请求（ADR-034；bitemporal 的"失效而非删除"）。 */
export interface MemoryInvalidateRequest {
	readonly id: string;
	readonly scope: MemoryScope;
	/** 事件时间：从何时起失效；缺省由服务端取当前时刻。 */
	readonly invalidAt?: string;
}

/** 写入溯源——只记 hash，不存 prompt 正文（ADR-010 / 主张 1）。 */
export interface MemoryProvenance {
	readonly promptId: string;
	readonly promptVersion: string;
	readonly promptHash: string;
}

export interface MemoryRecord {
	readonly id: string;
	readonly content: string;
	/** 相似度分数（统一语义：越大越相关）。 */
	readonly score?: number;
	/** 系统时间：写入时刻。 */
	readonly createdAt?: string;
	/** 事件时间：事实生效/失效（bitemporal，ADR & 主张 3）。 */
	readonly validAt?: string | null;
	readonly invalidAt?: string | null;
	readonly provenance?: MemoryProvenance;
}

export interface MemoryAddRequest {
	readonly content: string;
	readonly scope: MemoryScope;
	readonly provenance?: MemoryProvenance;
	/** 附加元数据；**身份键由适配器剥离**，不得用于越权写。 */
	readonly metadata?: Record<string, unknown>;
}

export interface MemorySearchRequest {
	readonly query: string;
	readonly scope: MemoryScope;
	readonly limit?: number;
}

export interface MemorySearchResult {
	readonly records: readonly MemoryRecord[];
}

/**
 * 记忆层适配器（v0.1 **只定义形状、不实现**——长期记忆是 v0.3 的 `extensions` 缝）。
 */
export interface MemoryAdapter {
	add(req: MemoryAddRequest): Promise<MemoryRecord>;
	search(req: MemorySearchRequest): Promise<MemorySearchResult>;
	getSessionMemories(scope: MemoryScope): Promise<MemorySearchResult>;
	/**
	 * 失效一条记忆（ADR-034，**可选**）：服务端没提供失效工具时**不含此方法**。
	 * 缺省 ≠ 静默无操作——写入侧必须据此**如实记录**"没能失效旧事实"。
	 */
	invalidate?(req: MemoryInvalidateRequest): Promise<void>;
}

/*
 * ---------------------------------------------------------------------------------------------
 * 记忆交换文档（ADR-030，兑现主张 4 的**记忆侧**）
 * ---------------------------------------------------------------------------------------------
 */

/** 记忆交换文档格式标识（放在文档里第一眼就能认出这是谁写的）。 */
export const MEMORY_EXCHANGE_FORMAT = "aster-memory-exchange";

export type MemoryExchangeFormat = typeof MEMORY_EXCHANGE_FORMAT;

/**
 * canonical 记忆交换文档。
 *
 * 与 `SessionExchangeDocument`（`portable.ts`）**同构**，纪律也一致：
 *  - **自带 `formatVersion`** —— 外部记忆层（如 mem0 式 MCP）导出的形状普遍没有版本字段，
 *    这正是本主张补的缺口；判定（拒绝更高/更早版本）发生在解析期（`runtime/memory/exchange.ts`）；
 *  - `records` **复用 `MemoryRecord`**：交换格式**不另立**一套记忆形状（单一事实源），
 *    `validAt` / `invalidAt` / `provenance` 等 bitemporal 与溯源字段**原样携带**；
 *  - `scope` **必填**：作用域三键是 ADR-010 的隔离前提，跨实例搬运时必须带上（否则接收方无从重建隔离）。
 *
 * ⚠️ **本格式只负责"搬运"，不负责"写入"**：`MemoryAdapter.add` 按 ADR-016 **显式推迟**
 * ⇒ 今天这份文档用于**导出 / 校验 / 规范化 / 迁移**，**绝不**顺手打开记忆层写入路径。
 */
export interface MemoryExchangeDocument {
	readonly format: MemoryExchangeFormat;
	readonly formatVersion: MemoryExchangeFormatVersion;
	readonly producer: ExchangeProducer;
	readonly scope: MemoryScope;
	readonly records: readonly MemoryRecord[];
}
