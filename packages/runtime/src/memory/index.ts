/**
 * `@chenxi/runtime/memory` 门面：记忆注入缝与 MCP 外挂适配器（ADR-010 / ADR-011 / ADR-016）
 * + **L1 记忆质量判官**（ADR-028，M12b；纯函数、离线、无 LLM）
 * + **记忆交换文档**（ADR-030，主张 4 的记忆侧；读侧**没有写侧**，见 `portable.ts` 文件头）
 * + **记忆写入路径**（ADR-033 / ADR-034：规则抽取 + 审计事件 + 显式取代；默认关闭）。
 */
export * from "./exchange.js";
export * from "./extract.js";
export * from "./mcp-adapter.js";
export * from "./portable.js";
export * from "./quality.js";
export * from "./seam.js";
export * from "./write.js";
