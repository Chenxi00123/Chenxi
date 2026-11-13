/**
 * M1 验收测试（总工程师独立编写，与模块单测**不重复**）：
 * 从 CLI / 端到端层面核验 M1 的可交付判据。
 *
 * 覆盖：
 *  - 判据 #5：会话持久化 + resume，且投影历史与退出前一致
 *  - 判据 #9：删索引 -> rebuild-index -> 逐条一致；JSONL 单独存在时 resume 仍可用
 *  - ADR-003 配套：`deriveMessages` 幂等 / 确定性
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import type { SessionEvent, SessionId } from "@aster/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionRepl } from "../src/cli/repl.js";
import { createSessionStore } from "../src/persist/index.js";
import { deriveMessages } from "../src/session/index.js";
import { makeTempDir } from "./helpers/tmp.js";

const homes: string[] = [];

function newHome(): string {
	const home = makeTempDir("aster-m1-");
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
	const file = join(home, "sessions", `${sessionId}.jsonl`);
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

describe("M1 判据 #5：持久化 + resume（投影历史一致）", () => {
	it("跑一轮 -> 退出 -> --resume -> JSONL 追加可见且投影历史一致", async () => {
		const home = newHome();

		const first = collector();
		const run1 = await runSessionRepl({
			home,
			input: Readable.from(["hello\n", "world\n", "/exit\n"]),
			output: first.output,
		});

		const beforeResume = readEvents(home, run1.sessionId);
		expect(beforeResume[0]?.type).toBe("session/start");
		expect(beforeResume.filter((e) => e.type === "user/message")).toHaveLength(2);
		expect(beforeResume.at(-1)?.type).toBe("session/end");

		const messagesBefore = deriveMessages(beforeResume);

		const second = collector();
		const run2 = await runSessionRepl({
			home,
			resume: run1.sessionId,
			input: Readable.from(["/history\n", "/exit\n"]),
			output: second.output,
		});

		// resume 后同一会话被继续追加（JSONL 追加可见）
		expect(run2.sessionId).toBe(run1.sessionId);
		const afterResume = readEvents(home, run1.sessionId);
		expect(afterResume.length).toBe(beforeResume.length + 1); // 只多了新的 session/end

		// resume 时打印的历史 == 退出前的投影
		expect(second.text()).toContain(`history(${messagesBefore.length}):`);
		expect(second.text()).toContain("[user] hello");
		expect(second.text()).toContain("[user] world");

		// 投影历史与退出前**一致**（session/end 不参与投影）
		expect(deriveMessages(afterResume)).toEqual(messagesBefore);
	});
});

describe("M1 判据 #9：索引可重建且逐条一致", () => {
	it("删掉 SQLite 索引 -> rebuild-index -> 与原索引逐条一致（且 JSONL 单独存在时 resume 可用）", async () => {
		const home = newHome();

		const store = createSessionStore({ home });
		const handle = await store.create({ cwd: process.cwd(), mode: "plan", model: "stub" });
		for (let i = 0; i < 6; i += 1) {
			await handle.append({ type: "user/message", payload: { content: `msg-${i}` } });
		}
		await handle.append({ type: "session/end", payload: { reason: "exit" } });
		await handle.close();
		const sessionId = handle.sessionId;

		// 索引原地快照（直接读 SQLite 两表）
		const snapshotBefore = snapshotIndex(home);
		await store.dispose();

		// 仅保留 JSONL 事实源：删除索引
		rmSync(join(home, "index.sqlite"), { force: true });
		expect(existsSync(join(home, "index.sqlite"))).toBe(false);

		// 重建
		const store2 = createSessionStore({ home });
		const report = await store2.rebuildIndex();
		expect(report.sessions).toBe(1);
		expect(report.events).toBe(8); // 1 start + 6 user + 1 end

		const snapshotAfter = snapshotIndex(home);
		expect(snapshotAfter).toEqual(snapshotBefore);

		// 重建后 resume 仍可用，且事件与 JSONL 一致
		const resumed = await store2.resume(sessionId);
		expect(resumed.log.length).toBe(8);
		expect(deriveMessages(resumed.log.events).map((m) => m.content)).toEqual([
			"msg-0",
			"msg-1",
			"msg-2",
			"msg-3",
			"msg-4",
			"msg-5",
		]);
		await store2.dispose();
	});
});

describe("ADR-003：投影幂等 / 确定性", () => {
	it("同一事件序列多次投影结果深等", async () => {
		const home = newHome();
		const result = await runSessionRepl({
			home,
			input: Readable.from(["a\n", "/history\n", "b\n", "/exit\n"]),
			output: collector().output,
		});
		const events = readEvents(home, result.sessionId);
		const first = deriveMessages(events);
		const second = deriveMessages(events);
		expect(second).toEqual(first);
		expect(first).toHaveLength(2);
	});
});

/** 直连 SQLite 取两表全量行，用于「重建前后逐条一致」的独立比对。 */
function snapshotIndex(home: string): { sessions: unknown[]; events: unknown[] } {
	const db = new DatabaseSync(join(home, "index.sqlite"));
	try {
		const sessions = db.prepare("SELECT * FROM sessions ORDER BY session_id").all() as unknown[];
		const events = db.prepare("SELECT * FROM events ORDER BY session_id, seq").all() as unknown[];
		return { sessions, events };
	} finally {
		db.close();
	}
}
