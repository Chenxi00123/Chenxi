/**
 * 内置示例扩展：工具执行超时中间件（ADR-004）。
 *
 * 经 `tools/execute` waterfall 监听器插入：调用 `next()` 委派内置执行，
 * 并与之 `Promise.race`；超时则返回可读的 `timeout` 错误。
 * **不修改主循环 / execute 即生效**——这正是扩展缝的验收点。
 */
import type { ToolExecutionResult } from "@aster/schema";
import type { ToolPipelinePayload } from "../../tools/execute.js";
import type { Extension, ExtensionApi } from "../types.js";

/** 缺省超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 2000;

/** 构造超时信封（面向模型的可读错误）。 */
function timeoutResult(toolName: string, timeoutMs: number): ToolExecutionResult {
	return {
		ok: false,
		error: {
			code: "timeout",
			message: `Tool "${toolName}" timed out after ${timeoutMs}ms.`,
			retryable: true,
		},
	};
}

/** 创建超时扩展（默认 2000ms）。 */
export function createExtensionTimeout(options?: { timeoutMs?: number }): Extension {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		id: "builtin.extension-timeout",
		name: "Tool execution timeout",
		activate(api: ExtensionApi): void {
			api.ctx.on(
				"tools/execute",
				async (payload: unknown, next: unknown): Promise<ToolExecutionResult> => {
					const typed = payload as ToolPipelinePayload;
					const delegate = next as () => Promise<ToolExecutionResult>;
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						return await Promise.race([
							delegate(),
							new Promise<ToolExecutionResult>((resolve) => {
								timer = setTimeout(
									() => resolve(timeoutResult(typed.tool.metadata.name, timeoutMs)),
									timeoutMs,
								);
							}),
						]);
					} finally {
						if (timer !== undefined) clearTimeout(timer);
					}
				},
			);
		},
	};
}
