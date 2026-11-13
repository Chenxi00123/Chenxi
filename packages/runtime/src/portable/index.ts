/**
 * portable 模块门面（ADR-019）：会话可移植。
 *
 * 分工：
 *  - `exchange`：canonical 交换文档的构建/解析 + **版本门禁**（纯逻辑）；
 *  - `turns`：厂商适配器共用的中立层 `PortableTurn`（纯逻辑）；
 *  - `claude-code` / `zcode`：两条**best-effort**厂商路径（纯逻辑，有损清单见 ADR-019）；
 *  - `session`：读写侧（走 `persist` 的单一写入路径）。
 */

export * from "./claude-code.js";
export * from "./exchange.js";
export * from "./session.js";
export * from "./turns.js";
export * from "./zcode.js";
