/**
 * M14 验收测试（总工程师独立编写）：**记忆交换格式**（ADR-030，兑现主张 4 的**记忆侧**）。
 *
 * 覆盖：
 *  - **canonical 往返语义无损**：含 bitemporal（`validAt` / `invalidAt` 的 **null 与缺席是两种事实**）
 *    与 `provenance` 的记忆集导出为 `chenxi-memory-exchange` 文档再解析，**逐字段深等**；
 *  - **版本门禁是真实分支**：更高版本必拒、更早版本（v0，无迁移路径）必拒、错 format / 坏 JSON / 坏记录必拒；
 *  - **解析即规范化**：未知键（如外部塞进来的 `metadata.user`）**被剥掉**——这是 ADR-010「写入时剥离身份键」
 *    的可测形态（不让外部私货渗进下游）；
 *  - **严格的解析 vs 宽容的装载**：文档里有坏记录 ⇒ 整份文档快速失败；记忆层返回坏记录 ⇒ **丢弃**
 *    （与注入缝"形状不符按无记忆处理"同一纪律），导出永远产出**合法**文档；
 *  - **读侧只有导出、没有写入**：`readMemoryLayerForExport` 走 `getSessionMemories`（不是按 query 检索），
 *    适配器报错**如实抛出**（导出是显式动作，不像注入那样 fail-open）；
 *  - **CLI 接线**：`parseArgs` 的取值域检查 + `--import-memory`（校验 / 规范化重写、**不写记忆层**）
 *    + `--export-memory` **真进程**桥接夹具记忆服务器（导出文档的记录、作用域与 bitemporal 字段都断言）。
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryAdapter, MemoryRecord, MemoryScope } from "@chenxi/schema";
import {
	EXCHANGE_FORMAT_VERSION,
	MEMORY_EXCHANGE_FORMAT,
	MEMORY_EXCHANGE_FORMAT_VERSION,
	SESSION_FORMAT_VERSION,
} from "@chenxi/schema";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { runMemoryPortableCommand } from "../src/cli/memory-portable.js";
import {
	buildMemoryExchangeDocument,
	createMcpMemoryAdapter,
	MemoryExchangeFormatError,
	normalizeMemoryExchangeDocument,
	parseMemoryExchangeDocument,
	parseMemoryExchangeJson,
	readMemoryLayerForExport,
	selectExportableRecords,
} from "../src/memory/index.js";
import { createSessionStore } from "../src/persist/index.js";
import { CHENXI_PRODUCER } from "../src/portable/index.js";
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

const FIXTURE_SERVER = fileURLToPath(
	new URL("./helpers/memory-fixture-server.mjs", import.meta.url),
);

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";

const SCOPE: MemoryScope = { user: "u1", agent: "chenxi", session: "s1" };

/** 一个"什么都有"的记忆集：相似度 / 系统时间 / bitemporal（含显式 null）/ 溯源。 */
const RICH_RECORDS: readonly MemoryRecord[] = [
	{
		id: "m1",
		content: "用户偏好：编辑用 vim",
		score: 0.91,
		createdAt: T0,
		validAt: T0,
		invalidAt: null,
		provenance: { promptId: "p1", promptVersion: "v1", promptHash: "sha256-x" },
	},
	{ id: "m2", content: "旧事实：默认分支是 master", createdAt: T1, validAt: T1, invalidAt: T1 },
];

describe("M14 canonical 记忆交换文档：往返语义无损（ADR-030）", () => {
	it("导出 -> 序列化 -> 解析：记录逐字段深等，作用域三键与产出方照旧", () => {
		const document = buildMemoryExchangeDocument({
			scope: SCOPE,
			records: RICH_RECORDS,
			producer: CHENXI_PRODUCER,
		});
		expect(document.format).toBe(MEMORY_EXCHANGE_FORMAT);
		expect(document.formatVersion).toBe(MEMORY_EXCHANGE_FORMAT_VERSION);

		// 走一遍真实序列化（JSON -> 文本 -> 解析），确保不是"内存里自说自话"
		const parsed = parseMemoryExchangeJson(`${JSON.stringify(document, null, 2)}\n`);
		expect(parsed.records).toEqual(RICH_RECORDS);
		expect(parsed.scope).toEqual(SCOPE);
		expect(parsed.producer).toEqual(CHENXI_PRODUCER);
		expect(parsed.formatVersion).toBe(MEMORY_EXCHANGE_FORMAT_VERSION);

		// 显式 null 保留、缺席键不补（absense 与 null 是两种事实，不能被折叠）
		expect(parsed.records[0]?.invalidAt).toBeNull();
		expect(Object.hasOwn(parsed.records[1] ?? {}, "invalidAt")).toBe(true);
		expect(Object.hasOwn(parsed.records[0] ?? {}, "metadata")).toBe(false);
	});

	it("规范化重写：换产出方、锚当前版本，且文档仍是合法 canonical 文档", () => {
		const foreign = {
			format: MEMORY_EXCHANGE_FORMAT,
			formatVersion: MEMORY_EXCHANGE_FORMAT_VERSION,
			producer: { name: "someone-else", version: "9.9.9" },
			scope: SCOPE,
			records: [{ id: "m1", content: "hi", metadata: { user: "attacker" }, extra: 1 }],
		};
		const parsed = parseMemoryExchangeDocument(foreign);
		const normalized = normalizeMemoryExchangeDocument(parsed, CHENXI_PRODUCER);
		expect(normalized.producer).toEqual(CHENXI_PRODUCER);
		expect(normalized.records).toEqual([{ id: "m1", content: "hi" }]); // 未知键被剥掉
		expect(parseMemoryExchangeJson(JSON.stringify(normalized)).records).toEqual([
			{ id: "m1", content: "hi" },
		]);
	});
});

describe("M14 版本门禁与记录校验（ADR-030）", () => {
	function baseDocument(): Record<string, unknown> {
		return {
			format: MEMORY_EXCHANGE_FORMAT,
			formatVersion: MEMORY_EXCHANGE_FORMAT_VERSION,
			producer: { name: "chenxi", version: "1.0.0" },
			scope: SCOPE,
			records: [{ id: "m1", content: "hi" }],
		};
	}

	it("更高版本必拒（绝不静默降级去读一个看不懂的格式）", () => {
		const doc = { ...baseDocument(), formatVersion: MEMORY_EXCHANGE_FORMAT_VERSION + 1 };
		expect(() => parseMemoryExchangeDocument(doc)).toThrowError(/newer than this client supports/);
		try {
			parseMemoryExchangeDocument(doc);
		} catch (error) {
			expect(error).toBeInstanceOf(MemoryExchangeFormatError);
			expect((error as MemoryExchangeFormatError).code).toBe("version_unsupported");
		}
	});

	it("更早版本必拒（v1 是首版，没有可用的迁移路径）", () => {
		try {
			parseMemoryExchangeDocument({ ...baseDocument(), formatVersion: 0 });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as MemoryExchangeFormatError).code).toBe("version_unmigratable");
		}
	});

	it("非法文档（错 format / 缺 records / 坏 JSON）一律快速失败且原因可读", () => {
		expect(() =>
			parseMemoryExchangeDocument({ ...baseDocument(), format: "mem0-dump" }),
		).toThrowError(/not a valid chenxi-memory-exchange document/);
		const missing = baseDocument();
		missing.formatVersion = undefined;
		expect(() => parseMemoryExchangeDocument(missing)).toThrowError(/formatVersion/);
		missing.formatVersion = MEMORY_EXCHANGE_FORMAT_VERSION;
		missing.records = undefined;
		expect(() => parseMemoryExchangeDocument(missing)).toThrowError(/records/);
		expect(() => parseMemoryExchangeJson("{ not json")).toThrowError(/not valid JSON/);
	});

	it("坏记录必拒且指出**具体哪一条**（内容非字符串 / 空 / 缺 id / 溯源缺键 / 相似度非数）", () => {
		const cases: readonly [Record<string, unknown>, RegExp][] = [
			[{ id: "m", content: 42 }, /records\.0\.content/],
			[{ id: "m", content: "" }, /records\.0\.content/],
			[{ content: "x" }, /records\.0\.id/],
			[{ id: "m", content: "x", score: "0.9" }, /records\.0\.score/],
			[
				{ id: "m", content: "x", provenance: { promptId: "p", promptVersion: "v" } },
				/records\.0\.provenance\.promptHash/,
			],
		];
		for (const [record, pattern] of cases) {
			expect(() =>
				parseMemoryExchangeDocument({ ...baseDocument(), records: [record] }),
			).toThrowError(pattern);
		}
	});

	it("作用域三键必填（缺一个就无从重建隔离，ADR-010）", () => {
		expect(() =>
			parseMemoryExchangeDocument({
				...baseDocument(),
				scope: { user: "u1", agent: "chenxi" },
			}),
		).toThrowError(/scope\.session/);
	});

	it("取值域与仓内其它事实源对齐（三个版本锚点各自独立演进）", () => {
		expect(typeof MEMORY_EXCHANGE_FORMAT_VERSION).toBe("number");
		expect(typeof EXCHANGE_FORMAT_VERSION).toBe("number");
		expect(typeof SESSION_FORMAT_VERSION).toBe("number");
		// 记忆侧与**会话侧**的 format 标识必须能一眼区分（否则门禁会放行"串味"的文档）
		expect(MEMORY_EXCHANGE_FORMAT).not.toBe("chenxi-session-exchange");
	});
});

describe("M14 宽容的装载器 vs 严格的文档解析", () => {
	it("外部垃圾被丢弃（导出永远产出合法文档），未声明键被剥掉", () => {
		const selected = selectExportableRecords([
			{ id: "m1", content: "ok", metadata: { user: "attacker" } },
			{ id: "bad", score: "not-a-number" }, // 缺 content
			"not-an-object",
			null,
		]);
		// 未声明键（`metadata`）**不**出现在结果里 —— ADR-010 的越权写防线在格式层的可测形态
		expect(selected).toEqual([{ id: "m1", content: "ok" }]);
	});
});

describe("M14 读侧（导出）：只读、如实报错、绝不写（ADR-016/030）", () => {
	/** 桩记忆层：照 `createMcpMemoryAdapter` 对外提出的契约返回 `CallToolResult` 信封。 */
	function stubAdapter(payload: unknown): {
		adapter: MemoryAdapter;
		calls: { name: string; args: unknown }[];
	} {
		const calls: { name: string; args: unknown }[] = [];
		return {
			calls,
			adapter: {
				add: () => Promise.reject(new Error("memory write is deferred by design (ADR-016)")),
				search: () => Promise.reject(new Error("unused in this test")),
				getSessionMemories: (scope) => {
					calls.push({ name: "get", args: scope });
					return Promise.resolve(payload as never);
				},
			},
		};
	}

	it("按作用域读（不是按 query 检索），返回合法记录（垃圾被丢掉、未声明键被剥掉）", async () => {
		const { adapter, calls } = stubAdapter({
			records: [
				{ id: "m1", content: "a", metadata: { user: "attacker" } },
				{ id: "m2", content: "b" },
				{ junk: true },
			],
		});
		const exported = await readMemoryLayerForExport({
			adapter,
			scope: SCOPE,
			producer: CHENXI_PRODUCER,
		});
		expect(exported.records).toEqual([
			{ id: "m1", content: "a" },
			{ id: "m2", content: "b" },
		]);
		expect(calls).toEqual([{ name: "get", args: SCOPE }]); // 作用域原样透传
	});

	it("适配器报错**如实抛出**（导出是显式动作，不像注入那样 fail-open）", async () => {
		const adapter: MemoryAdapter = {
			add: () => Promise.reject(new Error("deferred")),
			search: () => Promise.reject(new Error("unused")),
			getSessionMemories: () => Promise.reject(new Error("memory server is unreachable")),
		};
		await expect(
			readMemoryLayerForExport({ adapter, scope: SCOPE, producer: CHENXI_PRODUCER }),
		).rejects.toThrowError(/unreachable/);
	});

	it("形状不符（非数组 / 无 records）按空处理，不崩", async () => {
		for (const payload of [undefined, {}, { records: "nope" }]) {
			const { adapter } = stubAdapter(payload);
			const exported = await readMemoryLayerForExport({
				adapter,
				scope: SCOPE,
				producer: CHENXI_PRODUCER,
			});
			expect(exported.records).toEqual([]);
		}
	});

	it("MCP 外挂读取**原样携带**可选字段（bitemporal / 溯源），形状不符的字段只丢自己", async () => {
		const adapter = createMcpMemoryAdapter({
			searchTool: "search_memory",
			callTool: () =>
				Promise.resolve({
					content: [
						{
							type: "text",
							text: JSON.stringify({
								records: [
									{
										id: "m1",
										content: "keep",
										createdAt: T0,
										validAt: T0,
										invalidAt: null,
										provenance: { promptId: "p1", promptVersion: "v1", promptHash: "h1" },
									},
									// 形状不符的字段只丢自己：时间戳是数字（丢掉），内容照旧保留
									{
										id: "m2",
										content: "keep2",
										createdAt: 1234567890,
										provenance: { promptId: "p" },
									},
								],
							}),
						},
					],
				}),
		});
		const exported = await readMemoryLayerForExport({
			adapter,
			scope: SCOPE,
			producer: CHENXI_PRODUCER,
		});
		expect(exported.records).toEqual([
			{
				id: "m1",
				content: "keep",
				createdAt: T0,
				validAt: T0,
				invalidAt: null,
				provenance: { promptId: "p1", promptVersion: "v1", promptHash: "h1" },
			},
			{ id: "m2", content: "keep2" }, // 数字时间戳与半截 provenance 都不采纳（绝不臆造）
		]);
	});
});

describe("M14 CLI 接线：--export-memory / --import-memory（ADR-030）", () => {
	function collectingOutput(): { lines: string[]; output: { write: (text: string) => void } } {
		const lines: string[] = [];
		return { lines, output: { write: (text: string) => lines.push(text) } };
	}

	it("parseArgs 的取值域检查（缺值快速失败，不出半截状态）", () => {
		expect(parseArgs(["--export-memory", "--out", "m.json"])).toMatchObject({
			exportMemory: true,
			out: "m.json",
		});
		expect(parseArgs(["--import-memory", "m.json", "--memory-session", "s9"]).memorySession).toBe(
			"s9",
		);
		expect(() => parseArgs(["--import-memory"])).toThrowError(/--import-memory requires/);
		expect(() => parseArgs(["--memory-session"])).toThrowError(/--memory-session requires/);
	});

	it("--import-memory：校验 + 规范化重写，且**明说不写记忆层**（ADR-016）", async () => {
		const dir = newTemp("chenxi-m14-imp-");
		const source = join(dir, "in.json");
		const out = join(dir, "normalized.json");
		writeFileSync(
			source,
			JSON.stringify({
				format: MEMORY_EXCHANGE_FORMAT,
				formatVersion: MEMORY_EXCHANGE_FORMAT_VERSION,
				producer: { name: "someone-else", version: "9.9.9" },
				scope: SCOPE,
				records: [{ id: "m1", content: "hi", metadata: { user: "attacker" } }],
			}),
		);

		const { lines, output } = collectingOutput();
		await runMemoryPortableCommand({ importMemoryPath: source, out, output });
		const printed = lines.join("");
		expect(printed).toContain("1 record(s)");
		expect(printed).toContain("scope: user=u1 agent=chenxi session=s1");
		expect(printed).toContain("normalized (canonical form, unknown keys stripped)");
		expect(printed).toContain("deferred by design (ADR-016)"); // **绝不让用户以为"导进去了"**

		const written = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
		expect(written.producer).toEqual(CHENXI_PRODUCER);
		expect(written.records).toEqual([{ id: "m1", content: "hi" }]);
	});

	it("--import-memory：坏文档快速失败（不产出半截文件）", async () => {
		const dir = newTemp("chenxi-m14-bad-");
		const source = join(dir, "bad.json");
		const out = join(dir, "should-not-exist.json");
		writeFileSync(source, "{ not json");
		await expect(
			runMemoryPortableCommand({
				importMemoryPath: source,
				out,
				output: { write: () => undefined },
			}),
		).rejects.toThrowError(/not valid JSON/);
		writeFileSync(source, JSON.stringify({ format: "mem0-dump" }));
		await expect(
			runMemoryPortableCommand({
				importMemoryPath: source,
				output: { write: () => undefined },
			}),
		).rejects.toThrowError(/chenxi-memory-exchange/);
	});

	it("--export-memory：**真进程**桥接夹具记忆层，导出文档含记录与丢弃计数", async () => {
		const home = newTemp("chenxi-m14-exp-");
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				mcp: {
					servers: [{ name: "mem", command: process.execPath, args: [FIXTURE_SERVER] }],
				},
				memory: { server: "mem", searchTool: "search_memory" },
			}),
		);
		const store = createSessionStore({ home });
		const handle = await store.create({ cwd: home, mode: "plan", at: T0 });
		const sessionId = handle.sessionId;
		await handle.append({ type: "user/message", payload: { content: "hi" }, at: T1 });
		await handle.append({ type: "session/end", payload: { reason: "exit" }, at: T1 });
		await handle.close();
		await store.dispose();

		const out = join(home, "memory.chenxi.json");
		const { lines, output } = collectingOutput();
		await runMemoryPortableCommand({ home, exportMemory: true, out, output });
		const printed = lines.join("");
		expect(printed).toContain("exported 2 memory record(s)");
		expect(printed).toContain("lossless for Chenxi");
		expect(printed).toContain(`session=${sessionId}`); // 缺省作用域 = 最近更新的已记录会话

		const document = parseMemoryExchangeJson(readFileSync(out, "utf8"));
		expect(document.formatVersion).toBe(MEMORY_EXCHANGE_FORMAT_VERSION);
		expect(document.producer).toEqual(CHENXI_PRODUCER);
		expect(document.scope.session).toBe(sessionId);
		expect(document.scope.user).not.toBe("");
		expect(document.records.map((record) => record.id)).toEqual(["m1", "m2"]);
		// bitemporal 与溯源**原样搬运**（不是最小形状）
		expect(document.records[0]?.invalidAt).toBeNull();
		expect(document.records[0]?.provenance).toEqual({
			promptId: "p1",
			promptVersion: "v1",
			promptHash: "sha256-fixture",
		});
		expect(document.records[1]?.invalidAt).toBe("2026-01-02T00:00:00.000Z");
	});

	it("--export-memory：未配置记忆层 / 缺 --out 都快速失败且原因可读", async () => {
		const home = newTemp("chenxi-m14-none-");
		await expect(
			runMemoryPortableCommand({
				home,
				exportMemory: true,
				out: join(home, "m.json"),
				output: { write: () => undefined },
			}),
		).rejects.toThrowError(/no memory layer is configured/);
		await expect(
			runMemoryPortableCommand({ home, exportMemory: true, output: { write: () => undefined } }),
		).rejects.toThrowError(/--export-memory requires --out/);
	});
});
