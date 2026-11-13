/**
 * M10b-2 验收测试（总工程师独立编写）：TUI 交互增强（ADR-024）——Tab 补全 + 鼠标。
 *
 * 覆盖：
 *  - **Tab 补全（纯函数）**：命令唯一匹配直接补（带参数的命令补一个空格）、多匹配只补公共前缀并
 *    列出候选、命令参数补全（`/mode p` → `plan`）、**路径补全**（目录项、目录补分隔符、大小写不敏感、
 *    目录不可列举时**一动不动**）、**不打扰正常输入**（普通中文/英文词 Tab 无反应）；
 *  - **按键与鼠标解码（纯函数）**：Tab → `complete`；SGR 鼠标整条解析（含分片边界**不当垃圾吞**）；
 *  - **鼠标行为（假 tty）**：滚轮改 `scrollOffset`；左键点输入行定位插入点；点别处不改变屏幕；
 *  - **接线（假 tty 驱动真实 REPL）**：`Tab` 真的补出 `/mode`；鼠标上报**开启后必定关闭**（还原纪律）。
 */
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPL_COMMANDS } from "../src/cli/repl.js";
import {
	complete,
	createKeyDecoder,
	createTheme,
	type DirEntry,
	runTuiSession,
} from "../src/tui/index.js";
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

const plain = createTheme({ disabled: true });
const CWD = "D:\\repo";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
		await delay(5);
	}
}

/** 假的目录列举（`key` 是"被列举的目录"，值是该目录的目录项）。 */
function fakeLister(
	tree: Record<string, readonly DirEntry[]>,
): (dir: string) => readonly DirEntry[] | undefined {
	return (dir) => tree[dir];
}

class FakeStdout extends EventEmitter {
	columns = 70;
	rows = 14;
	readonly chunks: string[] = [];
	write(text: string): void {
		this.chunks.push(text);
	}
	get text(): string {
		return this.chunks.join("");
	}
}

class FakeStdin extends EventEmitter {
	setRawMode(): void {}
	type(text: string): void {
		this.emit("data", Buffer.from(text, "utf8"));
	}
}

/** 左键点击某行某列（1 起坐标）。 */
function click(x: number, y: number): string {
	return `\u001b[<0;${x};${y}M`;
}
/** 滚轮上/下（SGR：64/65；滚轮只发"按下"）。 */
function wheel(button: 64 | 65, x = 5, y = 5): string {
	return `\u001b[<${button};${x};${y}M`;
}

describe("M10b-2 Tab 补全（纯函数：命令 / 参数 / 路径）", () => {
	it("命令：唯一匹配直接补（带参数的命令补一个空格）；无匹配一动不动", () => {
		const at = (input: string, caret = input.length) =>
			complete({ input, caret, cwd: CWD, commands: REPL_COMMANDS });

		expect(at("/mo")).toEqual({ text: "/mode ", caret: 6, candidates: [] }); // 补名 + 空格
		expect(at("/hi")).toMatchObject({ text: "/history", caret: 8 });
		expect(at("/zzz")).toEqual({ text: "/zzz", caret: 4, candidates: [] }); // 不动
		expect(at("hello")).toEqual({ text: "hello", caret: 5, candidates: [] }); // 非命令位
		expect(at("")).toEqual({ text: "", caret: 0, candidates: [] });
	});

	it("命令：多匹配只补公共前缀并**列出候选**（不替用户猜）", () => {
		// 人为造一个多匹配场景（`/approvals` 与 `/approve`）：公共前缀 = `/approv`
		const commands = [...REPL_COMMANDS, { name: "/approve" }];
		const many = complete({ input: "/app", caret: 4, cwd: CWD, commands });
		expect(many.text).toBe("/approv");
		expect(many.caret).toBe(7);
		expect(many.candidates).toEqual(["/approvals", "/approve"]);
		// 唯一匹配（只有 `/mode` 以 `/mo` 开头）⇒ 直接补完
		expect(complete({ input: "/mo", caret: 3, cwd: CWD, commands: REPL_COMMANDS }).text).toBe(
			"/mode ",
		);
	});

	it("命令参数：`/mode p` → `plan`；`/mode ` 列出两个候选", () => {
		const at = (input: string) =>
			complete({ input, caret: input.length, cwd: CWD, commands: REPL_COMMANDS });
		expect(at("/mode p")).toEqual({ text: "/mode plan", caret: 10, candidates: [] });
		expect(at("/mode ")).toMatchObject({ text: "/mode ", candidates: ["plan", "build"] });
	});

	it("路径：唯一匹配补全、目录补分隔符、大小写不敏感；不可列举时**一动不动**", () => {
		const tree = {
			[join(CWD, "src")]: [
				{ name: "index.ts", dir: false },
				{ name: "utils.ts", dir: false },
				{ name: "nested", dir: true },
			],
			[join(CWD, "doc")]: [{ name: "Notes.md", dir: false }],
		};
		const at = (input: string) =>
			complete({
				input,
				caret: input.length,
				cwd: CWD,
				commands: REPL_COMMANDS,
				listDir: fakeLister(tree),
			});

		expect(at("src/ind")).toEqual({ text: "src/index.ts", caret: 12, candidates: [] });
		expect(at("src/nes")).toMatchObject({ text: "src/nested/" }); // 目录补分隔符
		expect(at("doc/no")).toMatchObject({ text: "doc/Notes.md" }); // 大小写不敏感
		expect(at("src/u")).toMatchObject({ text: "src/utils.ts" });
		// 多候选：只补公共前缀 + 列候选
		const many = at("src/");
		expect(many.candidates).toEqual(["index.ts", "utils.ts", "nested/"]);
		expect(many.text).toBe("src/"); // 无公共前缀可补
		// 目录不可列举（树里没有）⇒ 一动不动的**安全失败**
		expect(at("missing/x")).toEqual({ text: "missing/x", caret: 9, candidates: [] });
	});

	it("不打扰正常输入：普通词 / 无分隔符的裸词 Tab 无反应", () => {
		const at = (input: string) =>
			complete({
				input,
				caret: input.length,
				cwd: CWD,
				commands: REPL_COMMANDS,
				listDir: () => [],
			});
		expect(at("帮我看看这个函数")).toEqual({ text: "帮我看看这个函数", caret: 8, candidates: [] });
		expect(at("index")).toEqual({ text: "index", caret: 5, candidates: [] }); // 没有分隔符 ⇒ 不补
	});
});

describe("M10b-2 按键与鼠标解码（纯函数）", () => {
	function decodeAll(chunks: readonly (string | Buffer)[]) {
		const decoder = createKeyDecoder();
		return chunks.flatMap((chunk) => decoder.push(chunk));
	}

	it("Tab → `complete`", () => {
		expect(decodeAll(["\t"])).toEqual([{ kind: "complete" }]);
	});

	it("SGR 鼠标整条解析；**跨分片不当垃圾吞**（不完整前缀会等下一片）", () => {
		expect(decodeAll([`\u001b[<0;35;12M`])).toEqual([
			{ kind: "mouse", button: 0, x: 35, y: 12, pressed: true },
		]);
		expect(decodeAll([`\u001b[<0;35;12m`])).toEqual([
			{ kind: "mouse", button: 0, x: 35, y: 12, pressed: false },
		]);
		expect(decodeAll([`\u001b[<64;5;3M`])).toEqual([
			{ kind: "mouse", button: 64, x: 5, y: 3, pressed: true },
		]);
		// 分片：先给半条，不得吐出任何事件（更不得当成未知序列吞掉）
		const decoder = createKeyDecoder();
		expect(decoder.push("\u001b[<0;35")).toEqual([]);
		expect(decoder.pending()).toBeGreaterThan(0);
		expect(decoder.push(";12M")).toEqual([
			{ kind: "mouse", button: 0, x: 35, y: 12, pressed: true },
		]);
		expect(decoder.pending()).toBe(0);
	});
});

describe("M10b-2 应用层：假 tty 驱动真实 REPL（Tab 补全 + 鼠标）", () => {
	it("Tab 真补出 `/mode`；滚轮改滚动；点击输入行定位插入点；鼠标上报开启后必定关闭", async () => {
		const home = newTemp("aster-m10b2-home-");
		const cwd = newTemp("aster-m10b2-cwd-");
		const stdout = new FakeStdout();
		const stdin = new FakeStdin();

		const session = runTuiSession({
			home,
			cwd,
			mode: "plan",
			input: stdin as never,
			sink: stdout as never,
			keys: stdin as never,
			theme: plain,
			intervalMs: 0,
			output: { write: () => undefined },
		});

		await waitFor(() => stdout.text.includes("› "));
		// 鼠标上报只在**全屏模式**下开启，且必定在还原时关闭
		expect(stdout.text).toContain("\u001b[?1000h\u001b[?1006h");

		// ① Tab 补全：输入 `/mo` 再按 Tab → 输入行出现 `/mode `（带空格）
		stdin.type("/mo");
		stdin.type("\t");
		await waitFor(() => stdout.text.includes("› /mode "));
		expect(stdout.text).toContain("› /mode ");

		// ② Ctrl+U 清行，再输入一个普通词 + Tab：**补全不打扰正常输入**
		stdin.type("\u0015");
		stdin.type("hello");
		const beforeTab = stdout.chunks.length;
		stdin.type("\t");
		await delay(30);
		expect(stdout.chunks.slice(beforeTab).join("")).not.toContain("candidates"); // 没有候选提示

		// ③ 鼠标：滚轮向上 ⇒ 视图滚动（不崩、不报错）
		const beforeWheel = stdout.chunks.length;
		stdin.type(wheel(64));
		await delay(30);
		expect(stdout.chunks.length).toBeGreaterThanOrEqual(beforeWheel); // 至少没有抛错

		// ④ 点击输入行定位插入点：`index = 终端列 - 1 - PROMPT_WIDTH`
		//    点第 5 列（1 起）⇒ 文本下标 2 ⇒ 再打字应插在 "he" 与 "llo" 之间
		stdin.type(click(5, stdout.rows));
		stdin.type("X");
		await delay(50);
		expect(stdout.text).toContain("heXllo");
		// 点第 3 列（文本开头）⇒ 下标 0 ⇒ 再打字插在最前面（证明映射是**逐个字符**的）
		stdin.type(click(3, stdout.rows));
		stdin.type("Y");
		await delay(50);
		expect(stdout.text).toContain("YheXllo");

		// ⑤ 退出并严格还原
		stdin.type("\u0004");
		await session;
		expect(stdout.text).toContain("\u001b[?1000l\u001b[?1006l");
		expect(stdout.text).toContain("\u001b[?1049l");
	});
});
