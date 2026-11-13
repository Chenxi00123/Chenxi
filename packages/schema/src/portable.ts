/**
 * 会话交换文档契约（ADR-019，兑现主张 4「跨厂商可移植的版本化会话格式」）。
 *
 * **纯类型/常量**（本包零依赖）：版本化与迁移的**实现**在 `runtime/portable`。
 *
 * 设计要点：
 *  - **一个 canonical 文档**是唯一的对外契约（`chenxi-session-exchange`），厂商适配器只是它的投影；
 *  - 文档**自带 `formatVersion`** —— 这正是本主张补的缺口：ZCode 自己的会话文件
 *    （`zcodeSessionFileSchema = { meta, messages, fileChanges?, turnCheckpoints? }`）**没有版本字段**；
 *  - `events` 逐条保存我们的会话事件（含 `session/start`），因此 Chenxi ↔ Chenxi 往返**语义无损**。
 */
import type { SessionEvent } from "./events.js";
import type { AgentMode } from "./mode.js";
import type { ExchangeFormatVersion } from "./version.js";

/** 文档格式标识（放在文档里第一眼就能认出这是谁写的）。 */
export const EXCHANGE_FORMAT = "chenxi-session-exchange";

export type ExchangeFormat = typeof EXCHANGE_FORMAT;

/** CLI `--format` 的取值域：`chenxi` = canonical 文档；其余为厂商适配器（best-effort、有损）。 */
export const PORTABLE_FORMATS = ["chenxi", "claude-code", "zcode"] as const;

export type PortableFormat = (typeof PORTABLE_FORMATS)[number];

export interface ExchangeProducer {
	/** 产出方名字（缺省 `chenxi`）。 */
	readonly name: string;
	/** 产出方版本（来自 `package.json`）。 */
	readonly version: string;
}

/** 文档级会话元数据（**不含** `sessionId`：导入方新建会话，身份属于导入方）。 */
export interface ExchangeSessionMeta {
	readonly cwd: string;
	readonly mode: AgentMode;
	readonly model?: string;
	/** ISO-8601（取原会话 `session/start` 的事件时间）。 */
	readonly createdAt: string;
	/** ISO-8601（取原会话最后一条事件的时间）。 */
	readonly updatedAt: string;
}

/**
 * canonical 会话交换文档。
 * `formatVersion` 只用 `ExchangeFormatVersion`：**类型只描述合法文档**，
 * 判定（拒绝更高/非法版本）发生在解析期（`runtime/portable/exchange.ts`）。
 */
export interface SessionExchangeDocument {
	readonly format: ExchangeFormat;
	readonly formatVersion: ExchangeFormatVersion;
	readonly producer: ExchangeProducer;
	readonly session: ExchangeSessionMeta;
	readonly events: readonly SessionEvent[];
}
