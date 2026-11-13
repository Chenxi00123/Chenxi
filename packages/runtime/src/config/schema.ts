/**
 * 本地配置文件契约（ADR-014）。
 *
 * 纪律：**严格**校验（未知键即报错，错误信息含键路径）；字段面刻意保持最小，
 * 后续批次（MCP / 记忆缝 / 沙箱）只往上加。
 */
import { z } from "zod";

/** 单条权限规则；形状必须与 `permission` 的 `PermissionRule` **结构一致**。 */
export const configRuleSchema = z.strictObject({
	/** 工具名，或 `"*"` 通配。 */
	tool: z.string(),
	/** 仅匹配只读/写类工具（缺省不限制）。 */
	readOnly: z.boolean().optional(),
	/** 仅匹配指定作用域（缺省不限制）。 */
	scope: z.enum(["workspace", "outside"]).optional(),
	decision: z.enum(["allow", "deny", "ask"]),
	/** 面向模型/审计的**可读理由**。 */
	reason: z.string(),
});

/** `permissions`：按模式**整段替换**默认规则（未提供的模式保持内置默认）。 */
export const configPermissionsSchema = z.strictObject({
	plan: z.array(configRuleSchema).optional(),
	build: z.array(configRuleSchema).optional(),
});

/**
 * 一个 MCP 服务器声明（ADR-015 / ADR-035）。工具会注册为 `mcp__<name>__<tool>`，
 * 因此 `name` 限定为小写字母/数字/`_`/`-`（避免与命名空间分隔符混淆）。
 *
 * 两种传输**互斥**（union 的 strictObject 会拒掉另一边的键）：
 *  - **stdio**：`command` + `args?` + `env?`；
 *  - **Streamable HTTP**：`url` + `headers?`（请求头可能含凭据 ⇒ **不打印、不落盘**）。
 */
const mcpServerName = z
	.string()
	.regex(/^[a-z0-9][a-z0-9_-]*$/, "must be lowercase [a-z0-9_-] and start with a letter/digit");

const configMcpStdioServerSchema = z.strictObject({
	name: mcpServerName,
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
});

const configMcpHttpServerSchema = z.strictObject({
	name: mcpServerName,
	url: z
		.string()
		.url()
		.refine((value) => /^https?:\/\//i.test(value), "must be an http(s) URL"),
	headers: z.record(z.string(), z.string()).optional(),
});

export const configMcpServerSchema = z.union([
	configMcpStdioServerSchema,
	configMcpHttpServerSchema,
]);

/** `mcp`：MCP 服务器列表（**整段替换**语义，与数组型字段一致）。 */
export const configMcpSchema = z.strictObject({
	servers: z.array(configMcpServerSchema).optional(),
});

/**
 * `memory`：记忆外挂（ADR-016）。`server` **必须**指向某个已声明的 `mcp.servers` 之名
 * （跨字段校验在 `load.ts` 完成），否则"配了记忆却永远查不到"会静默失效。
 */
export const configMemorySchema = z.strictObject({
	server: z.string().min(1),
	/** 服务端侧的检索工具名。 */
	searchTool: z.string().min(1),
	/** 单次注入条数上限（缺省 5）。 */
	limit: z.number().int().min(0).max(50).optional(),
	/** 写入路径（ADR-033 / ADR-034）。**缺省即关闭** ⇒ 行为与不配置时逐字节相同。 */
	write: z
		.strictObject({
			/** 必须**显式**写 `true` 才打开（不设缺省 ⇒ 不配置等于关）。 */
			enabled: z.boolean(),
			/** 服务端侧的写入工具名（`enabled: true` 时必填，跨字段校验在 `load.ts`）。 */
			addTool: z.string().min(1).optional(),
			/** 服务端侧的失效工具名（可选：没有它就只能"写入 + 去重"，**不能**失效旧事实）。 */
			invalidateTool: z.string().min(1).optional(),
			/** 每轮最多抽几条（缺省 3）。 */
			maxCandidates: z.number().int().min(1).max(10).optional(),
			/** 候选最短长度（缺省 4——真实偏好常常很短，"用 vim" 不该被长度闸门挡掉）。 */
			minLength: z.number().int().min(1).max(200).optional(),
			/** 候选最长长度（缺省 200）。 */
			maxLength: z.number().int().min(20).max(2000).optional(),
		})
		.optional(),
});

/**
 * `subagents`：子代理（ADR-017）。**默认关闭**（`enabled` 必填、缺省即不注册 `task` 工具），
 * 以保持默认工具集**恰好 4 个原语**的可声明性。
 */
export const configSubagentsSchema = z.strictObject({
	enabled: z.boolean(),
	/** 最大派生深度（默认 2；达到上限后子会话**不再注册** `task`——结构性防递归）。 */
	maxDepth: z.number().int().min(1).max(5).optional(),
});

/**
 * `context.compaction`：长会话上下文压缩（M23，ADR-041）。
 * **默认关闭**：不配置 `enabled: true` 时 `executeTurn` 完全不做压缩，行为与 M22 逐字节相同。
 */
export const configCompactionSchema = z.strictObject({
	/** 必须**显式**写 `true`（不设缺省 ⇒ 不配置等于关）。 */
	enabled: z.boolean(),
	/** 触发阈值（字符数；缺省 120000）。 */
	maxChars: z.number().int().min(1000).max(10_000_000).optional(),
	/** 保留最近回合数（缺省 2；≥1）。 */
	keepTurns: z.number().int().min(1).max(20).optional(),
});

export const configContextSchema = z.strictObject({
	compaction: configCompactionSchema.optional(),
});

/**
 * 配置文件 v1 字段面（ADR-014 / ADR-015 / ADR-016 / ADR-017）。
 *
 * 注：`mode` 的取值集合必须与 `@aster/schema` 的 `AGENT_MODES` 保持一致
 * （`m7a-acceptance.test.ts` 有断言，避免两处漂移）。
 */
export const configFileSchema = z.strictObject({
	mode: z.enum(["plan", "build"]).optional(),
	model: z.string().min(1).optional(),
	permissions: configPermissionsSchema.optional(),
	mcp: configMcpSchema.optional(),
	memory: configMemorySchema.optional(),
	subagents: configSubagentsSchema.optional(),
	context: configContextSchema.optional(),
});

export type ConfigRule = z.infer<typeof configRuleSchema>;
export type ConfigPermissions = z.infer<typeof configPermissionsSchema>;
export type McpServerDeclaration = z.infer<typeof configMcpServerSchema>;
export type ConfigMcp = z.infer<typeof configMcpSchema>;
export type MemoryDeclaration = z.infer<typeof configMemorySchema>;
export type SubagentsDeclaration = z.infer<typeof configSubagentsSchema>;
export type ConfigContext = z.infer<typeof configContextSchema>;
export type CompactionDeclaration = z.infer<typeof configCompactionSchema>;
export type ConfigFileData = z.infer<typeof configFileSchema>;
