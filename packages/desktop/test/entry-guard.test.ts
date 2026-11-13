/**
 * 入口守卫回归测试（M13d-2 实测抓到的**真缺陷**）。
 *
 * 症状：桌面版（M13c 起是 esbuild 单文件 bundle）的入口文件**就是** `argv[1]`，
 * 于是 `cli/main.ts` 里那条"`import.meta.url === argv[1]` 就当作 CLI 入口"的守卫**误报为真** ⇒
 * **CLI 的 `main()` 在 GUI 进程里跑起来**：读 stdin、开一条野生 REPL、往数据根里写会话
 * （冒烟里表现为 `chenxi: unknown argument: --self-check` 与"会话 seq 非单调"）。
 *
 * 修法：`cli/main.ts` 加一个**构建期常量** `CHENXI_CLI_ENTRY`（esbuild `define`）——
 * 打包**可执行 CLI** 时置 `true`、打进**别的 App** 时置 `false`，把这条路关死；
 * 未定义（`tsx` / `tsc` 直跑）时退回 URL 比较。
 *
 * 本文件只做**源码级断言**（两个构建脚本 + 守卫本身），防止这条修法被无声改回去。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const READ = (relative: string): string => readFileSync(join(REPO, relative), "utf8");

describe("入口守卫（构建期常量）", () => {
	const cliMain = READ("packages/runtime/src/cli/main.ts");
	const desktopBuilder = READ("tools/build-desktop-app.mjs");
	const cliBuilder = READ("tools/build-bundle.mjs");

	it("cli/main.ts 的 isMainModule 认这个构建期常量（桌面版打包时必须能关掉它）", () => {
		expect(cliMain).toContain("CHENXI_CLI_ENTRY");
		expect(cliMain).toContain('typeof CHENXI_CLI_ENTRY === "boolean"');
	});

	it("桌面版 bundle 关掉它、CLI bundle 打开它——两面都要显式写死", () => {
		expect(desktopBuilder).toContain('CHENXI_CLI_ENTRY: "false"');
		expect(cliBuilder).toContain('CHENXI_CLI_ENTRY: "true"');
	});
});
