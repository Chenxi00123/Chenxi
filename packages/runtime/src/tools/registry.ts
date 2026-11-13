/**
 * 工具注册表（ADR-005 / 不变量 2「注册即 effect」）。
 *
 * 注册期即校验：**没有 output 声明的工具不允许注册**（ADR-005）；
 * 注册通过 `ctx.effect()` 完成，插件卸载时自动回滚、注册表归零（判据 #7）。
 */
import type {
	ToolDefinition,
	ToolDescriptor,
	ToolMetadata,
	ToolRiskLevel,
	ToolSideEffectScope,
} from "@chenxi/schema";
import type { Context, Disposer } from "../events/index.js";
import { isValueSchema } from "./schema.js";

export type { ToolDescriptor };

/** 注册期校验失败。 */
export class ToolRegistrationError extends Error {
	readonly toolName: string;
	constructor(toolName: string, message: string) {
		super(`cannot register tool "${toolName}": ${message}`);
		this.name = "ToolRegistrationError";
		this.toolName = toolName;
	}
}

/** 供 llm 请求使用的工具描述（OpenAI 风格；ADR-005 的 prompt 侧投射）。
 *  形状定义在 `@chenxi/schema`，此处仅 re-export。 */

/** 注册表内部存放的异质工具类型（入参/出参已归一为 unknown）。 */
export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

export interface ToolRegistry {
	/** 注册一个工具（经 `ctx.effect()`，返回的 Disposer 可单独卸载）。 */
	register(tool: AnyToolDefinition): Disposer;
	get(name: string): AnyToolDefinition | undefined;
	has(name: string): boolean;
	list(): readonly AnyToolDefinition[];
	/** 投射为模型可见的工具描述（顺序稳定：按注册顺序）。 */
	descriptors(): readonly ToolDescriptor[];
	size(): number;
}

const SIDE_EFFECT_SCOPES: readonly ToolSideEffectScope[] = ["none", "workspace", "host"];
const RISK_LEVELS: readonly ToolRiskLevel[] = ["low", "medium", "high"];

/** 注册期校验：装配完整性 + output 声明必填（ADR-005）。 */
function validateDefinition(tool: AnyToolDefinition): void {
	const meta: ToolMetadata | undefined = tool?.metadata;
	if (meta === undefined) {
		throw new ToolRegistrationError("<unnamed>", "metadata is required");
	}
	if (typeof meta.name !== "string" || meta.name.trim() === "") {
		throw new ToolRegistrationError("<unnamed>", "metadata.name must be a non-empty string");
	}
	if (typeof meta.description !== "string" || meta.description.trim() === "") {
		throw new ToolRegistrationError(meta.name, "metadata.description must be a non-empty string");
	}
	if (typeof meta.readOnly !== "boolean" || typeof meta.destructive !== "boolean") {
		throw new ToolRegistrationError(meta.name, "metadata.readOnly/destructive must be boolean");
	}
	if (!SIDE_EFFECT_SCOPES.includes(meta.sideEffectScope)) {
		throw new ToolRegistrationError(
			meta.name,
			`metadata.sideEffectScope must be one of: ${SIDE_EFFECT_SCOPES.join(", ")}`,
		);
	}
	if (!RISK_LEVELS.includes(meta.riskLevel)) {
		throw new ToolRegistrationError(
			meta.name,
			`metadata.riskLevel must be one of: ${RISK_LEVELS.join(", ")}`,
		);
	}
	if (typeof meta.needsApproval !== "boolean") {
		throw new ToolRegistrationError(meta.name, "metadata.needsApproval must be boolean");
	}
	if (!isValueSchema(tool.input)) {
		throw new ToolRegistrationError(meta.name, "input schema must be a ValueSchema");
	}
	if (tool.output === undefined || tool.output === null) {
		// ADR-005：没有 output 声明的工具不允许注册
		throw new ToolRegistrationError(meta.name, "output schema is REQUIRED (ADR-005)");
	}
	if (!isValueSchema(tool.output)) {
		throw new ToolRegistrationError(meta.name, "output schema must be a ValueSchema");
	}
	if (typeof tool.execute !== "function") {
		throw new ToolRegistrationError(meta.name, "execute must be a function");
	}
}

export function createToolRegistry(ctx: Context): ToolRegistry {
	const tools = new Map<string, AnyToolDefinition>();

	const register = (tool: AnyToolDefinition): Disposer => {
		validateDefinition(tool);
		const name = tool.metadata.name;
		if (tools.has(name)) {
			throw new ToolRegistrationError(name, "a tool with this name is already registered");
		}
		tools.set(name, tool);
		// 注册即 effect：随作用域回滚（判据 #7）
		return ctx.effect(() => () => {
			if (tools.get(name) === tool) tools.delete(name);
		});
	};

	const list = (): readonly AnyToolDefinition[] => [...tools.values()];

	return {
		register,
		get: (name) => tools.get(name),
		has: (name) => tools.has(name),
		list,
		descriptors: () =>
			list().map((tool) => ({
				type: "function" as const,
				function: {
					name: tool.metadata.name,
					description: tool.metadata.description,
					parameters: tool.input.toJsonSchema(),
				},
			})),
		size: () => tools.size,
	};
}
