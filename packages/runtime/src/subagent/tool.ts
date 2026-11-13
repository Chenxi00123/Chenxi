/**
 * `task` 工具（ADR-017 / ADR-018）：把「派发子代理」实现成**一个普通工具**，而不是主循环的新分支，
 * 从而复用 `loop` / `persist` / `permission` / `tools` 的全部既有语义。
 *
 * 纪律：
 *  - **元数据即权限事实源**（ADR-006）：`readOnly:false` / `destructive:false` /
 *    `sideEffectScope:"workspace"` / `riskLevel:"medium"` / `needsApproval:false`；
 *    任一字段改动都会改变权限语义，**不得擅自调整**（`fork` / `background` 都不改它）；
 *  - **模式取当次调用**：`execute(input, context)` 用 `context.mode` 派发，
 *    保证父会话切换模式后子代理继承切换后的模式（ADR-017）；
 *  - **父模型只看到这份结果**（`output` 由 zod 声明，ADR-005）：看不到子代理的工具轨迹，
 *    这正是隔离的意义；`background:true` 时只拿回一个 `status:"running"` 句柄，
 *    真正的结果稍后经 `subagent/result` 事件在**下一回合**送达（ADR-018）；
 *  - **父会话访问权取当次调用**：`context.sessionLog` 原样透传给 runner（`fork` / `background` 必需）。
 */
import type {
	SessionId,
	SubagentKind,
	ToolCallContext,
	ToolDefinition,
	ValueSchema,
} from "@chenxi/schema";
import { z } from "zod";
import type { AnyToolDefinition } from "../tools/registry.js";
import { valueSchema } from "../tools/schema.js";
import type { SubagentRunner } from "./runner.js";

/** `task` 工具入参。 */
interface TaskInput {
	readonly prompt: string;
	readonly kind?: SubagentKind;
	readonly background?: boolean;
}

/** `task` 工具出参（逐字段向模型声明）：`completed` 带结果，`running` 只带句柄。 */
interface TaskOutput {
	readonly childSessionId: string;
	readonly kind: SubagentKind;
	readonly status: "completed" | "running";
	readonly summary?: string;
	readonly steps?: number;
	readonly stopReason?: string;
}

/** 写给模型看的工具说明（英文）。 */
const TASK_DESCRIPTION = [
	"Dispatch a subagent that runs in its OWN isolated session:",
	'it receives only the `prompt` you pass here (use `kind:"fork"` to additionally import YOUR current context),',
	"and you get back ONLY its final text summary (plus its child session id, step count and stop reason),",
	"NOT its tool-call trace. The subagent CANNOT ask you or the user for approval, so any action that would need",
	"approval is denied inside it — keep such actions in your own session. Use it for self-contained subtasks",
	"that can be described fully in one prompt.",
	'With `background:true` the call returns immediately with status "running"; the subagent\'s result is then',
	"delivered to you as a `<subagent-result …>` message in one of your LATER steps — do not wait or poll for it,",
	"and do not call the same task twice hoping for the result.",
].join(" ");

export function createTaskTool(runner: SubagentRunner): AnyToolDefinition {
	const input: ValueSchema<TaskInput> = valueSchema(
		z.object({
			prompt: z.string().min(1),
			kind: z.enum(["fresh", "fork"]).optional(),
			background: z.boolean().optional(),
		}),
	);
	// `stopReason` 用 `z.string()`：`@chenxi/schema` 只导出 `StopReason` **类型**，未导出取值常量，
	// 故不臆造枚举值，交由上游类型系统约束。
	const output: ValueSchema<TaskOutput> = valueSchema(
		z.object({
			childSessionId: z.string(),
			kind: z.enum(["fresh", "fork"]),
			status: z.enum(["completed", "running"]),
			summary: z.string().optional(),
			steps: z.number().int().optional(),
			stopReason: z.string().optional(),
		}),
	);

	const tool: ToolDefinition<TaskInput, TaskOutput> = {
		metadata: {
			name: "task",
			description: TASK_DESCRIPTION,
			readOnly: false,
			destructive: false,
			sideEffectScope: "workspace",
			riskLevel: "medium",
			needsApproval: false,
		},
		input,
		output,
		resolveInput(raw): TaskInput {
			const candidate = (raw ?? {}) as {
				readonly prompt?: unknown;
				readonly kind?: unknown;
				readonly background?: unknown;
			};
			// 空白 prompt 归一化为空串，交给 input schema 报错（不在此处抛）
			const prompt = typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
			return {
				prompt,
				...(candidate.kind === undefined ? {} : { kind: candidate.kind as SubagentKind }),
				...(candidate.background === undefined
					? {}
					: { background: candidate.background as boolean }),
			};
		},
		async execute(raw, context: ToolCallContext): Promise<TaskOutput> {
			const result = await runner.dispatch({
				prompt: raw.prompt,
				...(raw.kind === undefined ? {} : { kind: raw.kind }),
				...(raw.background === undefined ? {} : { background: raw.background }),
				mode: context.mode,
				// 父会话 = **当次调用**所在的会话（子会话 `session/start.parentSessionId`）
				parentSessionId: context.sessionId as SessionId,
				// ADR-018：fork（读父投影）/ background（结果落父会话）都靠这份访问权
				...(context.sessionLog === undefined ? {} : { sessionLog: context.sessionLog }),
			});
			if (result.status === "running") {
				return { childSessionId: result.childSessionId, kind: result.kind, status: "running" };
			}
			return {
				childSessionId: result.childSessionId,
				kind: result.kind,
				status: "completed",
				summary: result.summary,
				steps: result.steps,
				stopReason: result.stopReason,
			};
		},
	};
	return tool as AnyToolDefinition;
}
