/**
 * M11b 验收（第二部分）：**编排共用**（`cli/session-loop.ts`）。
 *
 * ADR-022 把"一个回合"的编排（记忆缝 / 权限钩子 / context 构建 / `runTurn` / 事件出口）
 * 抽成 `createTraceAppender` + `executeTurn`，**REPL 与 server 共用同一份**。本文件只钉死
 * 那条最容易复发的纪律：**所有 append 都必须经同一个 trace 出口**——
 * 否则订阅者（SSE / 镜像）会**静默漏事件**。
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ToolCallId } from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionRepl } from "../src/cli/repl.js";
import { createContext } from "../src/events/index.js";
import { createStubProvider } from "../src/llm/index.js";
import type { ToolRuntime } from "../src/loop/index.js";
import { createPermissionSystem } from "../src/permission/index.js";
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
		await delay(5);
	}
}

/** 真实工具运行时（4 原语）。 */
function buildTools(): ToolRuntime {
	const ctx = createContext();
	const registry = createToolRegistry(ctx);
	for (const tool of createDefaultToolset({ shell: selectShellProvider() }))
		registry.register(tool);
	return { ctx, registry };
}

/** 「一次写调用 + 一次收尾」的桩脚本（目标路径越界 ⇒ 触发 `ask`）。 */
function writeScript(target: string) {
	return [
		{
			content: "",
			toolCalls: [
				{
					callId: "call_write" as ToolCallId,
					toolName: "write",
					input: { path: target, content: "x" },
				},
			],
			stopReason: "tool_call" as const,
		},
		{ content: "done", toolCalls: [], stopReason: "end_turn" as const },
	];
}

describe("M11b 编排共用：REPL 的每一条事实都经同一个出口", () => {
	it("`permission/decision` 也进入 onEvent（曾经绕过 → 订阅者静默漏掉审批事件）", async () => {
		const home = newTemp("chenxi-m11b-repl-");
		const cwd = newTemp("chenxi-m11b-repl-cwd-");
		const target = join(newTemp("chenxi-m11b-repl-out-"), "outside.txt");
		const seen: string[] = [];
		const out: string[] = [];
		// 受控输入：等审批提问真的出现后再作答（否则 "n" 会被当成下一条用户消息）
		const input = new Readable({ read() {} });

		const session = runSessionRepl({
			home,
			cwd,
			mode: "build",
			provider: createStubProvider(writeScript(target)),
			model: "stub",
			tools: buildTools(),
			permission: createPermissionSystem(),
			input,
			output: { write: (text) => out.push(text) },
			onEvent: (event) => seen.push(event.type),
		});

		input.push("go\n");
		await waitFor(() => out.join("").includes("[approval required]"));
		input.push("n\n"); // 拒绝越界写
		await waitFor(() => out.join("").includes("assistant stopped"));
		input.push("/exit\n");
		await session;

		// 修掉的那条漏挂：审批判定必须经同一个出口（此前 `handle.append` 绕过了它）
		expect(seen).toContain("permission/decision");
		expect(seen).toContain("user/message");
		expect(seen).toContain("assistant/message");
		expect(seen).toContain("session/end");
		expect(existsSync(target)).toBe(false);
	});
});
