/**
 * 会话/记忆交换格式版本（ADR-003 配套；05-工程规范 §4「显式会话格式版本号」）。
 *
 * 破坏性变更必须递增此值，并在 CHANGELOG 附升级指南。
 * 定位主张 4（跨厂商可移植）在 v0.4 兑现时，此版本号是对外交换契约的锚点。
 */
export const SESSION_FORMAT_VERSION = 1 as const;

export type SessionFormatVersion = typeof SESSION_FORMAT_VERSION;

/** 数据目录内布局的版本锚点（与 SESSION_FORMAT_VERSION 解耦，各自独立演进）。 */
export const STORE_LAYOUT_VERSION = 1 as const;

export type StoreLayoutVersion = typeof STORE_LAYOUT_VERSION;

/**
 * **对外**会话交换文档的版本锚点（ADR-019 / 主张 4）。
 *
 * 与 `SESSION_FORMAT_VERSION`（我们自己的 JSONL 事实源）**解耦**：前者是"别人读我们的文件"的契约，
 * 后者是"我们自己读自己的文件"的契约，各自独立演进。
 * 导入时：`formatVersion > 当前` → 快速失败（绝不静默降级读看不懂的格式）；
 * `formatVersion < 当前` → 走迁移表。破坏性变更必须递增此值，并在 CHANGELOG 附升级指南。
 */
export const EXCHANGE_FORMAT_VERSION = 1 as const;

export type ExchangeFormatVersion = typeof EXCHANGE_FORMAT_VERSION;

/**
 * **对外**记忆交换文档的版本锚点（ADR-030 / 主张 4 的**记忆侧**）。
 *
 * 与 `SESSION_FORMAT_VERSION`（我们自己的事实源）、`EXCHANGE_FORMAT_VERSION`（会话交换）
 * **各自独立演进**：记忆层在 v0.1 起就是**外挂**（MCP，ADR-010），它的对外契约与
 * 会话的对外契约没有理由绑在一起。
 * 导入时同一套门禁：更高版本 → 快速失败；更低版本 → 走迁移表（v1 是首版，暂无迁移路径）。
 */
export const MEMORY_EXCHANGE_FORMAT_VERSION = 1 as const;

export type MemoryExchangeFormatVersion = typeof MEMORY_EXCHANGE_FORMAT_VERSION;
