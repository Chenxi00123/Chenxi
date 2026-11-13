/**
 * Tab 补全（ADR-024）：**命令补全 + 路径补全**。
 *
 * 纪律：
 *  - `complete()` 是**纯函数**（目录列举由调用方注入，便于单测；不碰真实文件系统）；
 *  - **补不动就一动不动**：没有匹配 / 无法列举目录时**原样返回**（绝不抛、绝不乱改输入）；
 *  - **只补"看起来像路径"的那个词**（含路径分隔符或以 `.` 开头）——否则正常中文/英文输入
 *    不会被 Tab 干扰（这是"补全不该打扰人"的底线）。
 *
 * 命令表由调用方（CLI/TUI）注入：补全逻辑与"REPL 到底有哪些命令"**不各自维护一份**。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** 目录项（`dir` 为 true 时补全会追加分隔符）。 */
export interface DirEntry {
	readonly name: string;
	readonly dir: boolean;
}

/** 一条命令及其可选参数候选（如 `/mode` → `plan|build`）。 */
export interface CommandSpec {
	readonly name: string;
	readonly args?: readonly string[];
}

export interface CompletionRequest {
	readonly input: string;
	/** 插入点（**字符**下标，与 `EditState.caret` 同一坐标系）。 */
	readonly caret: number;
	/** 当前工作目录（相对路径补全的基准）。 */
	readonly cwd: string;
	readonly commands: readonly CommandSpec[];
	/** 列举目录；**缺省 = 不做路径补全**。返回 `undefined` 表示不可列举（不补全）。 */
	readonly listDir?: (dir: string) => readonly DirEntry[] | undefined;
}

export interface CompletionResult {
	readonly text: string;
	readonly caret: number;
	/** 候选列表（仅当有多个候选且无法再收窄时给出，供提示行展示）。 */
	readonly candidates: readonly string[];
}

const PATH_SEPARATOR_RE = /[\\/]/;
/** 整行是否处于"命令位"：首词形如 `/名字`（**只有字母**，排除 `/tmp/foo` 这类绝对路径）。 */
const COMMAND_TOKEN_RE = /^\/[A-Za-z]+$/;
const COMMAND_ARG_RE = /^\/([^\s/]+)\s+([^\s]*)$/;

/** 最长公共前缀（空数组返回空串）。 */
function commonPrefix(values: readonly string[]): string {
	const first = values[0];
	if (first === undefined) return "";
	let length = first.length;
	for (const value of values.slice(1)) {
		let index = 0;
		while (index < length && index < value.length && first[index] === value[index]) index += 1;
		length = index;
	}
	return first.slice(0, length);
}

/** 看起来像路径吗（含分隔符或以 `.` 开头）。 */
function looksLikePath(word: string): boolean {
	return PATH_SEPARATOR_RE.test(word) || word.startsWith(".");
}

export function complete(request: CompletionRequest): CompletionResult {
	const chars = [...request.input];
	const caret = Math.min(Math.max(0, request.caret), chars.length);
	const before = chars.slice(0, caret).join("");
	const after = chars.slice(caret).join("");
	const unchanged: CompletionResult = { text: request.input, caret, candidates: [] };

	/** 用 `newBefore` 替换 `before` 段，保留光标之后的文本。 */
	const rebuild = (newBefore: string, candidates: readonly string[]): CompletionResult => ({
		text: `${newBefore}${after}`,
		caret: [...newBefore].length,
		candidates,
	});

	// ---- 1) 命令位（首词是 `/名字`，且还没有空格） ----
	const firstToken = before.split(/\s/)[0] ?? "";
	if (before.includes("/") && COMMAND_TOKEN_RE.test(firstToken)) {
		if (before.includes(" ")) {
			// `/mode p` → 补参数（`plan|build`）
			const match = COMMAND_ARG_RE.exec(before);
			if (match === null) return unchanged;
			const spec = request.commands.find((command) => command.name === `/${match[1]}`);
			const choices = spec?.args;
			if (choices === undefined) return unchanged;
			const word = match[2] ?? "";
			const matches = choices.filter((choice) => choice.startsWith(word));
			if (matches.length === 0) return unchanged;
			const completed = matches.length === 1 ? (matches[0] as string) : commonPrefix(matches);
			const head = before.slice(0, before.length - word.length);
			return rebuild(`${head}${completed}`, matches.length === 1 ? [] : matches);
		}
		const matches = request.commands.filter((command) => command.name.startsWith(before));
		if (matches.length === 0) return unchanged;
		if (matches.length === 1) {
			const only = matches[0] as CommandSpec;
			// 带参数的命令补完名后**补一个空格**（下一步就能接着补参数）
			const completed = only.args === undefined ? only.name : `${only.name} `;
			return rebuild(completed, []);
		}
		const prefix = commonPrefix(matches.map((command) => command.name));
		const candidates = matches.map((command) => command.name);
		return prefix === before ? { ...unchanged, candidates } : rebuild(prefix, candidates);
	}

	// ---- 2) 路径补全（只对"看起来像路径"的那一个词生效） ----
	const wordStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t")) + 1;
	const word = before.slice(wordStart);
	if (word === "" || !looksLikePath(word) || request.listDir === undefined) return unchanged;
	const separator = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
	const dirPart = separator === -1 ? "" : word.slice(0, separator + 1);
	const prefix = separator === -1 ? word : word.slice(separator + 1);
	// 列举键**去掉尾分隔符**（`src/` → `<cwd>/src`）：让注入的列举器只需面对一种规范形式
	const listingKey =
		dirPart === "" ? request.cwd : join(request.cwd, dirPart.replace(/[\\/]+$/, ""));
	const entries = request.listDir(listingKey);
	if (entries === undefined) return unchanged;
	const matches = entries.filter((entry) =>
		entry.name.toLowerCase().startsWith(prefix.toLowerCase()),
	);
	if (matches.length === 0) return unchanged;
	const head = before.slice(0, wordStart);
	if (matches.length === 1) {
		const only = matches[0] as DirEntry;
		const completed = `${dirPart}${only.name}${only.dir ? "/" : ""}`;
		return rebuild(`${head}${completed}`, []);
	}
	// 多个候选：只把公共前缀补进去，并把候选**列出来**（由调用方展示）
	const prefixOnly = commonPrefix(matches.map((entry) => entry.name));
	const completed = `${dirPart}${prefixOnly}`;
	const candidates = matches.map((entry) => `${entry.name}${entry.dir ? "/" : ""}`);
	return completed === word
		? { ...unchanged, candidates }
		: rebuild(`${head}${completed}`, candidates);
}

/**
 * 真实文件系统的目录列举（`complete` 的**适配器**；其余逻辑保持纯函数）。
 * 目录不存在 / 无权限 / 是文件 → 返回 `undefined`（调用方据此**不补全**，绝不抛）。
 */
export function createPathLister(): (dir: string) => readonly DirEntry[] | undefined {
	return (dir) => {
		try {
			return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
				name: entry.name,
				dir: entry.isDirectory(),
			}));
		} catch {
			return undefined;
		}
	};
}
