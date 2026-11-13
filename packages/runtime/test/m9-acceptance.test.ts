/**
 * M9 验收测试（总工程师独立编写）：会话可移植（ADR-019，兑现主张 4）的**跨模块契约**。
 *
 * 覆盖：
 *  - **canonical 往返语义无损**：真实会话（含工具轨迹 / 审批 / 模式切换 / 记忆注入）导出为
 *    `aster-session-exchange` v1 文档再导入，**除 `sessionId` 外的事件序列逐字段深等**，
 *    且 `deriveMessages` 投影逐条深等；索引的 `created_at` 也保留（否则会出现 created_at > updated_at）；
 *  - **版本门禁是真实分支**：更高版本必拒、更早版本（v0，无迁移路径）必拒、缺字段/非法 JSON 必拒；
 *  - **载荷校验**：篡改会进模型历史的载荷（如 `user/message.content`）必拒且原因可读；
 *  - **厂商适配器（best-effort）**：Claude Code 原生 JSONL 的导入按已观察形状清洗（丢 tool_result /
 *    IDE 噪音 / synthetic 占位 / sidechain / isMeta），连续 assistant 记录聚合成一轮；导出→再导入
 *    轮次逐条深等；ZCode 会话文件的 mode 只在 `plan`/`build` 时采纳；
 *  - **有损是显式的**：工具轨迹在厂商往返里**必然丢失**，且 CLI 会把有损清单打印出来；
 *  - **CLI 接线**：`parseArgs` 的取值域校验 + `--export/--import` 端到端（不进 REPL）。
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent, SessionId, ToolCallId } from "@aster/schema";
import {
	AGENT_MODES,
	EXCHANGE_FORMAT,
	EXCHANGE_FORMAT_VERSION,
	PORTABLE_FORMATS,
	SESSION_FORMAT_VERSION,
} from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { runPortableCommand } from "../src/cli/portable.js";
import { createSessionStore } from "../src/persist/index.js";
import {
	ASTER_PRODUCER,
	buildExchangeDocument,
	ExchangeFormatError,
	exportClaudeCodeJsonl,
	importClaudeCodeJsonl,
	importExchangeDocument,
	importTurns,
	importZCodeSession,
	parseExchangeDocument,
	parseExchangeJson,
	readSessionForExport,
} from "../src/portable/index.js";
import { deriveMessages, newTurnId } from "../src/session/index.js";
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

function callId(id: string): ToolCallId {
	return id as ToolCallId;
}

/** 去掉**会话身份**（`sessionId`）：导入方新建会话，其余字段应当逐字段保留。 */
function stripIdentity(events: readonly SessionEvent[]): unknown[] {
	return events.map((event) => ({
		seq: event.seq,
		id: event.id,
		type: event.type,
		at: event.at,
		payload: event.payload,
	}));
}

function readJsonLines(path: string): SessionEvent[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";
const T3 = "2026-01-01T00:00:03.000Z";

/** 造一个"什么都有"的会话：工具轨迹 / 审批 / 模式切换 / 记忆注入 / 后台子代理结果。 */
async function makeRichSession(home: string, cwd: string): Promise<SessionId> {
	const store = createSessionStore({ home });
	const handle = await store.create({ cwd, mode: "build", model: "m9-model", at: T0 });
	try {
		await handle.append({
			type: "turn/start",
			payload: { turnId: newTurnId(0), index: 0 },
			at: T1,
		});
		await handle.append({ type: "user/message", payload: { content: "PLEASE" }, at: T1 });
		await handle.append({
			type: "assistant/message",
			payload: {
				content: "LOOKING",
				toolCalls: [{ callId: callId("c1"), toolName: "read", input: { path: "a.ts" } }],
				stopReason: "tool_call",
			},
			at: T1,
		});
		await handle.append({
			type: "tool/call",
			payload: { callId: callId("c1"), toolName: "read", input: { path: "a.ts" } },
			at: T1,
		});
		await handle.append({
			type: "permission/decision",
			payload: { callId: callId("c1"), toolName: "read", decision: "allow", reason: "readonly" },
			at: T1,
		});
		await handle.append({
			type: "tool/result",
			payload: {
				callId: callId("c1"),
				toolName: "read",
				ok: true,
				output: { text: "FILE" },
				durationMs: 3,
			},
			at: T1,
		});
		await handle.append({
			type: "mode/changed",
			payload: { from: "plan", to: "build", reason: "user command" },
			at: T2,
		});
		await handle.append({
			type: "memory/injected",
			payload: {
				target: "user-prefix",
				source: "mcp:memory/search",
				content: "REMEMBER",
				memoryIds: ["m1"],
			},
			at: T2,
		});
		await handle.append({
			type: "subagent/result",
			payload: { childSessionId: "ses_child" as never, kind: "fresh", ok: true, summary: "BG" },
			at: T3,
		});
		await handle.append({
			type: "assistant/message",
			payload: { content: "DONE", stopReason: "end_turn" },
			at: T3,
		});
		await handle.append({
			type: "turn/end",
			payload: { turnId: newTurnId(0), stopReason: "end_turn" },
			at: T3,
		});
		await handle.append({ type: "session/end", payload: { reason: "exit" }, at: T3 });
		return handle.sessionId;
	} finally {
		await handle.close();
		await store.dispose();
	}
}

describe("M9 canonical 交换文档：往返语义无损（ADR-019）", () => {
	it("导出 -> 解析 -> 导入后，除 sessionId 外的事件序列逐字段深等，且投影与 created_at 一致", async () => {
		const sourceHome = newTemp("aster-m9-src-");
		const targetHome = newTemp("aster-m9-dst-");
		const cwd = newTemp("aster-m9-cwd-");
		const sessionId = await makeRichSession(sourceHome, cwd);

		const sourceStore = createSessionStore({ home: sourceHome });
		const exported = await readSessionForExport({
			store: sourceStore,
			sessionId,
			producer: ASTER_PRODUCER,
		});
		await sourceStore.dispose();

		const document = buildExchangeDocument({
			session: exported.meta,
			events: exported.events,
			producer: exported.producer,
		});
		expect(document.format).toBe(EXCHANGE_FORMAT);
		expect(document.formatVersion).toBe(EXCHANGE_FORMAT_VERSION);

		// 走一遍真实序列化（JSON -> 文本 -> 解析），确保不是"内存里自说自话"
		const parsed = parseExchangeJson(`${JSON.stringify(document, null, 2)}\n`);
		expect(parsed.session).toEqual(exported.meta);

		const targetStore = createSessionStore({ home: targetHome });
		const imported = await importExchangeDocument({
			store: targetStore,
			events: parsed.events,
			session: parsed.session,
		});
		await targetStore.dispose();

		expect(imported.sessionId).not.toBe(sessionId); // 导入方新建会话（身份不属于导入方）
		expect(imported.eventCount).toBe(exported.events.length);

		const replayed = readJsonLines(join(targetHome, "sessions", `${imported.sessionId}.jsonl`));
		expect(stripIdentity(replayed)).toEqual(stripIdentity(exported.events));
		expect(deriveMessages(replayed)).toEqual(deriveMessages(exported.events));

		// 索引也保留原创建时间（否则会出现 created_at > updated_at 的自相矛盾派生行）
		const check = createSessionStore({ home: targetHome });
		const metas = await check.list();
		await check.dispose();
		const row = metas.find((meta) => meta.sessionId === imported.sessionId);
		expect(row?.createdAt).toBe(T0);
		expect(row?.eventCount).toBe(exported.events.length);
		expect(row?.mode).toBe("build");
	});
});

describe("M9 版本门禁与载荷校验（ADR-019）", () => {
	function baseDocument() {
		return {
			format: EXCHANGE_FORMAT,
			formatVersion: EXCHANGE_FORMAT_VERSION,
			producer: { name: "aster", version: "1.0.0" },
			session: { cwd: "D:\\x", mode: "build", createdAt: T0, updatedAt: T1 },
			events: [
				{
					type: "session/start",
					payload: { formatVersion: SESSION_FORMAT_VERSION, cwd: "D:\\x", mode: "build" },
					at: T0,
				},
				{ type: "user/message", payload: { content: "hi" }, at: T1 },
			],
		};
	}

	it("更高版本必拒（绝不静默降级去读一个看不懂的格式）", () => {
		const doc = { ...baseDocument(), formatVersion: EXCHANGE_FORMAT_VERSION + 1 };
		expect(() => parseExchangeDocument(doc)).toThrowError(/newer than this client supports/);
		try {
			parseExchangeDocument(doc);
		} catch (error) {
			expect(error).toBeInstanceOf(ExchangeFormatError);
			expect((error as ExchangeFormatError).code).toBe("version_unsupported");
		}
	});

	it("更早版本必拒（v1 是首版，没有可用的迁移路径）", () => {
		try {
			parseExchangeDocument({ ...baseDocument(), formatVersion: 0 });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as ExchangeFormatError).code).toBe("version_unmigratable");
		}
	});

	it("非法文档（错 format / 缺 version / 坏 JSON）一律快速失败且原因可读", () => {
		expect(() => parseExchangeDocument({ ...baseDocument(), format: "someone-else" })).toThrowError(
			/not a valid aster-session-exchange document/,
		);
		const missing = baseDocument() as Record<string, unknown>;
		missing.formatVersion = undefined;
		expect(() => parseExchangeDocument(missing)).toThrowError(/formatVersion/);
		expect(() => parseExchangeJson("{ not json")).toThrowError(/not valid JSON/);
	});

	it("载荷校验：篡改会进模型历史的载荷必拒（审计类事件则不强求形状）", () => {
		const doc = baseDocument();
		const tampered = {
			...doc,
			events: [doc.events[0], { ...doc.events[1], payload: { content: 42 } }],
		};
		try {
			parseExchangeDocument(tampered);
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as ExchangeFormatError).code).toBe("payload_invalid");
			expect((error as ExchangeFormatError).message).toContain('must have a string "content"');
		}
	});

	it("取值域与仓内其它事实源对齐（模式枚举 / producer 版本 / CLI format 域）", () => {
		// mode 取值域必须与 AGENT_MODES 一致（config/schema.ts 同款纪律）
		for (const mode of AGENT_MODES) {
			expect(
				parseExchangeDocument({ ...baseDocument(), session: { ...baseDocument().session, mode } })
					.session.mode,
			).toBe(mode);
		}
		expect(() =>
			parseExchangeDocument({
				...baseDocument(),
				session: { ...baseDocument().session, mode: "yolo" },
			}),
		).toThrowError(/mode/);

		// producer 版本必须与 package.json 对齐（避免两处漂移）
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version: string;
		};
		expect(ASTER_PRODUCER.version).toBe(pkg.version);
		expect(PORTABLE_FORMATS).toEqual(["aster", "claude-code", "zcode"]);
		// 对外交换版本与**我们自己**的事实源版本解耦（各自独立演进）
		expect(typeof EXCHANGE_FORMAT_VERSION).toBe("number");
		expect(typeof SESSION_FORMAT_VERSION).toBe("number");
	});
});

describe("M9 厂商适配器（best-effort、有损清单显式）", () => {
	/** 照已观察到的 Claude Code 原生形状手写的 fixture（含各种应当被清洗的记录）。 */
	const CLAUDE_FIXTURE = [
		`{"type":"queue-operation","timestamp":"${T0}"}`,
		`{"type":"user","cwd":"D:\\\\repo","timestamp":"${T1}","message":{"role":"user","content":"<ide_opened_file>noise</ide_opened_file>REAL QUESTION"}}`,
		`{"type":"user","cwd":"D:\\\\repo","isMeta":true,"timestamp":"${T1}","message":{"content":"meta noise"}}`,
		`{"type":"user","timestamp":"${T1}","message":{"content":[{"type":"tool_result","content":"TOOL NOISE"},{"type":"text","text":"KEEP THIS"}]}}`,
		`{"type":"assistant","timestamp":"${T1}","message":{"model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}`,
		`{"type":"assistant","cwd":"D:\\\\repo","timestamp":"${T2}","message":{"model":"claude-x","content":[{"type":"text","text":"PART ON"}],"stop_reason":"tool_use"}}`,
		`{"type":"assistant","timestamp":"${T2}","message":{"model":"claude-x","content":[{"type":"text","text":"E TWO"}],"stop_reason":"end_turn"}}`,
		`{"type":"assistant","isSidechain":true,"timestamp":"${T2}","message":{"content":[{"type":"text","text":"SIDECHAIN NOISE"}]}}`,
		`{"type":"system","subtype":"local_command","content":"<local-command-stdout>cmd noise</local-command-stdout>","timestamp":"${T2}"}`,
		`{"type":"user","cwd":"D:\\\\repo","timestamp":"${T3}","message":{"role":"user","content":"SECOND QUESTION"}}`,
		`{"type":"assistant","cwd":"D:\\\\repo","timestamp":"${T3}","message":{"model":"claude-x","content":[{"type":"text","text":"ANSWER TWO"}],"stop_reason":"end_turn"}}`,
	].join("\n");

	it("Claude Code 导入：按已观察形状清洗噪音、聚合连续 assistant，只留可见文本", async () => {
		const parsed = importClaudeCodeJsonl(CLAUDE_FIXTURE);
		expect(parsed.cwd).toBe("D:\\repo");
		expect(parsed.model).toBe("claude-x"); // `<synthetic>` 占位不参与
		expect(parsed.turns).toEqual([
			{ role: "user", content: "REAL QUESTION", at: T1 },
			{ role: "user", content: "KEEP THIS", at: T1 }, // tool_result 被丢，text 保留
			{ role: "assistant", content: "PART ONE TWO", at: T2 }, // 连续两条（在词中间被拆开）聚合成一轮
			{ role: "user", content: "SECOND QUESTION", at: T3 },
			{ role: "assistant", content: "ANSWER TWO", at: T3 },
		]);

		// 落成我们自己的会话后：投影里只应有这 5 条，且**没有** tool 角色
		const home = newTemp("aster-m9-cc-home-");
		const store = createSessionStore({ home });
		const result = await importTurns({
			store,
			turns: parsed.turns,
			cwd: parsed.cwd ?? "",
			mode: "plan",
			...(parsed.createdAt === undefined ? {} : { createdAt: parsed.createdAt }),
		});
		await store.dispose();
		expect(result.eventCount).toBe(parsed.turns.length + 2); // session/start + turns + session/end

		const events = readJsonLines(join(home, "sessions", `${result.sessionId}.jsonl`));
		expect(deriveMessages(events).map((message) => message.content)).toEqual([
			"REAL QUESTION",
			"KEEP THIS",
			"PART ONE TWO",
			"SECOND QUESTION",
			"ANSWER TWO",
		]);
		expect(events.some((event) => event.type === "tool/result")).toBe(false);
		// 时间戳被如实保留（第一轮用 fixture 的时间）
		expect(events[1]?.at).toBe(T1);
	});

	it("Claude Code 导出 -> 再导入：轮次逐条深等（有损只在工具轨迹，而轮次本就不含它）", () => {
		const turns = [
			{ role: "user" as const, content: "Q1", at: T1 },
			{ role: "assistant" as const, content: "A1", at: T2 },
		];
		const text = exportClaudeCodeJsonl({ cwd: "D:\\repo", turns });
		const lines = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		// 只写证据里被读取的字段（不臆造 uuid / parentUuid）
		expect(Object.keys(lines[0] ?? {}).sort()).toEqual(["cwd", "message", "timestamp", "type"]);
		expect(importClaudeCodeJsonl(text).turns).toEqual(turns);
	});

	it("ZCode 会话文件：可读的字段才取用（mode 只在 plan/build 时采纳），导出文档 shape 合法", () => {
		const source = {
			meta: {
				taskId: "t1",
				traceId: "tr1",
				title: "T",
				workspacePath: "D:\\repo",
				createdAt: Date.parse(T1),
				updatedAt: Date.parse(T2),
				mode: "yolo",
				model: "glm-x",
				unknownExtra: 1,
			},
			messages: [
				{ role: "user", content: "ZQ", timestamp: Date.parse(T1) },
				{ role: "assistant", content: "ZA", timestamp: Date.parse(T2), model: "glm-x" },
			],
		};
		const parsed = importZCodeSession(JSON.stringify(source));
		expect(parsed.mode).toBeUndefined(); // `yolo` 不在我们的取值域 -> 不采纳（不臆造）
		expect(parsed.cwd).toBe("D:\\repo");
		expect(parsed.model).toBe("glm-x");
		expect(parsed.turns).toEqual([
			{ role: "user", content: "ZQ", at: T1 },
			{ role: "assistant", content: "ZA", at: T2 },
		]);
		expect(
			importZCodeSession(JSON.stringify({ ...source, meta: { ...source.meta, mode: "build" } }))
				.mode,
		).toBe("build");
		expect(() => importZCodeSession(JSON.stringify({ messages: [] }))).toThrowError(/no messages/);
		expect(() => importZCodeSession("[]")).toThrowError(/does not match the shape/);
	});
});

describe("M9 CLI 接线：--export / --import（ADR-019）", () => {
	it("parseArgs 的取值域校验；--format 只接受已声明的三个值", () => {
		expect(parseArgs(["--export", "latest", "--out", "x.json"])).toMatchObject({
			exportTarget: "latest",
			out: "x.json",
		});
		expect(parseArgs(["--import", "x.json", "--format", "claude-code"]).format).toBe("claude-code");
		expect(() => parseArgs(["--format", "openai"])).toThrowError(/--format must be one of/);
		expect(() => parseArgs(["--export"])).toThrowError(/--export requires/);
		expect(() => parseArgs(["--import", "x.json", "--out"])).toThrowError(/--out requires/);
	});

	it("端到端：会话 -> 导出文件 -> 导入到另一个数据根；厂商路径打印有损清单", async () => {
		const cwd = newTemp("aster-m9-cli-cwd-");
		const sourceHome = newTemp("aster-m9-cli-src-");
		const targetHome = newTemp("aster-m9-cli-dst-");
		const outDir = newTemp("aster-m9-cli-out-");
		const sessionId = await makeRichSession(sourceHome, cwd);

		const lines: string[] = [];
		const output = { write: (text: string) => lines.push(text) };

		// 1) 导出可移植文档
		const asterOut = join(outDir, "session.aster.json");
		await runPortableCommand({
			home: sourceHome,
			exportTarget: sessionId,
			format: "aster",
			out: asterOut,
			output,
		});
		expect(lines.join("")).toContain("lossless for Aster");

		// 2) 导入到另一个数据根（新会话 id，事件数一致）
		lines.length = 0;
		await runPortableCommand({ home: targetHome, importPath: asterOut, format: "aster", output });
		const printed = lines.join("");
		expect(printed).toContain("imported");
		expect(printed).toContain("resume with: aster --resume");

		const targetStore = createSessionStore({ home: targetHome });
		const metas = await targetStore.list();
		await targetStore.dispose();
		expect(metas).toHaveLength(1);
		expect(metas[0]?.sessionId).not.toBe(sessionId);

		// 3) 厂商路径：必须**打印有损清单**，且工具轨迹确实没被搬过去
		lines.length = 0;
		const ccOut = join(outDir, "session.claude.jsonl");
		await runPortableCommand({
			home: sourceHome,
			exportTarget: sessionId,
			format: "claude-code",
			out: ccOut,
			output,
		});
		const noteText = lines.join("");
		expect(noteText).toContain("best-effort adapter");
		expect(noteText).toContain("tool calls + tool results");

		lines.length = 0;
		const ccHome = newTemp("aster-m9-cli-cc-");
		await runPortableCommand({ home: ccHome, importPath: ccOut, format: "claude-code", output });
		expect(lines.join("")).toContain("best-effort adapter");

		const ccStore = createSessionStore({ home: ccHome });
		const ccMetas = await ccStore.list();
		await ccStore.dispose();
		const ccEvents = readJsonLines(join(ccHome, "sessions", `${ccMetas[0]?.sessionId}.jsonl`));
		const projected = deriveMessages(ccEvents);
		expect(projected.some((message) => message.role === "tool")).toBe(false); // 工具轨迹没搬过来
		const flat = projected.map((message) => message.content).join("\n");
		expect(flat).toContain("PLEASE");
		expect(flat).not.toContain("FILE"); // 工具输出（tool/result 的 output）**没有**被搬过来
	});

	it("--export 缺 --out 会快速失败（不产生半截文件）", async () => {
		const home = newTemp("aster-m9-noout-");
		const sessionId = await makeRichSession(home, newTemp("aster-m9-noout-cwd-"));
		await expect(
			runPortableCommand({
				home,
				exportTarget: sessionId,
				format: "aster",
				output: { write: () => undefined },
			}),
		).rejects.toThrowError(/--export requires --out/);
	});
});
