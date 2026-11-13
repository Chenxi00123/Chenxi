/**
 * 桌面版「便携目录」组装（M13c / ADR-029 的 M13c）。
 *
 * 做法（**手动组装**，不用 electron-builder）——把一个自洽的 Electron App 摆出来：
 *   <out>/                               ← 便携根（默认落在**仓库所在盘**，即 D 盘）
 *     aster-desktop.exe                  ← 就是 Electron 运行时（改名只为双击时看得懂）
 *     *.dll / *.pak / locales/ ...       ← 原样来自 `node_modules/electron/dist/`
 *     resources/app/                     ← `tools/build-desktop-app.mjs` 的产物（自洽：无 node_modules）
 *
 * 为什么不引 electron-builder（三条本机/纪律理由，写下来免得后人重踩）：
 *  ① **供应链纪律不变**：不新增带二进制的大 devDependency（仓库只钉精确版本 + 禁生命周期脚本）；
 *  ② **二进制来源**：electron-builder 的 NSIS / winCodeSign 走 GitHub（本机默认源下不来，Electron 当初
 *     就是靠 npmmirror 镜像才装上的）⇒ 要么卡死要么得再找一个镜像；
 *  ③ **杀软误报**：`07 §5` 有前车之鉴（自解压 exe 易被误报）。
 * 代价：**不是单文件 exe**，而是"解压即跑"的目录——而这正是 portable 的定义，也符合"零系统改动"纪律。
 *
 * 运行：node tools/build-desktop-portable.mjs（前置：`npm run desktop-app`）
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const electronDist = path.join(repoRoot, "node_modules", "electron", "dist");
const appPayload = path.join(repoRoot, "packages", "desktop", "dist", "app");
// 便携根放在**仓库外**（`<仓库父目录>\dist-desktop\`）：既不进 zip 快照，也不与源码树混在一起
const outRoot = path.resolve(repoRoot, "..", "dist-desktop", "aster-desktop");

for (const [label, dir] of [
	["Electron 运行时", electronDist],
	["应用产物（先跑 npm run desktop-app 或 desktop-build）", appPayload],
]) {
	if (!existsSync(dir)) {
		console.error(`build-desktop-portable: 缺少${label}：${dir}`);
		if (dir === appPayload) {
			console.error("  提示：`packages/desktop/dist/app/` 由 `node tools/build-desktop-app.mjs` 产出。");
		}
		process.exit(1);
	}
}
if (existsSync(path.join(appPayload, "renderer", "index.html")) === false) {
	console.error(`build-desktop-portable: 应用产物不完整（缺 renderer/index.html）：${appPayload}`);
	process.exit(1);
}

// 从零重建（便携目录是**产物**，不是增量工作区）
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

// ① Electron 运行时整棵树（exe / dll / pak / locales …）
cpSync(electronDist, outRoot, { recursive: true });

// ② 改名：双击时看得懂（Electron 允许改名——它按 **exe 同级的 resources/app** 找入口，与文件名无关）
const exe = path.join(outRoot, "aster-desktop.exe");
if (existsSync(path.join(outRoot, "electron.exe"))) renameSync(path.join(outRoot, "electron.exe"), exe);

// ③ 应用产物 → `resources/app/`（`resources/` 已由运行时带出来，这里只补 app 子树）
cpSync(appPayload, path.join(outRoot, "resources", "app"), { recursive: true });

const bytes = (p) => {
	try {
		return statSync(p).size;
	} catch {
		return 0;
	}
};
console.log(`portable ok: ${outRoot}`);
console.log(`  entry      : ${exe} (${bytes(exe)} bytes)`);
console.log(`  app main   : resources/app/main.mjs (${bytes(path.join(outRoot, "resources", "app", "main.mjs"))} bytes)`);
console.log(`  自检命令   : ${exe} --self-check`);
