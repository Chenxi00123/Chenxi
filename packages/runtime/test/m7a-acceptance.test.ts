/**
 * M7a 验收测试（总工程师独立编写）：本地配置加载与「模式 → 权限」覆盖（ADR-014）。
 *
 * 覆盖 ADR-014 明确要求配 CI 断言的部分：
 *  - **优先级**：CLI 参数 > 环境变量 > 配置文件 > 内置默认；
 *  - **发现与合并**：`<home>/config.json` -> `<cwd>/aster.config.json`，**逐键**合并（近者胜）；
 *    `--config`（CLI）> `ASTER_CONFIG`，且显式路径**跳过**自动发现；
 *  - `permissions` 按模式**整段替换**，**未提供**的模式回退内置默认；
 *  - 未知键 / 非法值 / 非法 JSON -> **可读错误**且快速失败（不含任何敏感取值）；
 *  - 覆盖**真的**落到权限判定上（端到端），且 `/policy` 让它**看得见**。
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
	AgentMode,
	EventDraft,
	EventType,
	PermissionSystem,
	ToolCallId,
	ToolCallRef,
} from "@aster/schema";
import { AGENT_MODES } from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";
import { parseArgs } from "../src/cli/main.js";
import { runSessionRepl } from "../src/cli/repl.js";
import {
	configFileSchema,
	loadConfig,
	resolveDefaultMode,
	withModelFallback,
} from "../src/config/index.js";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import { runTurn } from "../src/loop/index.js";
import {
	createPermissionHook,
	createPermissionSystem,
	DEFAULT_MODE_POLICY,
	resolveModePolicy,
} from "../src/permission/index.js";
import { createEventLog, type EventLog } from "../src/session/index.js";
import { selectShellProvider } from "../src/shell/index.js";
import { createDefaultToolset, createToolRegistry } from "../src/tools/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const temps: string[] = [];

function newTemp(prefix: string): string {
	const dir = makeTempDir(prefix);
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function collector() {
	const chunks: string[] = [];
	return {
		output: { write: (text: string) => void chunks.push(text) },
		text: () => chunks.join(""),
	};
}

function writeJson(path: string, value: unknown): string {
	writeFileSync(path, JSON.stringify(value), "utf8");
	return path;
}

function appenderFor(log: EventLog) {
	return async <T extends EventType>(draft: EventDraft<T>) => log.append(draft);
}

function writeStep(path: string, id: string) {
	return {
		content: "",
		toolCalls: [
			{ callId: id as ToolCallId, toolName: "write", input: { path, content: "m7a\n" } },
		] as ToolCallRef[],
		stopReason: "tool_call" as const,
	};
}

function readStep(path: string, id: string) {
	return {
		content: "",
		toolCalls: [
			{ callId: id as ToolCallId, toolName: "read", input: { path, offset: 0, limit: 5 } },
		] as ToolCallRef[],
		stopReason: "tool_call" as const,
	};
}

/** 跑一个回合：真实 4 原语工具 + 给定权限系统；返回首个 `tool/result` 载荷。 */
async function runOneTurn(p: {
	mode: AgentMode;
	cwd: string;
	step: { content: string; toolCalls: ToolCallRef[]; stopReason: "tool_call" };
	permission: PermissionSystem;
}) {
	const log = createEventLog({ sessionId: "ses_m7a" as never });
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() }))
		registry.register(tool);
	const hook = createPermissionHook({ system: p.permission });

	await runTurn({
		log,
		append: appenderFor(log),
		provider: createStubProvider([p.step, { content: "done", stopReason: "end_turn" }]),
		model: "stub-model",
		mode: p.mode,
		cwd: p.cwd,
		tools: { ctx, registry, beforeHooks: [hook] },
	});

	const event = log.events.find((candidate) => candidate.type === "tool/result");
	return event?.type === "tool/result" ? event.payload : undefined;
}

/** 用配置覆盖项装配权限系统（即 CLI 的真实接线方式）。 */
function permissionFromConfig(permissions: Parameters<typeof resolveModePolicy>[0]) {
	return createPermissionSystem({ policy: resolveModePolicy(permissions) });
}

describe("M7a 配置 schema（严格校验）", () => {
	it("`mode` 取值集合与 `AGENT_MODES` 一致（防两处漂移）", () => {
		for (const mode of AGENT_MODES) {
			expect(configFileSchema.safeParse({ mode }).success).toBe(true);
		}
		expect(configFileSchema.safeParse({ mode: "yolo" }).success).toBe(false);
	});

	it("未知键被拒，且错误信息**含键名**", () => {
		const parsed = configFileSchema.safeParse({ mode: "plan", oops: 1 });
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues.map((issue) => issue.message).join(" ")).toContain("oops");
		}
		// 端到端：用户看到的消息里必须出现键名
		const cwd = newTemp("aster-m7a-unknownkey-");
		writeJson(join(cwd, "aster.config.json"), { mode: "plan", oops: 1 });
		expect(() => loadConfig({ home: newTemp("h-"), cwd, env: {} })).toThrow(/oops/);
	});

	it("嵌套非法值 -> 错误带**键路径**（permissions.plan.0.decision）", () => {
		const parsed = configFileSchema.safeParse({
			permissions: { plan: [{ tool: "*", decision: "maybe", reason: "r" }] },
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			const paths = parsed.error.issues.map((issue) => issue.path.join("."));
			expect(paths).toContain("permissions.plan.0.decision");
		}
	});

	it("`permissions` 下的未知模式名被拒", () => {
		expect(configFileSchema.safeParse({ permissions: { yolo: [] } }).success).toBe(false);
	});

	it("非法 decision / scope 被拒", () => {
		expect(
			configFileSchema.safeParse({
				permissions: { plan: [{ tool: "*", decision: "maybe", reason: "r" }] },
			}).success,
		).toBe(false);
		expect(
			configFileSchema.safeParse({
				permissions: { plan: [{ tool: "*", decision: "allow", scope: "galaxy", reason: "r" }] },
			}).success,
		).toBe(false);
	});
});

describe("M7a 发现与合并（逐键，近者胜）", () => {
	it("自动发现两处并逐键合并：冲突键近者胜，不冲突的键保留", () => {
		const home = newTemp("aster-m7a-home-");
		const cwd = newTemp("aster-m7a-cwd-");
		const userFile = writeJson(join(home, "config.json"), { mode: "build", model: "user-model" });
		const projectFile = writeJson(join(cwd, "aster.config.json"), { mode: "plan" });

		const loaded = loadConfig({ home, cwd, env: {} });
		expect(loaded.sources).toEqual([userFile, projectFile]);
		expect(loaded.mode).toBe("plan"); // 项目级覆盖用户级
		expect(loaded.model).toBe("user-model"); // 未被覆盖的键保留
	});

	it("`ASTER_CONFIG` 显式路径 -> 只读该文件，跳过自动发现", () => {
		const home = newTemp("aster-m7a-env-home-");
		const cwd = newTemp("aster-m7a-env-cwd-");
		writeJson(join(home, "config.json"), { mode: "build" }); // 自动发现候选，但不该被读
		const explicit = writeJson(join(cwd, "explicit.json"), { mode: "plan" });

		const loaded = loadConfig({ home, cwd, env: { ASTER_CONFIG: "explicit.json" } });
		expect(loaded.sources).toEqual([explicit]);
		expect(loaded.mode).toBe("plan");
	});

	it("`--config`（CLI）优先于 `ASTER_CONFIG`", () => {
		const cwd = newTemp("aster-m7a-cli-cwd-");
		const home = newTemp("aster-m7a-cli-home-");
		writeJson(join(cwd, "env.json"), { mode: "build" });
		const cliFile = writeJson(join(cwd, "cli.json"), { mode: "plan" });

		const loaded = loadConfig({
			home,
			cwd,
			env: { ASTER_CONFIG: "env.json" },
			explicitPath: "cli.json",
		});
		expect(loaded.sources).toEqual([cliFile]);
		expect(loaded.mode).toBe("plan");
	});

	it("非法 JSON / 未知键 -> 可读 `ConfigError`（含来源路径）", () => {
		const cwd = newTemp("aster-m7a-bad-");
		const broken = join(cwd, "aster.config.json");
		writeFileSync(broken, "{ not json", "utf8");
		expect(() => loadConfig({ home: newTemp("h-"), cwd, env: {} })).toThrow(/not valid JSON/);

		writeJson(broken, { nope: true });
		expect(() => loadConfig({ home: newTemp("h-"), cwd, env: {} })).toThrow(
			/config error \[.*aster\.config\.json\]/,
		);
		expect(() => loadConfig({ home: newTemp("h-"), cwd, env: {} })).toThrow(/nope/);
	});

	it("`ASTER_CONFIG` 指向缺失文件 -> 快速失败（不静默忽略）", () => {
		const cwd = newTemp("aster-m7a-missing-");
		expect(() =>
			loadConfig({ home: newTemp("h-"), cwd, env: { ASTER_CONFIG: "nope.json" } }),
		).toThrow(/cannot read file/);
	});
});

describe("M7a 默认模式优先级：CLI > env > 配置文件 > 内置", () => {
	it("逐级覆盖顺序正确，缺省回退内置 plan", () => {
		const config = { mode: "build" as const, sources: [] };
		expect(resolveDefaultMode({ config: { sources: [] } })).toBe("plan");
		expect(resolveDefaultMode({ config })).toBe("build");
		expect(resolveDefaultMode({ env: { ASTER_MODE: "plan" }, config })).toBe("plan");
		expect(resolveDefaultMode({ cliMode: "build", env: { ASTER_MODE: "plan" }, config })).toBe(
			"build",
		);
	});

	it("`ASTER_MODE` 非法值 -> 可读错误（不回显取值）", () => {
		expect(() =>
			resolveDefaultMode({ env: { ASTER_MODE: "yolo" }, config: { sources: [] } }),
		).toThrow(/must be one of: plan, build/);
	});

	it("`model` 只作兜底：已设置 `ASTER_MODEL` 时绝不覆盖", () => {
		expect(withModelFallback({}, { model: "cfg", sources: [] })).toEqual({ ASTER_MODEL: "cfg" });
		expect(withModelFallback({ ASTER_MODEL: "env" }, { model: "cfg", sources: [] })).toEqual({
			ASTER_MODEL: "env",
		});
		// 空白串视为「未设置」
		expect(withModelFallback({ ASTER_MODEL: "   " }, { model: "cfg", sources: [] })).toEqual({
			ASTER_MODEL: "cfg",
		});
	});
});

describe("M7a permissions：按模式整段替换，未提供的模式回退默认", () => {
	const locked = [{ tool: "*", decision: "deny" as const, reason: "locked by config" }];

	it("只覆盖 build -> plan 保持内置默认", () => {
		const policy = resolveModePolicy({ build: locked });
		expect(policy.plan).toBe(DEFAULT_MODE_POLICY.plan);
		expect(policy.build).toEqual(locked);
	});

	it("未提供 permissions -> 与内置默认**同一对象**", () => {
		expect(resolveModePolicy(undefined)).toBe(DEFAULT_MODE_POLICY);
	});
});

describe("M7a 覆盖真的落到权限判定上（端到端）", () => {
	it("收紧：把 plan 配成一律拒绝 -> plan 下 `read` 也被拒，理由来自配置", async () => {
		const cwd = newTemp("aster-m7a-tighten-");
		writeFileSync(join(cwd, "target.txt"), "hello\n", "utf8");
		const home = newTemp("aster-m7a-tighten-home-");
		writeJson(join(home, "config.json"), {
			permissions: { plan: [{ tool: "*", decision: "deny", reason: "配置：plan 下一律拒绝" }] },
		});

		const loaded = loadConfig({ home, cwd, env: {} });
		const result = await runOneTurn({
			mode: "plan",
			cwd,
			step: readStep("target.txt", "c1"),
			permission: permissionFromConfig(loaded.permissions),
		});

		expect(result?.ok).toBe(false);
		expect(result?.error?.code).toBe("permission_denied");
		expect(result?.error?.message ?? "").toContain("配置：plan 下一律拒绝");
	});

	it("放松（必须显式写出）：plan 配置放行 workspace 内写 -> 写入真的成功", async () => {
		const cwd = newTemp("aster-m7a-loosen-");
		const home = newTemp("aster-m7a-loosen-home-");
		writeJson(join(home, "config.json"), {
			permissions: {
				plan: [
					{ tool: "*", readOnly: true, decision: "allow", reason: "只读放行（配置）" },
					{
						tool: "*",
						scope: "workspace",
						decision: "allow",
						reason: "配置：plan 下允许 workspace 内写",
					},
				],
			},
		});

		const loaded = loadConfig({ home, cwd, env: {} });
		const result = await runOneTurn({
			mode: "plan",
			cwd,
			step: writeStep(join(cwd, "written.txt"), "c1"),
			permission: permissionFromConfig(loaded.permissions),
		});

		expect(result?.ok).toBe(true);
		expect(existsSync(join(cwd, "written.txt"))).toBe(true);
	});

	it("未提供 permissions 时，plan 下写仍被拒（安全默认未被破坏）", async () => {
		const cwd = newTemp("aster-m7a-default-");
		const result = await runOneTurn({
			mode: "plan",
			cwd,
			step: writeStep(join(cwd, "nope.txt"), "c1"),
			permission: permissionFromConfig(undefined),
		});

		expect(result?.ok).toBe(false);
		expect(result?.error?.code).toBe("permission_denied");
		expect(existsSync(join(cwd, "nope.txt"))).toBe(false);
	});
});

describe("M7a `/policy` 让覆盖看得见（REPL）", () => {
	it("打印生效的两模式规则（自定义 build 规则与默认 plan 规则并存）", async () => {
		const home = newTemp("aster-m7a-policy-home-");
		const cwd = newTemp("aster-m7a-policy-cwd-");
		writeJson(join(home, "config.json"), {
			permissions: { build: [{ tool: "bash", decision: "deny", reason: "no bash here" }] },
		});
		const loaded = loadConfig({ home, cwd, env: {} });

		const collected = collector();
		await runSessionRepl({
			home,
			cwd,
			permission: permissionFromConfig(loaded.permissions),
			input: Readable.from(["/policy\n", "/exit\n"]),
			output: collected.output,
		});

		const text = collected.text();
		expect(text).toContain("policy build: bash=deny"); // 配置覆盖生效
		expect(text).toContain("policy plan:"); // 未提供的模式回退默认
		expect(text).toContain("readonly");
	});
});

describe("M7a --doctor 配置文件状态", () => {
	it("找到且合法 -> 退出码 0，并报告来源路径", async () => {
		const home = newTemp("aster-m7a-doc-home-");
		const cwd = newTemp("aster-m7a-doc-cwd-");
		const file = writeJson(join(cwd, "aster.config.json"), { mode: "build" });

		const collected = collector();
		const code = await runDoctor({
			home,
			cwd,
			output: collected.output,
			env: {},
			nodeVersion: "22.23.2",
			platform: "win32",
		});

		expect(code).toBe(0);
		expect(collected.text()).toContain("✔ config");
		expect(collected.text()).toContain(file);
	});

	it("配置非法 -> 退出码 1（启动器会因此拒绝启动）", async () => {
		const home = newTemp("aster-m7a-docbad-home-");
		const cwd = newTemp("aster-m7a-docbad-cwd-");
		writeFileSync(join(cwd, "aster.config.json"), "{ not json", "utf8");

		const collected = collector();
		const code = await runDoctor({
			home,
			cwd,
			output: collected.output,
			env: {},
			nodeVersion: "22.23.2",
			platform: "win32",
		});

		expect(code).toBe(1);
		expect(collected.text()).toContain("✖ config");
		expect(collected.text()).toContain("not valid JSON");
	});

	it("未发现配置文件 -> 退出码 0 且标注 none found", async () => {
		const collected = collector();
		const code = await runDoctor({
			home: newTemp("aster-m7a-docnone-home-"),
			cwd: newTemp("aster-m7a-docnone-cwd-"),
			output: collected.output,
			env: {},
			nodeVersion: "22.23.2",
			platform: "win32",
		});

		expect(code).toBe(0);
		expect(collected.text()).toContain("none found (built-in defaults)");
	});
});

describe("M7a CLI 参数面", () => {
	it("`--config` 被接受；未提供 `--mode` 时为 undefined（留给 env/配置文件）", () => {
		expect(parseArgs(["--config", "x.json"]).config).toBe("x.json");
		expect(parseArgs([]).mode).toBeUndefined();
		expect(parseArgs(["--mode", "build"]).mode).toBe("build");
	});
});
