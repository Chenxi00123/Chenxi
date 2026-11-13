/**
 * write 原语工具（ADR-009）。
 *
 * 创建或覆盖工作区文件；父目录缺失时自动创建。
 * `resolveInput` 把 `path` 归一化为**绝对路径**（ADR-006）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { AnyToolDefinition } from "../registry.js";
import { valueSchema } from "../schema.js";

const writeInputSchema = z.object({
	path: z.string(),
	content: z.string(),
});

const writeOutputSchema = z.object({
	path: z.string(),
	bytesWritten: z.number().int(),
	created: z.boolean(),
});

type WriteInput = z.infer<typeof writeInputSchema>;

export function createWriteTool(): AnyToolDefinition {
	const input = valueSchema(writeInputSchema);
	const output = valueSchema(writeOutputSchema);

	return {
		metadata: {
			name: "write",
			description: "Create or overwrite a file in the workspace.",
			readOnly: false,
			destructive: true,
			sideEffectScope: "workspace",
			riskLevel: "high",
			needsApproval: true,
		},
		input,
		output,
		resolveInput(raw, ctx) {
			if (typeof raw !== "object" || raw === null) return raw;
			const record = raw as Record<string, unknown>;
			const path = typeof record.path === "string" ? resolve(ctx.cwd, record.path) : record.path;
			return { ...record, path };
		},
		execute(raw) {
			const { path, content } = raw as WriteInput;

			// 父目录不存在则递归创建
			mkdirSync(dirname(path), { recursive: true });
			const created = !existsSync(path);
			writeFileSync(path, content, "utf8");
			return {
				path,
				bytesWritten: Buffer.byteLength(content, "utf8"),
				created,
			};
		},
	};
}
