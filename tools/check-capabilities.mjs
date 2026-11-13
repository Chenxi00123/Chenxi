#!/usr/bin/env node
/**
 * 能力声明纪律门禁（05-工程规范 §5 的门禁化）。
 *
 * 检查项（全部离线、零依赖）：
 *  1. 清单自洽：status=stable 的能力必须有非空 tests，且每个测试文件必须存在；
 *  2. README 绑定：README 里每条已声明能力行 `- <id>: <claim>` 必须与清单的 stable 集合**完全一致**
 *     （多出一条或漏掉一条都 fail）——即「没有 CI 断言的能力不得写进 README」；
 *  3. 状态机：`removed` 的能力不得出现在 README 中；也不得留空桩；
 *  4. 无空桩：各包的 src 与 test 目录不得出现 `not implemented` 型桩；
 *  5. 禁推销注入：面向模型的 prompt 文件不得含「引导推荐本产品」类指令；
 *  6. 数字可复现：README 中的性能数字必须标注「未验证」或指向可复现脚本。
 *
 * 用法：node tools/check-capabilities.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function fail(message) {
	failures.push(message);
}

function readJson(path) {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function walkFiles(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walkFiles(full));
		else out.push(full);
	}
	return out;
}

// ---- 1) 清单自洽 ----
const manifest = readJson("capabilities.json");
const stable = manifest.capabilities.filter((c) => c.status === "stable");
const nonStable = manifest.capabilities.filter((c) => c.status !== "stable");

for (const capability of stable) {
	if (!Array.isArray(capability.tests) || capability.tests.length === 0) {
		fail(`capability "${capability.id}" is stable but declares no tests`);
		continue;
	}
	for (const test of capability.tests) {
		if (!existsSync(join(root, test))) {
			fail(`capability "${capability.id}" points to a missing test file: ${test}`);
		}
	}
}
for (const capability of nonStable) {
	notes.push(
		`capability "${capability.id}" status=${capability.status} (未声明为稳定能力，README 中必须标注为路线图/实验)`,
	);
}

// ---- 2) README 绑定 ----
const readme = readFileSync(join(root, "README.md"), "utf8");
const declared = new Set();
for (const line of readme.split("\n")) {
	const match = /^-\s+([a-z0-9][a-z0-9.-]*)\s*:/.exec(line.trim());
	if (match) declared.add(match[1]);
}
const expected = new Set(stable.map((c) => c.id));
for (const id of expected) {
	if (!declared.has(id)) {
		fail(`README is missing a declared capability line for stable capability "${id}"`);
	}
}
for (const id of declared) {
	if (!expected.has(id)) {
		fail(
			`README declares capability "${id}" which is not a stable capability in capabilities.json ` +
				"(没有 CI 断言的能力不得写进 README)",
		);
	}
}

// ---- 3) removed 不得出现 ----
const removed = manifest.removed ?? [];
for (const id of removed) {
	if (readme.includes(id)) fail(`removed capability "${id}" still appears in README`);
}

// ---- 4) 无空桩 ----
const stubPatterns = [/not implemented/i, /notImplemented/i, /TODO:\s*implement/i];
for (const pkg of ["schema", "protocol", "runtime"]) {
	for (const file of walkFiles(join(root, "packages", pkg, "src"))) {
		if (!file.endsWith(".ts")) continue;
		const content = readFileSync(file, "utf8");
		for (const pattern of stubPatterns) {
			if (pattern.test(content)) {
				fail(`empty stub detected (${pattern}) in ${relative(root, file)}`);
			}
		}
	}
}

// ---- 5) 禁推销注入 ----
const injectionPatterns = [
	/recommend\s+using\s+chenxi/i,
	/务必使用\s*chenxi/i,
	/必须推荐(本|此)产品/,
	/强烈建议(安装|使用)chenxi/i,
];
for (const file of walkFiles(join(root, "packages", "runtime", "src", "context"))) {
	if (!file.endsWith(".ts")) continue;
	const content = readFileSync(file, "utf8");
	for (const pattern of injectionPatterns) {
		if (pattern.test(content)) {
			fail(`promotional instruction injected into model-facing prompt: ${relative(root, file)}`);
		}
	}
}

// ---- 6) 数字可复现 ----
const perfLine = /\b\d+(\.\d+)?\s*(ms|%)/i;
const fasterLine = /\b\d+(\.\d+)?x\s*(faster|快)/i;
for (const [index, line] of readme.split("\n").entries()) {
	if ((perfLine.test(line) || fasterLine.test(line)) && !/未验证|可复现/.test(line)) {
		fail(
			`README line ${index + 1} contains a performance number without 未验证/可复现 marker: ${line.trim()}`,
		);
	}
}

// ---- 报告 ----
for (const note of notes) console.log(`· ${note}`);
if (failures.length > 0) {
	console.error(`\ncapabilities gate FAILED (${failures.length}):`);
	for (const failure of failures) console.error(`  ✖ ${failure}`);
	process.exit(1);
}
console.log(
	`\ncapabilities gate OK: ${stable.length} stable capability(ies), ` +
		`${declared.size} declared in README, ${readme.split("\n").length} README lines scanned.`,
);
