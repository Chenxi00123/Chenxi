/**
 * bash 原语工具（ADR-009）。
 *
 * 该工具**不绑定 bash**：shell 后端通过依赖注入的 `ShellProvider` 选择
 * （Windows 用 pwsh，类 Unix 用 bash），核心语义不被平台差异污染。
 * 通过注入拿 provider，绝不 import `../shell/index.js`。
 */
import { z } from "zod";
import type { ShellProvider } from "../../shell/types.js";
import type { AnyToolDefinition } from "../registry.js";
import { valueSchema } from "../schema.js";

const bashInputSchema = z.object({
	command: z.string(),
	timeoutMs: z.number().int().min(1).optional(),
});

const bashOutputSchema = z.object({
	providerId: z.string(),
	stdout: z.string(),
	stderr: z.string(),
	exitCode: z.number().int().nullable(),
	timedOut: z.boolean(),
	truncated: z.boolean(),
	hints: z.array(z.string()).optional(),
});

type BashInput = z.infer<typeof bashInputSchema>;
type BashOutput = z.infer<typeof bashOutputSchema>;

export function createBashTool(options: { shell: ShellProvider }): AnyToolDefinition {
	const input = valueSchema(bashInputSchema);
	const output = valueSchema(bashOutputSchema);

	return {
		metadata: {
			name: "bash",
			description:
				"Run a shell command. On Windows the backend is pwsh; on Unix it is bash. Use it for listing/searching files (covers ls/rg/find).",
			readOnly: false,
			destructive: true,
			sideEffectScope: "workspace",
			riskLevel: "high",
			needsApproval: true,
		},
		input,
		output,
		async execute(raw, ctx) {
			const { command, timeoutMs } = raw as BashInput;
			const result = await options.shell.run({
				command,
				cwd: ctx.cwd,
				timeoutMs,
				signal: ctx.signal,
			});

			const value: BashOutput = {
				providerId: result.providerId,
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				truncated: result.truncated,
			};
			// hints 为空时不落字段（避免噪音）
			if (result.hints !== undefined && result.hints.length > 0) {
				value.hints = [...result.hints];
			}
			return value;
		},
	};
}
