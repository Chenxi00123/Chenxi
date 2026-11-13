/**
 * 「**绝不碰 C 盘**」的路径落实与校验（ADR-029 ④）——本机红线，**可断言**才敢做。
 *
 * 背景：Electron 默认把 `userData` / `cache` / `sessionData` / `logs` 写到 `%APPDATA%`（C 盘）。
 * 在别的项目这是小事；在本项目是**红线**（`06 §3` 的安装约束：不改 PATH、零系统改动、数据落在 D 盘）。
 *
 * 因此：① main 进程启动时**先把这些路径显式指到数据根**；② 指完再**校验**它们都在数据根之内，
 * 不满足就**拒绝启动并打印原因**（快速失败，绝不静默落到 C 盘）。
 * 校验逻辑是**纯函数**（可在 vitest 里直接断言，不必拉起 Electron）。
 */
import { isAbsolute, relative, resolve } from "node:path";

/** Electron 里需要显式改道的四个路径键（顺序即启动顺序）。 */
export const GUARDED_KEYS = ["userData", "cache", "sessionData", "logs"] as const;
export type GuardedKey = (typeof GUARDED_KEYS)[number];

/** 数据根下的子目录布局（都落在 `<home>\desktop\...`，便于用户一眼看到"数据在哪"）。 */
export function desktopPaths(home: string): Record<GuardedKey, string> {
	const root = resolve(home);
	return {
		userData: root,
		cache: resolve(root, "cache"),
		sessionData: resolve(root, "session"),
		logs: resolve(root, "logs"),
	};
}

export interface PathAudit {
	readonly ok: boolean;
	/** 逐个键的结论（`(缺)` 表示 Electron 没给出该路径）。 */
	readonly entries: readonly {
		readonly key: string;
		readonly path: string;
		readonly inside: boolean;
	}[];
	readonly reason: string;
}

/** 是否落在某个根之内（与 `permission`/`sandbox` 的 `isInsideRoot` 同一语义）。 */
export function isInside(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	if (rel === "") return true;
	if (isAbsolute(rel)) return false;
	return rel.split(/[\\/]/)[0] !== "..";
}

/**
 * 校验"这些路径确实都在数据根里"（**纯函数**：给它一个 `getPath` 就行，不必真跑 Electron）。
 * 任何一项越界 ⇒ `ok=false` + 可读原因（调用方据此**拒绝启动**）。
 */
export function auditDesktopPaths(
	home: string,
	getPath: (key: string) => string,
	keys: readonly string[] = GUARDED_KEYS,
): PathAudit {
	const root = resolve(home);
	const entries: { key: string; path: string; inside: boolean }[] = [];
	for (const key of keys) {
		let value = "";
		try {
			value = getPath(key);
		} catch {
			value = "";
		}
		if (value === "") {
			entries.push({ key, path: "(缺)", inside: false });
			continue;
		}
		entries.push({ key, path: value, inside: isInside(root, value) });
	}
	const bad = entries.filter((entry) => !entry.inside);
	return {
		ok: bad.length === 0,
		entries,
		reason:
			bad.length === 0
				? `全部路径都在数据根内（${root}）`
				: `以下路径**不在**数据根 ${root} 内（绝不碰 C 盘）：${bad
						.map((entry) => `${entry.key}=${entry.path}`)
						.join(", ")}`,
	};
}

/**
 * 数据根本体（与 CLI 的 `CHENXI_HOME` 语义一致，但**不覆盖**已显式设置的环境变量）。
 * 缺省 `<仓库>/\.chenxi`，即**仓库所在盘**（本机为 D 盘）。
 */
export function resolveDesktopHome(
	env: NodeJS.ProcessEnv = process.env,
	fallbackRepoRoot?: string,
): string {
	const fromEnv = env.CHENXI_HOME;
	if (fromEnv !== undefined && fromEnv.trim() !== "") return resolve(fromEnv);
	if (fallbackRepoRoot !== undefined) return resolve(fallbackRepoRoot, ".chenxi");
	return resolve(process.cwd(), ".chenxi");
}

/** 桌面数据根（`<home>\desktop`）——与 CLI 的会话数据同根，GUI 只是多一层子目录。 */
export function desktopDataRoot(home: string): string {
	return resolve(home, "desktop");
}
