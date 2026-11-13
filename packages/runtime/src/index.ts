/**
 * @aster/runtime 公共入口（M1/M2 已落地：events / session / persist / llm / loop / cli）。
 *
 * 架构纪律：本包依赖 @aster/schema + @aster/protocol；schema/protocol 不得反向依赖本包。
 */

export * as cli from "./cli/index.js";
export * from "./context/compaction.js";
export * from "./events/index.js";
export * from "./llm/index.js";
export * from "./loop/index.js";
export * from "./persist/index.js";
export * from "./session/index.js";

/**
 * 工具载荷 → 可读文本行（**前端中立**的纯函数，由根入口**定向**转出）。
 * 为什么单独放这一条出来：TUI 的工具结果折叠与桌面版的卡片正文**必须用同一套规则**
 * （字符串按行 / 其余 `JSON.stringify(…, null, 2)`），否则两处会各自漂移——
 * 而桌面版只被允许 import `@aster/runtime` 根入口（不得深链 `tui/*`）。
 * 注意：这**不是**"把 tui 摊出来"，只转这一个纯函数。
 */
export { payloadLines } from "./tui/rich-text.js";
