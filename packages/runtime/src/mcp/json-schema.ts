/**
 * MCP 的 JSON Schema 适配（ADR-015）。
 *
 * 两个适配器：
 *  1. `jsonSchemaValueSchema`：把**服务端原样给的 JSON Schema** 包装为 `ValueSchema`。
 *     - `toJsonSchema()` **原样回传**服务端 schema（模型看到的参数表与服务端一致，注册期**不做** zod 转换）；
 *     - `parse()` 只对**本实现支持的子集**做结构校验，其余关键字一律**忽略**。
 *
 *  本实现支持的子集（**唯一权威列表**，勿臆测）：
 *     - `type`：`object` / `array` / `string` / `number` / `integer` / `boolean` / `null`
 *       （`object` 要求非 null 且非数组）；未声明的 type 不校验；
 *     - `required`：数组，缺键即失败（issue 的 path 用**缺失的键名**）；
 *     - `properties`：对已声明类型的属性做递归校验（仅当该键存在）；
 *     - `enum`：值必须在其中。
 *    **忽略**的关键字（不校验）：`oneOf` / `anyOf` / `allOf` / `format` / `minimum` /
 *    `additionalProperties` / `pattern` 等（未列出的等同于忽略）。
 *
 *  2. `mcpEnvelopeValueSchema`：声明 MCP `CallToolResult` **信封**形状并做执行期校验
 *     （ADR-005 要求 output 必填；我们**只声称知道信封，不声称知道内部载荷**）。
 */
import type { JsonSchema, SchemaIssue, SchemaParseResult, ValueSchema } from "@chenxi/schema";
import { z } from "zod";
import { valueSchema } from "../tools/schema.js";

const FALLBACK_JSON_SCHEMA: JsonSchema = { type: "object" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断值是否满足声明的 type（未声明/未支持的类型一律通过）。 */
function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case "object":
			return isPlainObject(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		default:
			return true;
	}
}

/** 枚举成员判定：原始值用 Object.is，复合值退化为 JSON 结构比较。 */
function enumMatches(candidate: unknown, value: unknown): boolean {
	if (candidate === value) return true;
	if (
		typeof candidate === "object" &&
		candidate !== null &&
		typeof value === "object" &&
		value !== null
	) {
		try {
			return JSON.stringify(candidate) === JSON.stringify(value);
		} catch {
			return false;
		}
	}
	return false;
}

/** 递归校验：只处理已声明子集里的关键字。 */
function validate(
	schema: unknown,
	value: unknown,
	path: readonly (string | number)[],
	issues: SchemaIssue[],
): void {
	if (!isPlainObject(schema)) return;

	const type = schema.type;
	if (typeof type === "string" && !matchesType(type, value)) {
		issues.push({ path, message: `must be of type "${type}"` });
		return; // 类型不符则不再深入
	}

	if (
		Array.isArray(schema.enum) &&
		!schema.enum.some((candidate) => enumMatches(candidate, value))
	) {
		issues.push({ path, message: "must be one of the declared enum values" });
	}

	if (isPlainObject(value) && Array.isArray(schema.required)) {
		for (const key of schema.required) {
			if (typeof key === "string" && !(key in value)) {
				issues.push({ path: [key], message: "required property is missing" });
			}
		}
	}

	if (isPlainObject(value) && isPlainObject(schema.properties)) {
		for (const [key, propertySchema] of Object.entries(schema.properties)) {
			if (key in value) validate(propertySchema, value[key], [key], issues);
		}
	}
}

/**
 * 把服务端给的 JSON Schema 包成 `ValueSchema`。
 * `toJsonSchema()` 原样回传；`parse()` 仅做本文件头列出的**已声明子集**校验。
 */
export function jsonSchemaValueSchema(schema: unknown): ValueSchema<unknown> {
	return {
		kind: "chenxi/value-schema",
		parse(input: unknown): SchemaParseResult<unknown> {
			const issues: SchemaIssue[] = [];
			validate(schema, input, [], issues);
			if (issues.length > 0) return { ok: false, issues };
			return { ok: true, value: input };
		},
		toJsonSchema(): JsonSchema {
			return isPlainObject(schema) ? schema : FALLBACK_JSON_SCHEMA;
		},
	};
}

/**
 * MCP `CallToolResult` 信封的 `ValueSchema`。
 *
 * 宽容度：`content[]` 的每一项**允许携带任意额外键**（信封之外不属于我们的契约），
 * 只强制 `content` 是数组、每项是对象且 `type` 为字符串（`text` 若存在须为字符串）。
 */
export function mcpEnvelopeValueSchema(): ValueSchema<unknown> {
	const schema = z.looseObject({
		content: z.array(
			z.looseObject({
				type: z.string(),
				text: z.string().optional(),
			}),
		),
		isError: z.boolean().optional(),
		structuredContent: z.unknown().optional(),
	});
	return valueSchema(schema);
}
