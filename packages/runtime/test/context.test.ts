/**
 * context 模块单元测试（ADR-011 / ADR-013）。
 *
 * 覆盖：默认分节内容、拼装顺序确定性、注册即 effect（幂等卸载）、
 * 模式对账（未缓存）、工具清单投射、稳定/动态分离。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createContextBuilder, createDefaultSections } from "../src/context/index.js";
import { createContext } from "../src/events/index.js";
import { type AnyToolDefinition, createToolRegistry, valueSchema } from "../src/tools/index.js";

/** 结构合法的桩工具（用于验证「可用工具」段投射）。 */
function stubTool(name: string, description: string): AnyToolDefinition {
	return {
		metadata: {
			name,
			description,
			readOnly: true,
			destructive: false,
			sideEffectScope: "none",
			riskLevel: "low",
			needsApproval: false,
		},
		input: valueSchema(z.object({})),
		output: valueSchema(z.object({ value: z.string() })),
		execute: () => ({ value: "ok" }),
	} as unknown as AnyToolDefinition;
}

describe("默认分节", () => {
	it("createContextBuilder 预置默认段，buildSystem 含身份/准则/工具约定关键字", () => {
		const text = createContextBuilder().buildSystem();
		expect(text).toContain("Chenxi"); // 身份
		expect(text).toContain("read-only"); // 准则：先只读探索
		expect(text).toContain("retry"); // 准则：出错不要盲目重试
		expect(text).toContain("fabricate"); // 准则：不要臆造内容
		expect(text).toContain("bash"); // 工具约定
		expect(text).toContain("pwsh"); // Windows 后端
	});

	it("createDefaultSections 稳定段齐全，合计长度很短（< 800 字符）", () => {
		const sections = createDefaultSections();
		expect(sections.length).toBeGreaterThanOrEqual(3);
		expect(sections.every((section) => section.stable)).toBe(true);
		const total = sections.reduce((sum, section) => sum + section.content.length, 0);
		expect(total).toBeLessThan(800);
	});
});

describe("拼装顺序确定性", () => {
	it("相同输入连续两次 buildSystem 结果深等", () => {
		const builder = createContextBuilder();
		expect(builder.buildSystem()).toEqual(builder.buildSystem());
		expect(builder.buildSystem({ mode: "plan", cwd: "d:/ws" })).toEqual(
			builder.buildSystem({ mode: "plan", cwd: "d:/ws" }),
		);
	});

	it("addSection 后新段按注册顺序出现，title 渲染为 `## <title>`", () => {
		const builder = createContextBuilder();
		builder.addSection({ id: "s1", title: "First", content: "MARKER_ONE", stable: true });
		builder.addSection({ id: "s2", title: "Second", content: "MARKER_TWO", stable: true });

		const text = builder.buildSystem();
		expect(text.indexOf("MARKER_ONE")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("MARKER_ONE")).toBeLessThan(text.indexOf("MARKER_TWO"));
		expect(text).toContain("## First");
		// 注册顺序：默认段在前，随后是 s1、s2
		expect(
			builder
				.sections()
				.slice(-2)
				.map((section) => section.id),
		).toEqual(["s1", "s2"]);
	});
});

describe("注册即 effect", () => {
	it("Disposer 卸载后段消失，且重复调用幂等", () => {
		const builder = createContextBuilder();
		const dispose = builder.addSection({ id: "temp", content: "TEMP_MARKER", stable: true });
		expect(builder.sections().some((section) => section.id === "temp")).toBe(true);
		expect(builder.buildSystem()).toContain("TEMP_MARKER");

		dispose();
		dispose(); // 幂等：重复调用无副作用
		expect(builder.sections().some((section) => section.id === "temp")).toBe(false);
		expect(builder.buildSystem()).not.toContain("TEMP_MARKER");
	});
});

describe("模式对账（ADR-013）", () => {
	it("plan/build 文本不同，且分别含 PLAN/BUILD 约束", () => {
		const builder = createContextBuilder();
		const plan = builder.buildSystem({ mode: "plan" });
		const build = builder.buildSystem({ mode: "build" });
		expect(plan).not.toEqual(build);
		expect(plan).toContain("PLAN");
		expect(build).toContain("BUILD");
	});

	it("未缓存：同一 builder 交替 mode，每次都反映当前模式", () => {
		const builder = createContextBuilder();
		const plan1 = builder.buildSystem({ mode: "plan" });
		const build1 = builder.buildSystem({ mode: "build" });
		const plan2 = builder.buildSystem({ mode: "plan" });
		expect(plan1).toEqual(plan2);
		expect(build1).toContain("BUILD");
		expect(build1).not.toContain("PLAN");
		expect(plan2).toContain("PLAN");
		expect(plan2).not.toContain("BUILD");
	});
});

describe("工具清单投射", () => {
	it("传 registry 时含工具名与描述；不传时该段不出现", () => {
		const ctx = createContext();
		const registry = createToolRegistry(ctx);
		registry.register(stubTool("probe", "probe the workspace"));

		const builder = createContextBuilder();
		const withTools = builder.buildSystem({ registry });
		expect(withTools).toContain("probe");
		expect(withTools).toContain("probe the workspace");

		const withoutRegistry = builder.buildSystem();
		expect(withoutRegistry).not.toContain("probe the workspace");
	});
});

describe("稳定/动态分离（ADR-011）", () => {
	it("buildDynamic 只含 stable:false；buildSystem 只含 stable:true", () => {
		const builder = createContextBuilder();
		const dispose = builder.addSection({ id: "dyn", content: "DYNAMIC_MARKER", stable: false });

		const dynamic = builder.buildDynamic();
		expect(dynamic).toContain("DYNAMIC_MARKER");
		expect(dynamic).not.toContain("Chenxi"); // 稳定段不进入动态段

		const system = builder.buildSystem();
		expect(system).toContain("Chenxi");
		expect(system).not.toContain("DYNAMIC_MARKER");

		dispose();
		expect(builder.buildDynamic()).toBe("");
	});
});
