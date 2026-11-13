import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			// 测试直接跑源码，避免依赖 dist 构建产物
			"@chenxi/schema": r("./packages/schema/src/index.ts"),
			"@chenxi/protocol": r("./packages/protocol/src/index.ts"),
			"@chenxi/runtime": r("./packages/runtime/src/index.ts"),
		},
	},
	test: {
		include: ["packages/**/test/**/*.test.ts", "packages/**/src/**/*.test.ts"],
		environment: "node",
		pool: "forks",
		/**
		 * 真进程测试（pwsh / Electron / MCP fixture）在**多 worker 并发**下，启动抖动会撞上默认的 5s 上限
		 * ——M23 实测：同一批用例单跑 1.8s 通过、并发时偶发超时（且失败用例随机轮换）。这里放宽到 20s，
		 * **不改任何断言、不跳过任何用例**；纯逻辑单测本来就在毫秒级，不受影响。
		 */
		testTimeout: 20_000,
	},
});
