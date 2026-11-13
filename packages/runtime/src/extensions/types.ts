/**
 * extensions 模块公共类型契约（ADR-004「扩展缝」）。
 *
 * 「注册即 effect」：扩展在 `activate` 期间经 `api` 做出的一切注册，
 * 都由宿主纳入 `ctx.effect()` 作用域；卸载时全部回滚。
 */
import type { Context, Disposer } from "../events/index.js";
import type { AnyToolDefinition } from "../tools/registry.js";

/** 交给扩展的受限操作面（只暴露扩展被允许触碰的注册入口）。 */
export interface ExtensionApi {
	/** 事件上下文（waterfall / on 等注册缝）。 */
	readonly ctx: Context;
	/** 注册工具（可选）；返回 Disposer。宿主未提供注册表时调用将抛出可读错误。 */
	registerTool(tool: AnyToolDefinition): Disposer;
}

/** 一个扩展单元：稳定 id + 人读名称 + 激活函数。 */
export interface Extension {
	/** 稳定标识，如 "builtin.extension-timeout"。 */
	readonly id: string;
	/** 人读名称。 */
	readonly name: string;
	/** 激活扩展：一切注册走 `effect` 语义，返回值被纳入可卸载范围（ADR-004「注册即 effect」）。 */
	activate(api: ExtensionApi): Disposer | void;
}

/** 扩展宿主：负责加载、枚举与卸载扩展。 */
export interface ExtensionHost {
	/** 加载一个扩展；返回 Disposer（卸载后该扩展的一切注册**全部回滚**）。 */
	load(extension: Extension): Promise<Disposer>;
	/** 已加载的扩展 id 列表。 */
	list(): readonly string[];
	/** 卸载全部。 */
	unloadAll(): void;
}
