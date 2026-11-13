/**
 * M22（ADR-040）renderer 侧的**契约断言**（源码级，防漂移）。
 *
 * renderer 没有 vitest 环境（不引 jsdom），所以这里不做 DOM 单测，而是钉住三条**不可退让**的性质：
 *  ① Markdown 渲染**绝不拼 HTML 字符串**（没有 innerHTML / document.write / eval）；
 *  ② 只有 **assistant** 正文走 Markdown（用户输入 / 工具输出 / 审计行保持逐行文本）；
 *  ③ 搜索与改名都是**视图层**：`chenxi:sessions:rename` 只落桌面标题文件，**不碰 JSONL**。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const renderer = (name: string): string => readFileSync(join(PKG, "renderer", name), "utf8");

describe("Markdown 渲染：安全基线", () => {
	const source = renderer("markdown.js");

	it("绝不拼 HTML 字符串（没有 innerHTML / outerHTML / insertAdjacentHTML / document.write）", () => {
		expect(source).not.toMatch(/\.innerHTML/);
		expect(source).not.toMatch(/\.outerHTML/);
		expect(source).not.toMatch(/insertAdjacentHTML/);
		expect(source).not.toMatch(/document\.write/);
		expect(source).not.toMatch(/\beval\(/);
	});

	it("只用 createElement / createTextNode / textContent 组装", () => {
		expect(source).toContain("document.createElement");
		expect(source).toContain("document.createTextNode");
		expect(source).toContain("textContent");
	});

	it("链接**不可点击**（renderer 的 CSP 不允许导航，故渲染成 span + title）", () => {
		expect(source).not.toContain('"a"');
		expect(source).toContain("md-link");
	});
});

describe("Markdown 只在助手正文启用", () => {
	const app = renderer("app.js");
	const html = renderer("index.html");

	it("index.html 在 app.js **之前**引入 markdown.js", () => {
		expect(html.indexOf("markdown.js")).toBeGreaterThan(-1);
		expect(html.indexOf("markdown.js")).toBeLessThan(html.indexOf("app.js"));
	});

	it("app.js 只对 assistant 调 renderMarkdown，其余仍逐行文本", () => {
		expect(app).toMatch(/card\.role === "assistant"[^\n]*renderMarkdown/);
		// 兜底分支必须还在（否则用户输入 / 工具结果会被当 markdown 解释）
		expect(app).toContain('el("div", "line", line)');
	});
});

describe("搜索 / 改名：视图层，不写事实", () => {
	it("renderer 的搜索只过滤本地列表（不重新读盘）", () => {
		const app = renderer("app.js");
		expect(app).toContain("state.sessions.filter");
		expect(app).not.toMatch(/search[\s\S]{0,200}window\.chenxi\.(list|read)\(/);
	});

	it("改名走独立 IPC，且只落桌面标题文件", () => {
		const main = readFileSync(join(PKG, "src", "main.ts"), "utf8");
		const titles = readFileSync(join(PKG, "src", "session-titles.ts"), "utf8");
		expect(main).toContain('rename: "chenxi:sessions:rename"');
		expect(main).toContain("saveTitle(dataHome");
		// 标题模块**不得**出现任何会话日志写入（JSONL 是唯一事实源的写入面）
		expect(titles).not.toMatch(/appendFile/);
		expect(titles).not.toContain("jsonl");
	});
});
