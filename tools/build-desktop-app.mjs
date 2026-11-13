/**
 * 桌面版「应用目录」构建（M13c）：把 Electron main（含 `@aster/runtime` / schema / protocol）打成**单文件 ESM**，
 * 并把 `renderer/` 与 `preload.cjs` 摆到**同一目录**，产出 `packages/desktop/dist/app/`。
 *
 * 为什么必须打单文件：本仓库是 **npm workspaces**（`node_modules/@aster/runtime` 是**符号链接**）——
 * 便携目录里解析不到它。打成单文件后该目录**自洽**，不再依赖任何 `node_modules`，
 * 也就不需要 electron-builder 那种"把依赖树搬过去"的重型打包器。
 *
 * 目录布局（**开发形态与便携形态共用同一套** ⇒ `src/main.ts` 的路径推导不必分叉）：
 *   dist/app/main.mjs      ← 单文件 bundle（Electron main；ESM，故 `import.meta.url` 原生可用）
 *   dist/app/preload.cjs   ← 原样拷贝（**必须是 CJS**：`sandbox:true` 的 renderer 不支持 ESM preload）
 *   dist/app/renderer/*    ← 原样拷贝（index.html / app.js / style.css）
 *   dist/app/package.json  ← 最小清单（Electron 在便携目录里据 `main` 找入口）
 *
 * 运行：node tools/build-desktop-app.mjs（前置：`npm run desktop-build` = tsc -b，产出各包的 dist）
 */
import { copyFileSync, cpSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// 以「脚本自身位置」定位仓库根，绝不写死盘符。
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const desktopDir = path.join(repoRoot, "packages", "desktop");
const entryPoint = path.join(desktopDir, "src", "main.ts");
const outDir = path.join(desktopDir, "dist", "app");
const outfile = path.join(outDir, "main.mjs");

// 前置检查：依赖包的编译产物必须先存在（bundle 时经 node_modules 符号链接解析到它们）。
const requiredDist = ["schema", "protocol", "runtime"].map((pkg) =>
	path.join(repoRoot, "packages", pkg, "dist", "index.js"),
);
const missing = requiredDist.filter((file) => {
	try {
		return !statSync(file).isFile();
	} catch {
		return true;
	}
});
if (missing.length > 0) {
	console.error("build-desktop-app: 缺少编译产物，无法打包。");
	for (const file of missing) console.error(`  - 缺失: ${file}`);
	console.error("请先运行 `npm run desktop-build`（= tsc -b，产出 packages/*/dist）后重试。");
	process.exit(1);
}

const result = await build({
	entryPoints: [entryPoint],
	outfile,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	// `@aster/*` 与 zod 都是普通依赖 ⇒ 默认全内联；`node:*` 由 platform=node 自动 external；
	// 只有 Electron 运行时本身必须 external（它由宿主进程提供，打进文件反而会坏）。
	external: ["electron"],
	// ⚠️ 关键：本 bundle 的入口文件**就是** `argv[1]`，若不关掉 `cli/main.ts` 的入口守卫，
	// CLI 的 main() 会在 GUI 进程里被误触发（读 stdin、开野生 REPL、往数据根写会话）——实测抓到过。
	define: { ASTER_CLI_ENTRY: "false" },
	sourcemap: false,
	minify: false,
	legalComments: "eof",
});

if (result.errors.length > 0) {
	console.error("build-desktop-app: esbuild 报错：");
	for (const err of result.errors) console.error(`  - ${err.text}`);
	process.exit(1);
}

// 把 renderer/ 与 preload.cjs 摆到与 main 同目录（便携形态下会被整目录拷进 resources/app）
rmSync(path.join(outDir, "renderer"), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(path.join(desktopDir, "renderer"), path.join(outDir, "renderer"), { recursive: true });
copyFileSync(path.join(desktopDir, "preload.cjs"), path.join(outDir, "preload.cjs"));

// 最小清单：Electron 在 `<out>/resources/app/` 形态下据它找入口（`main` 指向单文件 bundle）
const manifest = {
	name: "aster-desktop-app",
	version: "1.0.0",
	private: true,
	description: "Aster desktop app payload (built by tools/build-desktop-app.mjs; do not edit).",
	main: "main.mjs",
};
writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`desktop app ok: ${outDir} (main.mjs ${statSync(outfile).size} bytes)`);
