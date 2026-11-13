#!/usr/bin/env node
/**
 * 架构治理门禁（05-工程规范 §2）。离线、零依赖。检查：
 *  1. 依赖方向铁律：`schema -> protocol -> runtime` **严格单向**（禁止 forbiddenEdges）；
 *  2. 禁止跨包深层 import（只允许 `@chenxi/<pkg>`，不允许 `@chenxi/<pkg>/<sub>`）；
 *  3. 禁止相对路径逃出本包目录（等价于绕过包边界）；
 *  4. 单文件行数上限（global.maxFileLines）；
 *  5. 包级依赖图无环。
 *
 * 用法：node tools/architecture-check.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(join(root, "architecture-policy.json"), "utf8"));
const failures = [];

function walk(dir) {
	const out = [];
	if (!existsSyncSafe(dir)) return out;
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}
function existsSyncSafe(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

const knownPackages = new Set(policy.modules.map((m) => m.id));
const forbidden = new Set(policy.forbiddenEdges.map((edge) => `${edge.from}->${edge.to}`));

// ---- 1..3) 依赖方向 / 深层 import / 越界相对导入；4) 行数上限 ----
for (const module of policy.modules) {
	const moduleDir = join(root, module.dir);
	for (const file of walk(moduleDir)) {
		if (!file.endsWith(".ts")) continue;
		const content = readFileSync(file, "utf8");
		const rel = relative(root, file).replace(/\\/g, "/");

		// 4) 行数上限（src 与 test 采用两档阈值：测试多为表格化断言，允许更宽）
		const lines = content.split("\n").length;
		const isTest = rel.includes("/test/");
		const limit = isTest
			? (policy.global.maxTestFileLines ?? policy.global.maxFileLines)
			: policy.global.maxFileLines;
		if (lines > limit) {
			failures.push(`${rel}: ${lines} lines exceeds limit=${limit} (must be split)`);
		}

		const importRe = /from\s+"([^"]+)"/g;
		for (const match of content.matchAll(importRe)) {
			const spec = match[1];

			// 2) 深层 import：@chenxi/<pkg>/<sub>
			const deep = /^@chenxi\/([a-z0-9-]+)\/(.+)$/.exec(spec);
			if (deep !== null) {
				failures.push(`${rel}: deep cross-package import "${spec}" is forbidden (use "@chenxi/${deep[1]}")`);
				continue;
			}

			// 1) 依赖方向
			const bare = /^@chenxi\/([a-z0-9-]+)$/.exec(spec);
			if (bare !== null) {
				const target = bare[1];
				if (!knownPackages.has(target)) {
					failures.push(`${rel}: import of unknown workspace package "${spec}"`);
					continue;
				}
				const edge = `${module.id}->${target}`;
				if (module.id === target) continue; // 同包（理论不存在）
				if (forbidden.has(edge)) {
					failures.push(
						`${rel}: dependency direction violated — "${module.id}" must not import "${target}" (${edge})`,
					);
					continue;
				}
				if (!module.requires.includes(target)) {
					failures.push(
						`${rel}: "${module.id}" imports "${target}" which is not in its declared requires ` +
							`[${module.requires.join(", ") || "none"}]`,
					);
				}
				continue;
			}

			// 3) 越界相对导入
			if (spec.startsWith(".")) {
				const target = resolve(dirname(file), spec);
				const inside = !relative(moduleDir, target).startsWith("..");
				if (!inside) {
					failures.push(`${rel}: relative import "${spec}" escapes package boundary (${module.dir})`);
				}
			}
		}
	}
}

// ---- 5) 包级依赖图无环 ----
if (policy.global.forbidCycles) {
	const graph = new Map(policy.modules.map((m) => [m.id, m.requires]));
	const visiting = new Set();
	const done = new Set();
	const detect = (node, trail) => {
		if (done.has(node)) return;
		if (visiting.has(node)) {
			failures.push(`dependency cycle detected: ${[...trail, node].join(" -> ")}`);
			return;
		}
		visiting.add(node);
		for (const next of graph.get(node) ?? []) detect(next, [...trail, node]);
		visiting.delete(node);
		done.add(node);
	};
	for (const module of policy.modules) detect(module.id, []);
}

if (failures.length > 0) {
	console.error(`\narchitecture gate FAILED (${failures.length}):`);
	for (const failure of failures) console.error(`  ✖ ${failure}`);
	process.exit(1);
}
console.log(
	`\narchitecture gate OK: ${policy.modules.length} modules, ` +
		`maxFileLines=${policy.global.maxFileLines}, forbidDeepImports=${policy.global.forbidDeepImports}, ` +
		`forbidCycles=${policy.global.forbidCycles}.`,
);
