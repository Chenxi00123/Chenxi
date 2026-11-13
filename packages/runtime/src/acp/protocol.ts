/**
 * ACP（Agent Client Protocol）**最小通道**的线协议类型（ADR-036）。
 *
 * 我们只实现 ACP 里"让一个编辑器客户端驱动 Chenxi 跑会话"所需的那一小块：
 *  - 客户端 → agent：`initialize` / `session/new` / `session/prompt` / `session/cancel`；
 *  - agent → 客户端：`session/update` 通知（正文块 + 工具调用状态）。
 *
 * **显式不做**（否则就是在没有真实客户端的情况下臆造协议面）：
 *  - `session/request_permission`（ACP 的审批通道）⇒ ACP 进程**没有审批通道**，`ask` 一律 fail-closed deny；
 *  - `fs/read_text_file` / `fs/write_text_file` / `terminal/*`（客户端能力）；
 *  - `session/load` / `session/list`（本批只支持新建）；
 *  - MCP 服务器透传（`session/new` 的 `mcpServers` 被**忽略**，我们自己的 MCP 仍走配置）。
 *
 * ⚠️ 按 ACP 公开形状实现，**未与真实 ACP 客户端（Zed）对测** —— 因此能力声明标 `experimental`。
 */

/** ACP 协议版本（整数；本批只支持 1）。 */
export const ACP_PROTOCOL_VERSION = 1 as const;

/** `session/prompt` 的结束原因（ACP 定义的枚举子集）。 */
export type AcpStopReason = "end_turn" | "max_tokens" | "cancelled";

/** agent → 客户端的 `session/update` 载荷（只覆盖我们用得到的三种）。 */
export type AcpSessionUpdate =
	| {
			readonly sessionUpdate: "agent_message_chunk";
			readonly content: { readonly type: "text"; readonly text: string };
	  }
	| {
			readonly sessionUpdate: "tool_call";
			readonly toolCallId: string;
			readonly title: string;
			readonly status: "pending" | "in_progress" | "completed" | "failed";
			readonly kind?: string;
	  }
	| {
			readonly sessionUpdate: "tool_call_update";
			readonly toolCallId: string;
			readonly status: "pending" | "in_progress" | "completed" | "failed";
	  };

/** 一个 prompt 块（只吃文本；其余类型**忽略**并计数，不假装支持）。 */
export interface AcpContentBlock {
	readonly type?: unknown;
	readonly text?: unknown;
}

export interface AcpSessionHost {
	createSession(input: { readonly cwd: string }): Promise<{ readonly sessionId: string }>;
	prompt(input: {
		readonly sessionId: string;
		readonly text: string;
		readonly onUpdate: (update: AcpSessionUpdate) => void;
	}): Promise<{ readonly stopReason: AcpStopReason }>;
	/** 中止该会话当前回合（没有在跑的回合时是 no-op）。 */
	cancel(sessionId: string): void;
	close(): Promise<void>;
}
