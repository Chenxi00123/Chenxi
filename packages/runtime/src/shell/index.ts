/**
 * shell 模块公共入口（ADR-009）。
 *
 * 上层 `bash` 工具**不绑定 bash**：通过 `selectShellProvider` 在 bash / pwsh 之间选择，
 * 平台差异被收敛到本模块内部。
 */

export * from "./bash.js";
export * from "./hints.js";
export * from "./pwsh.js";
export * from "./types.js";

import type { Sandbox } from "../sandbox/types.js";
import { createBashProvider } from "./bash.js";
import { createPwshProvider } from "./pwsh.js";
import type { ShellProvider, ShellProviderId } from "./types.js";

/**
 * 选择 shell 后端（规则 ADR-009，已定死）：
 * 1. 若指定 `prefer` 且该 provider 可用 -> 用它；
 * 2. 否则 Windows（`win32`）-> 优先 `pwsh`，不可用回退 `bash`；
 * 3. 否则类 Unix -> 优先 `bash`，不可用回退 `pwsh`。
 *
 * `sandbox`（ADR-027）**缺省 undefined ⇒ 不启用**：两个 provider 的行为与 M3 起逐字节相同。
 */
export function selectShellProvider(options?: {
	platform?: NodeJS.Platform;
	prefer?: ShellProviderId;
	sandbox?: Sandbox;
}): ShellProvider {
	const platform = options?.platform ?? process.platform;
	const sandbox = options?.sandbox;
	const bash = createBashProvider(sandbox === undefined ? {} : { sandbox });
	const pwsh = createPwshProvider(sandbox === undefined ? {} : { sandbox });

	const prefer = options?.prefer;
	if (prefer !== undefined) {
		const preferred = prefer === "bash" ? bash : pwsh;
		if (preferred.isAvailable()) return preferred;
	}

	if (platform === "win32") {
		return pwsh.isAvailable() ? pwsh : bash;
	}
	return bash.isAvailable() ? bash : pwsh;
}
