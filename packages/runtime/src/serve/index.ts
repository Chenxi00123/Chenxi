/**
 * serve 模块门面（ADR-021 / ADR-022）：client/server 分离的事件流侧。
 *
 * 分工：
 *  - `feed`：事件扇出内核（单全局订阅 + 每连接有界队列；慢消费者只断自己）——**纯逻辑**；
 *  - `source`：服务端的**只读**事实源读取（直接读 JSONL，不碰派生索引）——**纯读**；
 *  - `server`：零依赖 `node:http` + SSE 路由（含 ADR-022 的远端写路径）；
 *  - `driver`：非交互会话驱动器（`POST /prompt` 的后端，单一写入者 + 无审批通道 fail-closed）；
 *  - `client`：SSE 客户端（纯解码 + `connectEventStream`）——`--attach` 镜像的底座。
 */

export * from "./client.js";
export * from "./driver.js";
export * from "./feed.js";
export * from "./server.js";
export * from "./source.js";
