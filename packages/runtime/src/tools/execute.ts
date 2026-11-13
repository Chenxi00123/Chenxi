/**
 * 工具执行流水线（01 §5 / ADR-005 / ADR-006）。
 *
 * 顺序（固定，与 01 §5 一致）：
 *   1. 查工具（未注册 -> unknown_tool）
 *   2. `resolveInput` 归一化为「将执行的事实」（**早于任何 hook**，ADR-006）
 *   3. **input schema 校验**（不符 -> 可读错误，**不执行**）
 *   4. beforeToolCall hooks（可 `block`）
 *   5. `ctx.waterfall("tools/execute", ...)` —— **扩展缝**；内置执行为其兜底：
 *      `execute` -> **output schema 强制校验**（不符 -> 拒绝 + 可读错误）-> afterToolCall hooks
 *
 * 「可读错误」面向模型：给出工具名、失败阶段、以及逐条字段问题（借鉴 OpenCode 的错误文本风格）。
 */
import type {
	SchemaIssue,
	ToolCallContext,
	ToolCallId,
	ToolError,
	ToolExecutionResult,
} from "@chenxi/schema";
import type { Context } from "../events/index.js";
import type { AnyToolDefinition, ToolRegistry } from "./registry.js";

export interface ToolCallInput {
	readonly callId: ToolCallId;
	readonly toolName: string;
	readonly input: unknown;
}

/**
 * `tools/execute` waterfall 的载荷（扩展缝契约）。
 * 中间件收到 `(payload, next)`：调 `next()` 委派到下一层（最终落到内置执行），
 * **不调 `next()` 即短路内置行为**（ADR-004）。
 */
export interface ToolPipelinePayload {
	readonly call: ToolCallInput;
	readonly tool: AnyToolDefinition;
	/** 已通过 input schema 校验、并已归一化的「将执行的事实」。 */
	readonly input: unknown;
	readonly context: ToolCallContext;
	readonly afterHooks: readonly AfterToolCallHook[];
}

export interface BeforeToolCallBlock {
	readonly block: boolean;
	readonly reason?: string;
	/** 稳定错误码（缺省 `"blocked"`；权限拒绝用 `"permission_denied"`）。 */
	readonly code?: string;
	/** 是否允许模型重试（权限拒绝应为 `false`）。 */
	readonly retryable?: boolean;
}

export type BeforeToolCallHook = (params: {
	readonly call: ToolCallInput;
	readonly tool: AnyToolDefinition;
	readonly resolvedInput: unknown;
	readonly context: ToolCallContext;
}) => Promise<BeforeToolCallBlock | void> | BeforeToolCallBlock | void;

export type AfterToolCallHook = (params: {
	readonly call: ToolCallInput;
	readonly tool: AnyToolDefinition;
	readonly result: ToolExecutionResult;
	readonly context: ToolCallContext;
}) => Promise<void> | void;

export interface ExecuteToolParams {
	readonly ctx: Context;
	readonly registry: ToolRegistry;
	readonly call: ToolCallInput;
	readonly context: ToolCallContext;
	readonly beforeHooks?: readonly BeforeToolCallHook[];
	readonly afterHooks?: readonly AfterToolCallHook[];
}

/** 把 schema 问题格式化为**模型可读**的错误文本。 */
export function formatIssues(
	toolName: string,
	phase: "input" | "output",
	issues: readonly SchemaIssue[],
): string {
	const head =
		phase === "input"
			? `Tool "${toolName}" received input that does not match its input schema.`
			: `Tool "${toolName}" returned a value that does NOT match its declared OUTPUT schema.`;
	const lines = issues.map(
		(issue) => `- ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
	);
	return [head, ...lines].join("\n");
}

function fail(code: string, message: string, retryable: boolean): ToolExecutionResult {
	const error: ToolError = { code, message, retryable };
	return { ok: false, error };
}

/** 内置执行（waterfall 的兜底）：执行工具 + **强制校验 output schema** + after hooks。 */
async function builtinExecute(payload: ToolPipelinePayload): Promise<ToolExecutionResult> {
	let raw: unknown;
	try {
		raw = await payload.tool.execute(payload.input, payload.context);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return fail("execution_error", `Tool "${payload.tool.metadata.name}" failed: ${message}`, true);
	}

	const parsed = payload.tool.output.parse(raw);
	if (!parsed.ok) {
		// 判据 #3：output schema 强制生效——拒绝并把可读错误回灌给模型
		return fail(
			"output_invalid",
			formatIssues(payload.tool.metadata.name, "output", parsed.issues),
			false,
		);
	}

	const result: ToolExecutionResult = { ok: true, value: parsed.value };
	for (const hook of payload.afterHooks ?? []) {
		await hook({
			call: {
				callId: payload.context.callId,
				toolName: payload.tool.metadata.name,
				input: payload.input,
			},
			tool: payload.tool,
			result,
			context: payload.context,
		});
	}
	return result;
}

/** 执行一次工具调用（含全部流水线阶段）。 */
export async function executeTool(params: ExecuteToolParams): Promise<ToolExecutionResult> {
	const tool = params.registry.get(params.call.toolName);
	if (tool === undefined) {
		const available = params.registry
			.list()
			.map((t) => t.metadata.name)
			.join(", ");
		return fail(
			"unknown_tool",
			`Unknown tool "${params.call.toolName}". Available tools: ${available || "(none)"}.`,
			false,
		);
	}

	// 2) 归一化：把入参变为「将执行的事实」（ADR-006，早于 hook）
	let resolvedInput: unknown = params.call.input;
	if (typeof tool.resolveInput === "function") {
		try {
			resolvedInput = tool.resolveInput(params.call.input, params.context);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(
				"input_invalid",
				`Tool "${tool.metadata.name}" input could not be resolved: ${message}`,
				false,
			);
		}
	}

	// 3) input schema 校验（不符即拒绝，不执行）
	const inputParse = tool.input.parse(resolvedInput);
	if (!inputParse.ok) {
		return fail(
			"input_invalid",
			formatIssues(tool.metadata.name, "input", inputParse.issues),
			false,
		);
	}
	const normalized = inputParse.value;

	// 4) beforeToolCall hooks（可 block）
	for (const hook of params.beforeHooks ?? []) {
		const verdict = await hook({
			call: params.call,
			tool,
			resolvedInput: normalized,
			context: params.context,
		});
		if (verdict?.block === true) {
			const reason = verdict.reason ?? "blocked before execution";
			return fail(
				verdict.code ?? "blocked",
				`Tool "${tool.metadata.name}" was blocked: ${reason}`,
				verdict.retryable ?? false,
			);
		}
	}

	// 5) waterfall 扩展缝：内置执行为兜底（中间件可不调 next() 短路）
	const payload: ToolPipelinePayload = {
		call: params.call,
		tool,
		input: normalized,
		context: params.context,
		afterHooks: params.afterHooks ?? [],
	};
	return params.ctx.waterfall<ToolExecutionResult>("tools/execute", payload, builtinExecute);
}
