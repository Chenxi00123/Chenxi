/**
 * read 原语工具（ADR-009）。
 *
 * 只读：按行窗口（offset/limit）读取工作区文本文件。
 * `resolveInput` 把 `path` 归一化为**绝对路径**（ADR-006：归一化为「将执行的事实」），
 * 早于任何 PreToolUse 钩子执行，权限判定/审计读到的是真正会被操作的路径。
 *
 * M6：增加**输出字节上限**（`MAX_OUTPUT_BYTES`），超限则按 UTF-8 字符边界截断并置
 * `truncated: true` + `truncatedReason: "bytes"`，避免把超大文件灌进上下文。
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { AnyToolDefinition } from "../registry.js";
import { valueSchema } from "../schema.js";

/** 单次 read 的输出字节上限（超出则截断）。 */
const MAX_OUTPUT_BYTES = 65_536;

const readInputSchema = z.object({
	path: z.string(),
	offset: z.number().int().min(0).default(0),
	limit: z.number().int().min(1).default(200),
});

const readOutputSchema = z.object({
	path: z.string(),
	content: z.string(),
	startLine: z.number().int(),
	endLine: z.number().int(),
	totalLines: z.number().int(),
	truncated: z.boolean(),
	/** 截断原因：`window`=行窗口之外仍有内容；`bytes`=输出字节超限。截断时必填。 */
	truncatedReason: z.enum(["window", "bytes"]).optional(),
});

type ReadInput = z.infer<typeof readInputSchema>;

/**
 * 按 UTF-8 字节截断到不超过 `maxBytes`：落在字符中间时回退掉不完整尾字符，
 * 保证输出始终是合法 UTF-8。返回截断后的文本与是否发生截断。
 */
function capUtf8Bytes(text: string, maxBytes: number): { text: string; capped: boolean } {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return { text, capped: false };
	const slice = buffer.subarray(0, maxBytes).toString("utf8");
	return { text: slice.endsWith("\uFFFD") ? slice.slice(0, -1) : slice, capped: true };
}

export function createReadTool(): AnyToolDefinition {
	const input = valueSchema(readInputSchema);
	const output = valueSchema(readOutputSchema);

	return {
		metadata: {
			name: "read",
			description:
				`Read a text file from the workspace (line-based offset/limit). ` +
				`Output is capped at ${MAX_OUTPUT_BYTES} bytes.`,
			readOnly: true,
			destructive: false,
			sideEffectScope: "none",
			riskLevel: "low",
			needsApproval: false,
		},
		input,
		output,
		resolveInput(raw, ctx) {
			// 非对象入参原样透传，交给 input schema 给出可读的字段级错误
			if (typeof raw !== "object" || raw === null) return raw;
			const record = raw as Record<string, unknown>;
			const path = typeof record.path === "string" ? resolve(ctx.cwd, record.path) : record.path;
			// 归一化为「将执行的事实」：绝对路径 + 行窗口（缺省由 input schema 兜底）
			return { path, offset: record.offset, limit: record.limit };
		},
		execute(raw) {
			const { path, offset, limit } = raw as ReadInput;

			let isDirectory = false;
			try {
				isDirectory = statSync(path).isDirectory();
			} catch {
				throw new Error(`File not found: ${path}`);
			}
			if (isDirectory) {
				throw new Error(
					`Path is a directory, not a file: ${path}. Use the bash tool (e.g. ls) to inspect a directory.`,
				);
			}

			const text = readFileSync(path, "utf8");
			const all = text.split("\n");
			// 末尾换行符不构成额外一行
			const lines = all.length > 1 && all.at(-1) === "" ? all.slice(0, -1) : all;
			const totalLines = lines.length;
			const slice = lines.slice(offset, offset + limit);
			const windowTruncated = offset + limit < totalLines;
			const capped = capUtf8Bytes(slice.join("\n"), MAX_OUTPUT_BYTES);
			// 字节超限优先于行窗口作为截断原因（前者更严重、更需要模型换用更窄窗口）
			const reason = capped.capped === true ? "bytes" : windowTruncated ? "window" : undefined;
			// startLine 为首行（0 基）；endLine 为窗口的排他结束位置
			return {
				path,
				content: capped.text,
				startLine: offset,
				endLine: offset + slice.length,
				totalLines,
				truncated: reason !== undefined,
				...(reason === undefined ? {} : { truncatedReason: reason }),
			};
		},
	};
}
