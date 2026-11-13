/**
 * M2 验收测试（总工程师独立编写）：核验「纯流式对话」闭环。
 *
 * 覆盖：
 *  - keyless 桩 provider 驱动的流式打印（不访问网络、不需密钥）
 *  - 事件序列正确：user/message -> turn/start -> assistant/message -> turn/end
 *  - 「模型可见 <=> 已记录」：投影历史含 assistant 且与落盘内容一致
 *  - 未配置端点时退化为「仅记录」模式（**不伪造** assistant 内容）
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { SessionEvent, SessionId } from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionRepl } from "../src/cli/repl.js";
import { createStubProvider } from "../src/llm/index.js";
import { deriveMessages } from "../src/session/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const homes: string[] = [];

function newHome(): string {
	const home = makeTempDir("chenxi-m2-");
	homes.push(home);
	return home;
}

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function collector() {
	const chunks: string[] = [];
	return {
		output: { write: (text: string) => void chunks.push(text) },
		text: () => chunks.join(""),
	};
}

function readEvents(home: string, sessionId: SessionId): SessionEvent[] {
	return readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

describe("M2 裁决：流式对话闭环（keyless 桩 provider）", () => {
	it("流式打印 + 事件落盘 + 投影一致", async () => {
		const home = newHome();
		const collected = collector();
		const provider = createStubProvider({
			content: "hello from stub",
			chunks: ["hello ", "from ", "stub"],
		});

		const result = await runSessionRepl({
			home,
			provider,
			model: "stub-model",
			input: Readable.from(["say hi\n", "/exit\n"]),
			output: collected.output,
		});

		// 流式增量被逐段打印
		expect(collected.text()).toContain("hello ");
		expect(collected.text()).toContain("hello from stub");
		expect(collected.text()).toContain("llm provider: stub");

		const events = readEvents(home, result.sessionId);
		const types = events.map((e) => e.type);
		expect(types).toEqual([
			"session/start",
			"user/message",
			"turn/start",
			"assistant/message",
			"turn/end",
			"session/end",
		]);

		const assistant = events.find((e) => e.type === "assistant/message");
		expect(assistant?.type === "assistant/message" && assistant.payload.content).toBe(
			"hello from stub",
		);

		// 不变量 1：投影历史 == 落盘事实
		const messages = deriveMessages(events);
		expect(messages).toEqual([
			{ role: "user", content: "say hi" },
			{ role: "assistant", content: "hello from stub" },
		]);
	});

	it("未配置端点 -> 仅记录模式，不伪造 assistant 内容", async () => {
		const home = newHome();
		const collected = collector();
		const result = await runSessionRepl({
			home,
			input: Readable.from(["only a note\n", "/exit\n"]),
			output: collected.output,
		});

		expect(collected.text()).toContain("no model endpoint configured");
		const events = readEvents(home, result.sessionId);
		expect(events.some((e) => e.type === "assistant/message")).toBe(false);
		expect(events.some((e) => e.type === "turn/start")).toBe(false);
		expect(deriveMessages(events)).toEqual([{ role: "user", content: "only a note" }]);
	});

	it("多轮：turnIndex 递增且每轮都有 assistant/message", async () => {
		const home = newHome();
		const provider = createStubProvider([{ content: "first" }, { content: "second" }]);
		const result = await runSessionRepl({
			home,
			provider,
			model: "stub-model",
			input: Readable.from(["a\n", "b\n", "/exit\n"]),
			output: collector().output,
		});

		const events = readEvents(home, result.sessionId);
		const turns = events.filter((e) => e.type === "turn/start");
		expect(turns).toHaveLength(2);
		expect(turns.map((t) => (t.type === "turn/start" ? t.payload.index : -1))).toEqual([0, 1]);
		expect(events.filter((e) => e.type === "assistant/message")).toHaveLength(2);
	});
});
