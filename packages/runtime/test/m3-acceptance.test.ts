/**
 * M3 验收测试（总工程师独立编写）：逐条咬判据 #1 / #4 / #8 / #11。
 *
 *  - 判据 #1：**完整六段闭环**（流式 -> tool_call(read) -> tool_result -> 第二段 assistant），
 *             且 `read` 工具读的是**真实仓库文件**。
 *  - 判据 #4：**截断整批失败**（stopReason="length" 时该批 toolCall 全部判失败、**不执行**、重发）。
 *  - 判据 #8：**只读工具并发、写类串行**。
 *  - 判据 #11：**Windows 可开箱**（`bash` 工具自动走 pwsh；Unix 惯用法给可读替代提示而非硬失败）。
 *
 * 全程 keyless（桩 provider）、只读、不触碰 C 盘。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	EventDraft,
	EventType,
	SessionEvent,
	ToolCallId,
	ToolCallRef,
	ToolMetadata,
} from "@chenxi/schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import { runTurn } from "../src/loop/index.js";
import { createEventLog, deriveMessages } from "../src/session/index.js";
import { selectShellProvider } from "../src/shell/index.js";
import {
	type AnyToolDefinition,
	createDefaultToolset,
	createToolRegistry,
	executeTool,
	valueSchema,
} from "../src/tools/index.js";

/** monorepo 仓库根（`packages/runtime/test/` 上溯三级）。 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function callId(id: string): ToolCallId {
	return id as ToolCallId;
}

function toolCall(name: string, input: unknown, id: string): ToolCallRef {
	return { callId: callId(id), toolName: name, input };
}

/** 事件追加器（内存日志，等价于 persist 的 handle.append）。 */
function appenderFor(log: ReturnType<typeof createEventLog>) {
	return async <T extends EventType>(draft: EventDraft<T>): Promise<SessionEvent> =>
		log.append(draft);
}

/** 造一个可观测的桩工具（用于并发/串行/截断断言）。 */
function probeTool(name: string, readOnly: boolean, run: () => Promise<void>): AnyToolDefinition {
	const metadata: ToolMetadata = {
		name,
		description: `probe tool ${name}`,
		readOnly,
		destructive: !readOnly,
		sideEffectScope: readOnly ? "none" : "workspace",
		riskLevel: readOnly ? "low" : "high",
		needsApproval: !readOnly,
	};
	return {
		metadata,
		input: valueSchema(z.object({})),
		output: valueSchema(z.object({ done: z.boolean() })),
		execute: async () => {
			await run();
			return { done: true };
		},
	};
}

/** 用真实 4 原语工具 + 真实 shell provider 装配一个运行环境。 */
function realRuntime() {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	const shell = selectShellProvider();
	for (const tool of createDefaultToolset({ shell })) registry.register(tool);
	return { ctx, registry, shell };
}

describe("M3 判据 #1：完整六段闭环（真实 read 工具读真实仓库文件）", () => {
	it("流式 -> tool_call(read) -> tool_result -> 第二段 assistant", async () => {
		const { ctx, registry } = realRuntime();
		const log = createEventLog({ sessionId: "ses_m3_read" as never });
		// 六段的起点：用户输入（真实流程里由 CLI 落盘）
		log.append({ type: "user/message", payload: { content: "summarize package.json" } });

		const provider = createStubProvider([
			{
				content: "",
				toolCalls: [toolCall("read", { path: "package.json", offset: 0, limit: 3 }, "call_1")],
				stopReason: "tool_call",
			},
			{ chunks: ["sum", "mary"], content: "summary", stopReason: "end_turn" },
		]);

		const deltas: string[] = [];
		const result = await runTurn({
			log,
			append: appenderFor(log),
			provider,
			model: "stub-model",
			mode: "plan",
			cwd: REPO_ROOT,
			tools: { ctx, registry },
			onTextDelta: (text) => void deltas.push(text),
		});

		expect(result.stopReason).toBe("end_turn");
		expect(result.steps).toBe(2);
		expect(deltas.join("")).toBe("summary");

		expect(log.events.map((event) => event.type)).toEqual([
			"user/message", // 六段起点
			"turn/start",
			"assistant/message", // 第一次采样（含 toolCall）
			"tool/result", // 真实 read 的执行结果
			"assistant/message", // 第二段 assistant
			"turn/end",
		]);

		const toolResult = log.events.find((event) => event.type === "tool/result");
		expect(toolResult?.type).toBe("tool/result");
		if (toolResult?.type === "tool/result") {
			expect(toolResult.payload.ok).toBe(true);
			const output = toolResult.payload.output as { content?: string; path?: string };
			expect(output.path).toBe(join(REPO_ROOT, "package.json"));
			expect(output.content).toContain('"name": "chenxi"');
		}

		expect(deriveMessages(log.events).map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
	});
});

describe("M3 判据 #4：截断整批失败（不执行 + 重发）", () => {
	it('stopReason="length" 时该批 toolCall 全部判失败、绝不执行', async () => {
		const ctx = createContext();
		const registry = createToolRegistry(ctx);
		let executed = 0;
		registry.register(
			probeTool("probe", true, async () => {
				executed += 1;
			}),
		);

		const log = createEventLog({ sessionId: "ses_m3_trunc" as never });
		const provider = createStubProvider([
			{
				content: "partial...",
				toolCalls: [toolCall("probe", {}, "call_trunc")],
				stopReason: "length",
			},
			{ content: "recovered", stopReason: "end_turn" },
		]);

		const result = await runTurn({
			log,
			append: appenderFor(log),
			provider,
			model: "stub-model",
			mode: "plan",
			cwd: REPO_ROOT,
			tools: { ctx, registry },
		});

		expect(executed).toBe(0);
		expect(result.stopReason).toBe("end_turn");

		const toolResult = log.events.find((event) => event.type === "tool/result");
		expect(toolResult?.type).toBe("tool/result");
		if (toolResult?.type === "tool/result") {
			expect(toolResult.payload.ok).toBe(false);
			expect(toolResult.payload.error?.code).toBe("truncated");
			expect(toolResult.payload.error?.retryable).toBe(true);
		}
		expect(
			log.events
				.filter((event) => event.type === "assistant/message")
				.map((event) => (event.type === "assistant/message" ? event.payload.content : "")),
		).toEqual(["partial...", "recovered"]);
	});
});

describe("M3 判据 #8：只读并发 / 写类串行", () => {
	it("同一批里的两个只读工具并发执行", async () => {
		const ctx = createContext();
		const registry = createToolRegistry(ctx);
		let active = 0;
		let maxActive = 0;
		registry.register(
			probeTool("slowRead", true, async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await sleep(120);
				active -= 1;
			}),
		);

		const log = createEventLog({ sessionId: "ses_m3_par" as never });
		const provider = createStubProvider([
			{
				content: "",
				toolCalls: [toolCall("slowRead", {}, "c1"), toolCall("slowRead", {}, "c2")],
				stopReason: "tool_call",
			},
			{ content: "done", stopReason: "end_turn" },
		]);

		await runTurn({
			log,
			append: appenderFor(log),
			provider,
			model: "stub-model",
			mode: "build",
			cwd: REPO_ROOT,
			tools: { ctx, registry },
		});

		expect(maxActive).toBe(2);
		expect(log.events.filter((event) => event.type === "tool/result")).toHaveLength(2);
	});

	it("同一批里的两个写类工具串行执行", async () => {
		const ctx = createContext();
		const registry = createToolRegistry(ctx);
		let active = 0;
		let maxActive = 0;
		registry.register(
			probeTool("slowWrite", false, async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await sleep(120);
				active -= 1;
			}),
		);

		const log = createEventLog({ sessionId: "ses_m3_ser" as never });
		const provider = createStubProvider([
			{
				content: "",
				toolCalls: [toolCall("slowWrite", {}, "c1"), toolCall("slowWrite", {}, "c2")],
				stopReason: "tool_call",
			},
			{ content: "done", stopReason: "end_turn" },
		]);

		await runTurn({
			log,
			append: appenderFor(log),
			provider,
			model: "stub-model",
			mode: "build",
			cwd: REPO_ROOT,
			tools: { ctx, registry },
		});

		expect(maxActive).toBe(1);
	});
});

describe("M3 判据 #11：Windows 可开箱（bash 工具走 pwsh + 可读替代提示）", () => {
	// Windows-only：`selectShellProvider({platform:"win32"})` 的后端可用性仍取决于**宿主**是否装有 PowerShell，
	// 在 Linux runner 上断言"必定选中 pwsh"没有意义（见 CI 首次运行的失败记录）。
	it.skipIf(process.platform !== "win32")(
		"Windows 选择 pwsh 后端；Unix 惯用法给提示而非硬失败",
		async () => {
			expect(selectShellProvider({ platform: "win32" }).id).toBe("pwsh");

			const { ctx, registry, shell } = realRuntime();
			expect(shell.id).toBe("pwsh");

			// `ls` 是 Unix 惯用法：命令照常执行，但结果里带可读替代提示
			const lsResult = await executeTool({
				ctx,
				registry,
				call: { callId: callId("c_ls"), toolName: "bash", input: { command: "ls" } },
				context: {
					sessionId: "ses_m3_shell",
					callId: callId("c_ls"),
					mode: "plan",
					cwd: REPO_ROOT,
				},
			});
			expect(lsResult.ok).toBe(true);
			if (lsResult.ok) {
				const output = lsResult.value as { providerId: string; hints?: string[] };
				expect(output.providerId).toBe("pwsh");
				expect(output.hints?.join(" ")).toContain("Get-ChildItem");
			}

			// 真实只读命令：在仓库内列出 package.json
			const okResult = await executeTool({
				ctx,
				registry,
				call: {
					callId: callId("c_ok"),
					toolName: "bash",
					input: { command: "Get-ChildItem -Name package.json" },
				},
				context: {
					sessionId: "ses_m3_shell",
					callId: callId("c_ok"),
					mode: "plan",
					cwd: REPO_ROOT,
				},
			});
			expect(okResult.ok).toBe(true);
			if (okResult.ok) {
				const output = okResult.value as { stdout: string; exitCode: number | null };
				expect(output.exitCode).toBe(0);
				expect(output.stdout).toContain("package.json");
			}
		},
	);
});
