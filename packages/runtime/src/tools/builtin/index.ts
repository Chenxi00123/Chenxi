/**
 * 内置原语工具集合（ADR-009）。
 *
 * 提供 4 个原语工具（read / bash / edit / write），并作为工具模块的门面出口。
 * 顺序固定为 read, bash, edit, write（descriptors 顺序稳定）。
 */
import type { ShellProvider } from "../../shell/types.js";
import type { AnyToolDefinition } from "../registry.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { createBashTool } from "./bash.js";
export { createEditTool } from "./edit.js";
export { createReadTool } from "./read.js";
export { createWriteTool } from "./write.js";

/** 构造默认工具集：恰好 4 个，顺序 read, bash, edit, write。 */
export function createDefaultToolset(options: {
	shell: ShellProvider;
}): readonly AnyToolDefinition[] {
	return [
		createReadTool(),
		createBashTool({ shell: options.shell }),
		createEditTool(),
		createWriteTool(),
	];
}
