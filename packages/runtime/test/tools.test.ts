/**
 * tools 模块单元测试（ADR-005 / ADR-006 / ADR-009）。
 *
 * 自洽：不真跑 shell（bash 用内联假 ShellProvider），
 * 所有文件操作只发生在 `makeTempDir` 造出的临时目录内。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCallContext, ToolError, ToolExecutionResult } from "@aster/schema";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createContext } from "../src/events/index.js";
import type { ShellProvider, ShellRunRequest, ShellRunResult } from "../src/shell/types.js";
import {
	type AnyToolDefinition,
	createBashTool,
	createDefaultToolset,
	createEditTool,
	createReadTool,
	createToolRegistry,
	createWriteTool,
	executeTool,
	ToolRegistrationError,
	valueSchema,
} from "../src/tools/index.js";
import { makeTempDir } from "./helpers/tmp.js";

/** 造一个临时工作目录作为 cwd。 */
function tempCwd(): string {
	return makeTempDir("aster-tools-");
}

/** 构造 ToolCallContext（callId 为 branded 类型，需断言）。 */
function toolContext(cwd: string): ToolCallContext {
	return {
		sessionId: "ses_test",
		callId: "call_1" as ToolCallContext["callId"],
		mode: "build",
		cwd,
	};
}

/** 自造注册表 + 事件上下文。 */
function makeHarness() {
	const ctx = createContext();
	return { ctx, registry: createToolRegistry(ctx) };
}

function callOf(toolName: string, input: unknown) {
	return { callId: "call_1" as ToolCallContext["callId"], toolName, input };
}

/** 断言失败并取回可读错误。 */
function expectFail(result: ToolExecutionResult): ToolError {
	if (result.ok) throw new Error("expected failure, got success");
	return result.error;
}

/** 断言成功并取回值。 */
function expectOk<T = unknown>(result: ToolExecutionResult): T {
	if (!result.ok) throw new Error(`expected success, got: ${result.error.message}`);
	return result.value as T;
}

/** 构造一个结构合法的桩工具（可覆写 input/output/execute）。 */
function stubTool(options: {
	name: string;
	input?: unknown;
	output?: unknown;
	execute?: (input: unknown, ctx: ToolCallContext) => unknown;
}): AnyToolDefinition {
	return {
		metadata: {
			name: options.name,
			description: `stub tool ${options.name}`,
			readOnly: true,
			destructive: false,
			sideEffectScope: "none",
			riskLevel: "low",
			needsApproval: false,
		},
		input: options.input ?? valueSchema(z.object({})),
		output: options.output ?? valueSchema(z.object({ value: z.string() })),
		execute: options.execute ?? (() => ({ value: "ok" })),
	} as unknown as AnyToolDefinition;
}

/** 内联假 ShellProvider：返回固定结果，不真跑 shell。 */
class FakeShellProvider implements ShellProvider {
	readonly id: ShellProvider["id"] = "pwsh";
	readonly runs: ShellRunRequest[] = [];

	isAvailable(): boolean {
		return true;
	}

	async run(request: ShellRunRequest): Promise<ShellRunResult> {
		this.runs.push(request);
		return {
			providerId: "pwsh",
			stdout: "hello\n",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			truncated: false,
			durationMs: 1,
			hints: [],
		};
	}
}

describe("注册期校验（ADR-005）", () => {
	it("缺 output 的工具不允许注册", () => {
		const { registry } = makeHarness();
		const missingOutput = {
			metadata: {
				name: "no-output",
				description: "missing output",
				readOnly: true,
				destructive: false,
				sideEffectScope: "none",
				riskLevel: "low",
				needsApproval: false,
			},
			input: valueSchema(z.object({})),
			// 故意不声明 output
			execute: () => ({}),
		} as unknown as AnyToolDefinition;

		expect(() => registry.register(missingOutput)).toThrow(ToolRegistrationError);
	});

	it("重名注册抛错", () => {
		const { registry } = makeHarness();
		registry.register(stubTool({ name: "dup" }));
		expect(() => registry.register(stubTool({ name: "dup" }))).toThrow(ToolRegistrationError);
	});
});

describe("注册即 effect（判据 #7）", () => {
	it("作用域回滚后注册表归零、无残留", () => {
		const { ctx, registry } = makeHarness();

		const dispose = ctx.effect(() => registry.register(createReadTool()));
		expect(registry.size()).toBe(1);
		expect(registry.has("read")).toBe(true);

		dispose();
		expect(registry.size()).toBe(0);
		expect(registry.has("read")).toBe(false);
	});
});

describe("descriptors 投射", () => {
	it("形状为 OpenAI function，parameters 是 JSON Schema", () => {
		const { registry } = makeHarness();
		registry.register(createReadTool());

		const descriptors = registry.descriptors();
		expect(descriptors).toHaveLength(1);
		const descriptor = descriptors[0];
		expect(descriptor?.type).toBe("function");
		expect(descriptor?.function.name).toBe("read");
		expect(typeof descriptor?.function.description).toBe("string");
		expect(descriptor?.function.parameters.type).toBe("object");
	});
});

describe("executeTool 未知工具", () => {
	it("返回 unknown_tool 且列出可用工具名", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(createReadTool());

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("does_not_exist", {}),
			context: toolContext(tempCwd()),
		});

		const error = expectFail(result);
		expect(error.code).toBe("unknown_tool");
		expect(error.message).toContain("read");
	});
});

describe("input schema 强制", () => {
	it("类型不符时 input_invalid 且消息含字段名", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(createReadTool());

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("read", { path: 123 }),
			context: toolContext(tempCwd()),
		});

		const error = expectFail(result);
		expect(error.code).toBe("input_invalid");
		expect(error.message).toContain("path");
	});
});

describe("output schema 强制（判据 #3）", () => {
	it("execute 返回不符合声明 output 的值 -> output_invalid", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(
			stubTool({
				name: "bad-output",
				output: valueSchema(z.object({ value: z.string() })),
				execute: () => ({ value: 123 }),
			}),
		);

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("bad-output", {}),
			context: toolContext(tempCwd()),
		});

		const error = expectFail(result);
		expect(error.code).toBe("output_invalid");
		expect(error.message).toContain("bad-output");
	});

	it("返回符合声明 output 的值 -> ok:true", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(
			stubTool({
				name: "good-output",
				output: valueSchema(z.object({ value: z.string() })),
				execute: () => ({ value: "ok" }),
			}),
		);

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("good-output", {}),
			context: toolContext(tempCwd()),
		});

		expect(expectOk<{ value: string }>(result).value).toBe("ok");
	});
});

describe("beforeToolCall hook 阻断", () => {
	it("返回 block 时 code=blocked 且消息含 reason", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(stubTool({ name: "stub" }));

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("stub", {}),
			context: toolContext(tempCwd()),
			beforeHooks: [() => ({ block: true, reason: "policy violation" })],
		});

		const error = expectFail(result);
		expect(error.code).toBe("blocked");
		expect(error.message).toContain("policy violation");
	});
});

describe("waterfall 扩展缝（tools/execute）", () => {
	it("中间件不调 next() 即短路，内置 execute 不被调用", async () => {
		const { ctx, registry } = makeHarness();
		const executeSpy = vi.fn(() => ({ value: "should-not-run" }));
		registry.register(stubTool({ name: "stub", execute: executeSpy }));

		ctx.on("tools/execute", (_payload, _next) => ({ ok: true, value: { shortCircuited: true } }));

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("stub", {}),
			context: toolContext(tempCwd()),
		});

		expect(expectOk<{ shortCircuited: boolean }>(result).shortCircuited).toBe(true);
		expect(executeSpy).not.toHaveBeenCalled();
	});
});

describe("read 工具", () => {
	it("按行窗口读取，truncated/totalLines 正确", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(createReadTool());

		const cwd = tempCwd();
		const file = join(cwd, "sample.txt");
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
		writeFileSync(file, lines.join("\n"), "utf8");

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("read", { path: "sample.txt", offset: 2, limit: 3 }),
			context: toolContext(cwd),
		});

		const value = expectOk<{
			content: string;
			startLine: number;
			endLine: number;
			totalLines: number;
			truncated: boolean;
		}>(result);
		expect(value.content).toBe("line 2\nline 3\nline 4");
		expect(value.totalLines).toBe(10);
		expect(value.truncated).toBe(true);
		expect(value.startLine).toBe(2);
	});

	it("文件不存在 -> execution_error 且消息可读", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(createReadTool());

		const cwd = tempCwd();
		const result = await executeTool({
			ctx,
			registry,
			call: callOf("read", { path: "nope.txt" }),
			context: toolContext(cwd),
		});

		const error = expectFail(result);
		expect(error.code).toBe("execution_error");
		expect(error.message).toContain("File not found");
	});
});

describe("write 工具", () => {
	it("新文件 created=true，重复写 created=false", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(createWriteTool());

		const cwd = tempCwd();
		const context = toolContext(cwd);

		const first = await executeTool({
			ctx,
			registry,
			call: callOf("write", { path: "out.txt", content: "hello" }),
			context,
		});
		const firstValue = expectOk<{ created: boolean; bytesWritten: number }>(first);
		expect(firstValue.created).toBe(true);
		expect(firstValue.bytesWritten).toBeGreaterThan(0);
		expect(existsSync(join(cwd, "out.txt"))).toBe(true);

		const second = await executeTool({
			ctx,
			registry,
			call: callOf("write", { path: "out.txt", content: "again" }),
			context,
		});
		expect(expectOk<{ created: boolean }>(second).created).toBe(false);
	});
});

describe("edit 工具", () => {
	it("唯一匹配 -> replacements=1 且内容被替换", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(createEditTool());

		const cwd = tempCwd();
		const file = join(cwd, "one.txt");
		writeFileSync(file, "AAA\nBBB\n", "utf8");

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("edit", { path: "one.txt", oldText: "BBB", newText: "CCC" }),
			context: toolContext(cwd),
		});

		expect(expectOk<{ replacements: number }>(result).replacements).toBe(1);
		expect(readFileSync(file, "utf8")).toBe("AAA\nCCC\n");
	});

	it("多处匹配且未给 replaceAll -> execution_error 且提到次数", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(createEditTool());

		const cwd = tempCwd();
		const file = join(cwd, "two.txt");
		writeFileSync(file, "X\nX\n", "utf8");

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("edit", { path: "two.txt", oldText: "X", newText: "Y" }),
			context: toolContext(cwd),
		});

		const error = expectFail(result);
		expect(error.code).toBe("execution_error");
		expect(error.message).toContain("2 times");
		// 拒绝执行，文件保持原样
		expect(readFileSync(file, "utf8")).toBe("X\nX\n");
	});

	it("replaceAll:true -> replacements=2", async () => {
		const { ctx, registry } = makeHarness();
		registry.register(createEditTool());

		const cwd = tempCwd();
		const file = join(cwd, "all.txt");
		writeFileSync(file, "X\nX\n", "utf8");

		const result = await executeTool({
			ctx,
			registry,
			call: callOf("edit", { path: "all.txt", oldText: "X", newText: "Y", replaceAll: true }),
			context: toolContext(cwd),
		});

		expect(expectOk<{ replacements: number }>(result).replacements).toBe(2);
		expect(readFileSync(file, "utf8")).toBe("Y\nY\n");
	});
});

describe("bash 工具（假 provider）", () => {
	it("结果符合声明 output", async () => {
		const { ctx, registry } = makeHarness();
		const shell = new FakeShellProvider();
		registry.register(createBashTool({ shell }));

		const cwd = tempCwd();
		const result = await executeTool({
			ctx,
			registry,
			call: callOf("bash", { command: "echo hi" }),
			context: toolContext(cwd),
		});

		const value = expectOk<{
			providerId: string;
			stdout: string;
			exitCode: number | null;
		}>(result);
		expect(value.providerId).toBe("pwsh");
		expect(value.stdout).toBe("hello\n");
		expect(value.exitCode).toBe(0);
		// provider 收到正确 cwd
		expect(shell.runs[0]?.cwd).toBe(cwd);
	});
});

describe("createDefaultToolset", () => {
	it("返回恰好 4 个，顺序为 read,bash,edit,write", () => {
		const shell = new FakeShellProvider();
		const tools = createDefaultToolset({ shell });
		expect(tools).toHaveLength(4);
		expect(tools.map((t) => t.metadata.name)).toEqual(["read", "bash", "edit", "write"]);
	});
});
