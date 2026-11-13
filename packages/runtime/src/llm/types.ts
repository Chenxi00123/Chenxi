/**
 * LLM 适配器契约（ADR-001；v0.1 只实现一个 openai-compatible 流式后端）。
 *
 * 设计纪律：
 * - 主循环不直接依赖具体 provider，只依赖本文件的 `LlmProvider` 接口（ADR-004「主循环不写策略」）。
 * - **API key 绝不写入会话日志、绝不打印**（README 环境变量契约）。本模块的错误信息
 *   必须对 key / 请求头做**脱敏**。
 * - 流式 chunk 不落事件；只有**最终** `assistant/message` 落事件（保证投影确定性）。
 */
import type { ModelMessage, StopReason, ToolCallRef, ToolDescriptor } from "@aster/schema";

export interface LlmRequest {
	readonly model: string;
	/** 由 `session.deriveMessages()` 投影得到，绝不旁路构造（核心不变量 1）。 */
	readonly messages: readonly ModelMessage[];
	/** 模型可见的工具描述（由 `tools` 注册表投射；ADR-005）。缺省表示本轮无工具。 */
	readonly tools?: readonly ToolDescriptor[];
	readonly temperature?: number;
	readonly signal?: AbortSignal;
}

export interface LlmUsage {
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
}

/** 模型最终输出（落 `assistant/message` 的内容）。 */
export interface LlmFinalMessage {
	readonly content: string;
	readonly toolCalls: readonly ToolCallRef[];
	readonly stopReason: StopReason;
}

export type LlmStreamEvent =
	| { readonly kind: "text-delta"; readonly text: string }
	| { readonly kind: "usage"; readonly usage: LlmUsage }
	| { readonly kind: "done"; readonly message: LlmFinalMessage };

export interface LlmProvider {
	/** 稳定标识（用于日志与测试断言；不得包含任何密钥信息）。 */
	readonly id: string;
	stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

/** provider 配置（由环境变量解析而来）。 */
export interface LlmProviderConfig {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly defaultModel: string;
	/** 可注入的 fetch（测试用；缺省为全局 fetch）。 */
	readonly fetchImpl?: typeof fetch;
}

/** 缺少/非法环境变量时抛出；错误信息**不得包含已提供的 key 值**。 */
export class LlmConfigError extends Error {
	readonly missing: readonly string[];
	constructor(missing: readonly string[], message?: string) {
		super(message ?? `missing required environment variable(s): ${missing.join(", ")}`);
		this.name = "LlmConfigError";
		this.missing = missing;
	}
}
