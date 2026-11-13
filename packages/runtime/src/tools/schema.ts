/**
 * `ValueSchema` 的 zod 适配器（ADR-005）。
 *
 * 同一份 zod schema **同时**用于：
 *   - 注册期校验（output 必填、结构合法）
 *   - 执行期校验（入参 / 出参）
 *   - prompt 声明（`toJsonSchema()` 投射给模型）
 * 因此「声明」与「判定」不会漂移（dsh 的「操作边界即判定边界」）。
 */
import type { JsonSchema, SchemaIssue, SchemaParseResult, ValueSchema } from "@aster/schema";
import { z } from "zod";

/** 把 zod schema 包装为 Aster 的 ValueSchema 契约。 */
export function valueSchema<T>(schema: z.ZodType<T>): ValueSchema<T> {
	return {
		kind: "aster/value-schema",
		parse(input: unknown): SchemaParseResult<T> {
			const result = schema.safeParse(input);
			if (result.success) {
				return { ok: true, value: result.data };
			}
			const issues: SchemaIssue[] = result.error.issues.map((issue) => ({
				path: issue.path as readonly (string | number)[],
				message: issue.message,
			}));
			return { ok: false, issues };
		},
		toJsonSchema(): JsonSchema {
			return z.toJSONSchema(schema) as JsonSchema;
		},
	};
}

/** 判断一个未知值是否满足 `ValueSchema` 契约（注册期结构校验用）。 */
export function isValueSchema(value: unknown): value is ValueSchema<unknown> {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { kind?: unknown; parse?: unknown; toJsonSchema?: unknown };
	return (
		candidate.kind === "aster/value-schema" &&
		typeof candidate.parse === "function" &&
		typeof candidate.toJsonSchema === "function"
	);
}
