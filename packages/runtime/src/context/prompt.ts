/**
 * context 模块：系统提示词分节拼装 + 工具清单投射（ADR-011 / ADR-013）。
 *
 * 设计要点：
 * - **稳定段**（`stable: true`）按注册顺序拼进 system prompt（顺序确定、吃 prompt cache）；
 * - **动态段**（`stable: false`）单独产出，供 ADR-011 的「挂 user 前缀」使用（v0.3 记忆注入）；
 * - **模式对账**（ADR-013）：`buildSystem({ mode })` **每次调用都重算**模式约束、绝不缓存，
 *   保证压缩/回滚后约束仍然生效；
 * - 工具清单由 `registry.descriptors()` 动态生成（JSON Schema 本身走请求的 `tools` 字段，不进 prompt）；
 * - 不引入 token 估算启发式（方案 R7）：预算由 provider 实测 `usage.prompt_tokens` 衡量。
 */
import type { AgentMode, ToolDescriptor } from "@aster/schema";
import type { Disposer } from "../events/index.js";
import type { ToolRegistry } from "../tools/registry.js";

/** 系统提示词的单个分节。 */
export interface PromptSection {
	readonly id: string;
	/** 可选小标题（拼装时会渲染成 `## <title>`）。 */
	readonly title?: string;
	readonly content: string;
	/**
	 * true = 稳定段（挂 system 尾部，吃 prompt cache）；
	 * false = 动态段（ADR-011：挂 user 前缀，v0.3 记忆注入用）。
	 */
	readonly stable: boolean;
}

/** `buildSystem` 的选项。 */
export interface BuildPromptOptions {
	/** 当前模式，用于渲染模式约束说明（ADR-013：**每请求对账**，压缩/回滚后仍生效）。 */
	readonly mode?: AgentMode;
	/** 当前工作目录。 */
	readonly cwd?: string;
	/** 工具注册表（用于生成「可用工具」段；JSON Schema 本身走请求的 tools 字段，不进 prompt）。 */
	readonly registry?: ToolRegistry;
}

/** 分节式系统提示词构造器。 */
export interface ContextBuilder {
	/** 追加一个分节（**注册即 effect**：返回 Disposer 可卸载）。 */
	addSection(section: PromptSection): Disposer;
	sections(): readonly PromptSection[];
	/** 分节拼装 system prompt（**只取 stable 段**，顺序 = 注册顺序，确定性）。 */
	buildSystem(options?: BuildPromptOptions): string;
	/** 动态段拼装（供 ADR-011 的「挂 user 前缀」使用；v0.3 记忆注入）。 */
	buildDynamic(): string;
}

/** 幂等化：目标最多执行一次，重复调用无副作用。 */
function once(fn: () => void): Disposer {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		fn();
	};
}

/** 渲染单个分节：有 title 时前置 `## <title>`；块间由调用方以空行分隔。 */
function renderSection(section: PromptSection): string {
	const body = section.content.trim();
	const title = section.title?.trim();
	if (title === undefined || title === "") return body;
	return `## ${title}\n${body}`;
}

/**
 * 模式约束块（ADR-013）：**每次调用都基于当前 mode 重算**；
 * 调用方不得缓存本函数结果——压缩/回滚后约束依然写进 prompt。
 */
function renderMode(mode: AgentMode): string {
	const body =
		mode === "plan"
			? "You are in PLAN mode: only read-only exploration is allowed; write and destructive tools are denied. Propose a plan instead of applying changes."
			: "You are in BUILD mode: write and destructive tools are permitted within policy. Apply the requested changes directly.";
	return `## Mode\n${body}`;
}

/** 由注册表投射「可用工具」稳定段（按注册顺序，一行一个 `name: description`）。 */
function renderTools(registry: ToolRegistry): string | undefined {
	const descriptors: readonly ToolDescriptor[] = registry.descriptors();
	if (descriptors.length === 0) return undefined;
	const lines = descriptors.map((d) => `- ${d.function.name}: ${d.function.description}`);
	return `## Available tools\n${lines.join("\n")}`;
}

/** 拼装稳定段（system prompt）。 */
function assembleSystem(sections: readonly PromptSection[], options: BuildPromptOptions): string {
	const blocks: string[] = [];
	for (const section of sections) {
		if (section.stable) blocks.push(renderSection(section));
	}
	const tools = options.registry === undefined ? undefined : renderTools(options.registry);
	if (tools !== undefined) blocks.push(tools);
	if (options.mode !== undefined) blocks.push(renderMode(options.mode));
	if (options.cwd !== undefined && options.cwd.trim() !== "") {
		blocks.push(`## Environment\nWorking directory: ${options.cwd}`);
	}
	return blocks.join("\n\n");
}

/** 拼装动态段（`stable: false`）。 */
function assembleDynamic(sections: readonly PromptSection[]): string {
	const blocks: string[] = [];
	for (const section of sections) {
		if (!section.stable) blocks.push(renderSection(section));
	}
	return blocks.join("\n\n");
}

/** v0.1 的默认稳定分节（身份 + 行为准则 + 工具使用约定），**刻意保持极短**。 */
export function createDefaultSections(): readonly PromptSection[] {
	return [
		{
			id: "identity",
			title: "Identity",
			stable: true,
			content: "You are Aster, a minimal and auditable local agent harness.",
		},
		{
			id: "guidelines",
			title: "Guidelines",
			stable: true,
			content:
				"Explore with read-only tools before changing anything. If a tool call fails, do not retry blindly. Never fabricate file contents or command output.",
		},
		{
			id: "tool-usage",
			title: "Tool usage",
			stable: true,
			content:
				"Use `bash` for search (ls, rg, find) instead of guessing paths. On Windows the shell backend is pwsh.",
		},
	];
}

/** 创建一个分节式上下文构造器（预置 v0.1 默认稳定分节）。 */
export function createContextBuilder(): ContextBuilder {
	const registered: PromptSection[] = [];

	const addSection = (section: PromptSection): Disposer => {
		registered.push(section);
		// 注册即 effect：卸载后该段从拼装中消失，且重复调用幂等
		return once(() => {
			const index = registered.indexOf(section);
			if (index >= 0) registered.splice(index, 1);
		});
	};

	// 预置默认稳定分节（同样纳入注册序列，可被逐段卸载）
	for (const section of createDefaultSections()) addSection(section);

	return {
		addSection,
		sections: () => [...registered],
		buildSystem: (options = {}) => assembleSystem(registered, options),
		buildDynamic: () => assembleDynamic(registered),
	};
}
