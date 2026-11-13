/**
 * mcp 模块门面（ADR-015 / ADR-035）：零依赖 stdio 客户端 + Streamable HTTP 客户端
 * + JSON Schema 适配 + 工具桥（提示词 / 资源只读透传）。
 */

export * from "./bridge.js";
export * from "./client.js";
export * from "./http-client.js";
export * from "./json-schema.js";
