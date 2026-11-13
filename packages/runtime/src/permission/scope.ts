/**
 * 作用域解析（ADR-006 的 `resolveInput` 语义延伸）。
 *
 * 判定「这次调用会触达哪里」：
 *   1. 若归一化后的入参里含路径字段（path / file / filePath / files）→ 按**路径是否在 cwd 内**判定；
 *   2. 否则退化为信任**工具元数据的 `sideEffectScope`**（`none`/`workspace` → workspace；`host` → outside）。
 *
 * ⚠️ 这是「路径越界防护」的同一套判定（05 §3.3 断言 5 要求在任何读文件之前做 `isInsideRoot` 校验）。
 */
import { isAbsolute, relative, resolve } from "node:path";
import { platform } from "node:process";
import type { PermissionRequest } from "@aster/schema";
import type { CallScope } from "./types.js";

const PATH_KEYS = new Set(["path", "file", "filepath", "file_path", "files", "paths"]);

function normalizeForCompare(path: string): string {
	return platform === "win32" ? path.toLowerCase() : path;
}

/** 目标路径是否在根目录之内（含根自身）。 */
export function isInsideRoot(target: string, root: string): boolean {
	const resolvedTarget = resolve(target);
	const resolvedRoot = resolve(root);
	const rel = relative(resolvedRoot, resolvedTarget);
	if (rel === "") return true; // 同一路径
	const normalized = normalizeForCompare(rel);
	if (normalized === ".") return true;
	if (isAbsolute(rel)) return false; // 不同盘符 / 跨卷
	return !normalized.startsWith("..");
}

/** 递归抽取入参中的路径字符串（大小写不敏感地匹配常见键名）。 */
export function extractPaths(input: unknown, depth = 0): string[] {
	if (depth > 4 || input === null || typeof input !== "object") return [];
	const found: string[] = [];
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		const lower = key.toLowerCase();
		if (typeof value === "string" && PATH_KEYS.has(lower)) {
			found.push(value);
			continue;
		}
		if (Array.isArray(value) && PATH_KEYS.has(lower)) {
			for (const item of value) if (typeof item === "string") found.push(item);
			continue;
		}
		if (typeof value === "object" && value !== null) {
			found.push(...extractPaths(value, depth + 1));
		}
	}
	return found;
}

/** 解析调用的作用域。 */
export function resolveCallScope(request: PermissionRequest): CallScope {
	const paths = extractPaths(request.resolvedInput);
	if (paths.length > 0) {
		return paths.every((path) => isInsideRoot(path, request.cwd)) ? "workspace" : "outside";
	}
	// 无路径字段：信任元数据声明（元数据即事实源）
	return request.metadata.sideEffectScope === "host" ? "outside" : "workspace";
}
