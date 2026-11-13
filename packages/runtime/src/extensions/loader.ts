/**
 * 扩展宿主实现（ADR-004「扩展缝」）。
 *
 * 核心语义：**注册即 effect**——`load` 在 `ctx.effect()` 内执行 `activate`，
 * 因此扩展做出的一切注册都随返回的 Disposer 一并回滚；卸载后注册表归零。
 */
import type { Context, Disposer } from "../events/index.js";
import type { AnyToolDefinition, ToolRegistry } from "../tools/registry.js";
import type { Extension, ExtensionApi, ExtensionHost } from "./types.js";

/**
 * 创建扩展宿主。
 *
 * @param ctx 事件上下文（扩展经此注册监听器等）。
 * @param registry 可选工具注册表；缺省时扩展调用 `registerTool` 会抛可读错误。
 */
export function createExtensionHost(ctx: Context, registry?: ToolRegistry): ExtensionHost {
	/** 已加载扩展 id -> 该扩展的 effect Disposer。 */
	const loaded = new Map<string, Disposer>();

	const load = async (extension: Extension): Promise<Disposer> => {
		if (loaded.has(extension.id)) {
			throw new Error(`extension "${extension.id}" is already loaded`);
		}

		const api: ExtensionApi = {
			ctx,
			registerTool: (tool: AnyToolDefinition): Disposer => {
				if (registry === undefined) {
					throw new Error(
						`extension "${extension.id}" cannot register a tool: ` +
							"this extension host was created without a ToolRegistry",
					);
				}
				return registry.register(tool);
			},
		};

		// 注册即 effect：activate 期间的一切注册纳入本次作用域，卸载时全部回滚
		const disposer = ctx.effect(() => extension.activate(api));
		loaded.set(extension.id, disposer);

		// 包装为幂等 Disposer：卸载一次即回滚并移出列表，重复调用无副作用
		return () => {
			const current = loaded.get(extension.id);
			if (current === undefined) return;
			loaded.delete(extension.id);
			current();
		};
	};

	const list = (): readonly string[] => [...loaded.keys()];

	const unloadAll = (): void => {
		for (const disposer of [...loaded.values()]) disposer();
		loaded.clear();
	};

	return { load, list, unloadAll };
}
