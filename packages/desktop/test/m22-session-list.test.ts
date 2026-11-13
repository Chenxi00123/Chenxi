/**
 * M22（ADR-040）桌面日用三件里的两件半：**会话标题**与**列表预览**。
 *
 * 钉住的纪律：
 *  - 标题落在 `<home>\desktop\session-titles.json`，**绝不写 JSONL**（会话文件逐字节不变）；
 *  - 坏文件 / 版本不认一律退化为"没有标题"，**不拖垮启动**；
 *  - 预览只读 JSONL 头部、只取第一条 `user/message`，**不产生任何写入**。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { cli, createStubProvider } from "@chenxi/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopHost } from "../src/host.js";
import { loadTitles, normalizeTitle, saveTitle, titlesPath } from "../src/session-titles.js";
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

/** 跑一条真实会话（stub provider）：给"预览 / 列表"造已记录的事实。 */
async function runRecordedSession(home: string, prompt: string): Promise<string> {
	const result = await cli.runSessionRepl({
		home,
		provider: createStubProvider([{ content: "ok", stopReason: "end_turn" }]),
		model: "stub-model",
		mode: "plan",
		input: Readable.from([`${prompt}\n`, "/exit\n"]),
		output: { write: () => undefined },
	} as Parameters<typeof cli.runSessionRepl>[0]);
	return result.sessionId;
}

function onlySessionFile(home: string): string {
	const dir = join(home, "sessions");
	const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
	if (file === undefined) throw new Error("no session file");
	return join(dir, file);
}

describe("会话标题：规范化", () => {
	it("去首尾空白、压掉换行、限长 60", () => {
		expect(normalizeTitle("  排查 MCP 超时  ")).toBe("排查 MCP 超时");
		expect(normalizeTitle("a\nb\tc")).toBe("a b c");
		expect(normalizeTitle("x".repeat(200))).toHaveLength(60);
		expect(normalizeTitle("   ")).toBe("");
	});
});

describe("会话标题：读写与坏文件", () => {
	it("保存 / 覆盖 / 清空（空标题 = 恢复 id）", () => {
		const home = newTemp("chenxi-m22-titles-");
		expect(loadTitles(home)).toEqual({});

		saveTitle(home, "ses_a", "第一个标题");
		expect(loadTitles(home)).toEqual({ ses_a: "第一个标题" });

		saveTitle(home, "ses_b", "另一个");
		saveTitle(home, "ses_a", "改过的");
		expect(loadTitles(home)).toEqual({ ses_a: "改过的", ses_b: "另一个" });

		saveTitle(home, "ses_a", "   ");
		expect(loadTitles(home)).toEqual({ ses_b: "另一个" });
	});

	it("坏 JSON / 不是我们的格式 / 版本不认 ⇒ 空表且不抛", () => {
		const home = newTemp("chenxi-m22-bad-");
		const file = titlesPath(home);
		mkdirSync(join(home, "desktop"), { recursive: true });

		writeFileSync(file, "{oops", "utf8");
		expect(loadTitles(home)).toEqual({});

		writeFileSync(file, JSON.stringify({ format: "other" }), "utf8");
		expect(loadTitles(home)).toEqual({});

		writeFileSync(
			file,
			JSON.stringify({
				format: "chenxi-desktop-session-titles",
				formatVersion: 99,
				titles: { a: "x" },
			}),
			"utf8",
		);
		expect(loadTitles(home)).toEqual({});
	});
});

describe("列表预览 + 标题：只读 JSONL，不写事实", () => {
	it("列表带 preview（第一条用户消息）与 title，且会话文件逐字节不变", async () => {
		const home = newTemp("chenxi-m22-list-");
		const sessionId = await runRecordedSession(home, "帮我看一下 packages/runtime 的入口");
		const file = onlySessionFile(home);
		const before = readFileSync(file);

		saveTitle(home, sessionId, "入口排查");

		const host = createDesktopHost({ home });
		try {
			const list = await host.list();
			const item = list.find((entry) => entry.sessionId === sessionId);
			expect(item).toBeDefined();
			expect(item?.title).toBe("入口排查");
			expect(item?.preview).toBe("帮我看一下 packages/runtime 的入口");
		} finally {
			await host.dispose();
		}

		// 「标题不是会话事实」：JSONL 一个字节都没变，也不该出现标题字符串
		expect(readFileSync(file).equals(before)).toBe(true);
		expect(readFileSync(file, "utf8")).not.toContain("入口排查");
	});

	it("没有标题时 title 字段缺席（不塞空串，界面据此回退显示 sessionId）", async () => {
		const home = newTemp("chenxi-m22-nolabel-");
		const sessionId = await runRecordedSession(home, "hello");
		const host = createDesktopHost({ home });
		try {
			const item = (await host.list()).find((entry) => entry.sessionId === sessionId);
			expect(item).toBeDefined();
			expect("title" in (item ?? {})).toBe(false);
		} finally {
			await host.dispose();
		}
	});
});
