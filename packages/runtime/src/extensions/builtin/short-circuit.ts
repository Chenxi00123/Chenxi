/**
 * 内置示例扩展：工具执行短路中间件（ADR-004）。
 *
 * 对指定工具**不调用 `next()`**，从而短路内置执行（内置 `execute` 不会被调用）；
 * 其它工具一律委派下去，行为不受影响。
 */
import type { ToolExecutionResult } from "@aster/schema";
import type { ToolPipelinePayload } from "../../tools/execute.js";
import type { Extension, ExtensionApi } from "../types.js";

export interface ShortCircuitOptions {
	/** 命中即短路的工具名。 */
	readonly toolName: string;
	/** 短路时直接返回的值（作为 `value`）。 */
	readonly value?: unknown;
	/** 人读原因（保留给调用方/日志，不参与返回值构造）。 */
	readonly reason?: string;
}

/** 创建短路扩展：对 `options.toolName` 直接返回 `options.value`。 */
export function createShortCircuitExtension(options: ShortCircuitOptions): Extension {
	return {
		id: "builtin.extension-short-circuit",
		name: "Tool execution short-circuit",
		activate(api: ExtensionApi): void {
			api.ctx.on("tools/execute", (payload: unknown, next: unknown): unknown => {
				const typed = payload as ToolPipelinePayload;
				if (typed.tool.metadata.name !== options.toolName) {
					return (next as () => Promise<unknown>)();
				}
				const result: ToolExecutionResult = { ok: true, value: options.value };
				return result;
			});
		},
	};
}
