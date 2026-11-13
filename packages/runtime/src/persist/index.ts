/**
 * `@aster/runtime/persist` 门面：会话持久化（JSONL 事实源 + 可重建索引）。
 *
 * 一并导出 `paths`（数据目录布局与解析）：子代理（ADR-017）等上层需要按同一套
 * 规则解析 `<home>`，不应各自复制一份路径逻辑。
 */
export * from "./paths.js";
export * from "./store.js";
