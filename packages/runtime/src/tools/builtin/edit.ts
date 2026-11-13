/**
 * edit 原语工具（ADR-009）。
 *
 * 在文件内做**精确文本替换**（不做模糊匹配）。
 * 安全约束：`oldText` 必须唯一出现；若出现多次而未显式声明 `replaceAll:true`，
 * 则**拒绝执行**并给出可读错误（绝不静默只替第一处）。
 * `resolveInput` 把 `path` 归一化为**绝对路径**（ADR-006）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { AnyToolDefinition } from "../registry.js";
import { valueSchema } from "../schema.js";

const editInputSchema = z.object({
	path: z.string(),
	oldText: z.string().min(1),
	newText: z.string(),
	replaceAll: z.boolean().default(false),
});

const editOutputSchema = z.object({
	path: z.string(),
	replacements: z.number().int(),
	bytesWritten: z.number().int(),
});

type EditInput = z.infer<typeof editInputSchema>;

/** 统计子串出现次数（不重叠）。 */
function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

export function createEditTool(): AnyToolDefinition {
	const input = valueSchema(editInputSchema);
	const output = valueSchema(editOutputSchema);

	return {
		metadata: {
			name: "edit",
			description: "Replace an exact text snippet in a file.",
			readOnly: false,
			destructive: true,
			sideEffectScope: "workspace",
			riskLevel: "medium",
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
			const { path, oldText, newText, replaceAll } = raw as EditInput;

			let original: string;
			try {
				original = readFileSync(path, "utf8");
			} catch {
				throw new Error(`File not found: ${path}`);
			}

			const occurrences = countOccurrences(original, oldText);
			if (occurrences === 0) {
				throw new Error(`oldText not found in ${path}`);
			}
			if (occurrences > 1 && replaceAll !== true) {
				throw new Error(
					`oldText appears ${occurrences} times in ${path}; pass replaceAll:true to replace all occurrences`,
				);
			}

			let updated: string;
			let replacements: number;
			if (replaceAll === true) {
				updated = original.split(oldText).join(newText);
				replacements = occurrences;
			} else {
				const index = original.indexOf(oldText);
				updated = original.slice(0, index) + newText + original.slice(index + oldText.length);
				replacements = 1;
			}

			writeFileSync(path, updated, "utf8");
			return {
				path,
				replacements,
				bytesWritten: Buffer.byteLength(updated, "utf8"),
			};
		},
	};
}
