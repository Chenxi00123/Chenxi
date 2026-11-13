/**
 * 单文件 ESM bundle 构建脚本（M6）。
 *
 * 用 esbuild JS API 把 CLI 入口打成 `bin/chenxi.mjs`：把 workspace 包
 * （@chenxi/schema、@chenxi/protocol、@chenxi/runtime 内部相对模块）与 zod
 * 一并内联，仅保留 Node 内建模块为 external。
 *
 * 运行：node tools/build-bundle.mjs
 */
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

// 以「脚本自身位置」定位仓库根，绝不写死盘符。
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const entryPoint = path.join(repoRoot, "packages", "runtime", "src", "cli", "main.ts");
const outfile = path.join(repoRoot, "bin", "chenxi.mjs");

// 前置检查：@chenxi/schema、@chenxi/protocol 的编译产物必须先存在（npm run typecheck）。
const requiredDist = [
	path.join(repoRoot, "packages", "schema", "dist", "index.js"),
	path.join(repoRoot, "packages", "protocol", "dist", "index.js"),
];

const missing = requiredDist.filter((p) => {
	try {
		return !statSync(p).isFile();
	} catch {
		return true;
	}
});

if (missing.length > 0) {
	console.error("build-bundle: 缺少编译产物，无法打包。");
	for (const p of missing) {
		console.error(`  - 缺失: ${p}`);
	}
	console.error("请先运行 `npm run typecheck`（= 各包 tsc -b，产出 packages/*/dist）后重试。");
	process.exit(1);
}

const result = await build({
	entryPoints: [entryPoint],
	outfile,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	// platform:"node" 下 esbuild 自动把 node:* 内建模块视为 external；
	// 不设置 packages:"external"，以便把 workspace 包与 zod 全部内联进单文件。
	// 本 bundle **就是**可执行 CLI 入口 ⇒ 打开 `cli/main.ts` 的入口守卫（桌面版那份 bundle 里关掉它）
	define: { CHENXI_CLI_ENTRY: "true" },
	sourcemap: false,
	minify: false,
	legalComments: "eof",
	banner: {
		js: "#!/usr/bin/env node",
	},
});

if (result.errors.length > 0) {
	console.error("build-bundle: esbuild 报错：");
	for (const err of result.errors) {
		console.error(`  - ${err.text}`);
	}
	process.exit(1);
}

// 分发义务：bundle 内联了 zod（MIT），产物里必须保留第三方版权与许可声明。
// esbuild 的 legalComments 只能保留**源码里本来就有**的 @license 注释，而 zod 的 dist 里没有，
// 所以这里显式把 THIRD_PARTY_NOTICES.md 以行注释追加到产物末尾（`//` 前缀保证仍是合法 JS）。
const notices = readFileSync(path.join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8").trimEnd();
appendFileSync(
	outfile,
	`\n\n// ===== THIRD-PARTY NOTICES（随产物分发，勿删） =====\n${notices
		.split("\n")
		.map((line) => (line.length === 0 ? "//" : `// ${line}`))
		.join("\n")}\n`,
	"utf8",
);

const size = statSync(outfile).size;
console.log(`bundled ok: ${outfile} (${size} bytes)`);
