import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionEvent } from "@aster/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionStore } from "../src/persist/index.js";
import { makeTempDir } from "./helpers/tmp.js";

let home: string;

beforeEach(() => {
	home = makeTempDir("aster-persist-");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** 直接读取磁盘上的派生索引，得到两表全量有序快照（供逐条一致性比对）。 */
function readIndexSnapshot(indexFile: string): { sessions: unknown[]; events: unknown[] } {
	const db = new DatabaseSync(indexFile);
	try {
		const sessions = db
			.prepare(
				"SELECT session_id, cwd, model, mode, created_at, updated_at, event_count, last_seq FROM sessions ORDER BY session_id",
			)
			.all();
		const events = db
			.prepare("SELECT session_id, seq, type, at, payload FROM events ORDER BY session_id, seq")
			.all();
		return { sessions, events };
	} finally {
		db.close();
	}
}

/** 读取 JSONL 的非空行。 */
function jsonlLines(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "");
}

describe("persist: JSONL 事实源 + 可重建索引", () => {
	it("create 写入 JSONL，首条为 session/start", async () => {
		const store = createSessionStore({ home });
		const handle = await store.create({ cwd: "/work", mode: "plan" });
		const file = join(home, "sessions", `${handle.sessionId}.jsonl`);

		expect(existsSync(file)).toBe(true);
		const lines = jsonlLines(file);
		expect(lines.length).toBe(1);

		const first = JSON.parse(lines[0] ?? "");
		expect(first.type).toBe("session/start");
		expect(first.seq).toBe(0);
		expect(first.id).toBe("evt_0");
		expect(first.sessionId).toBe(handle.sessionId);
		expect(first.payload.cwd).toBe("/work");
		expect(first.payload.mode).toBe("plan");

		await store.dispose();
	});

	it("append 后行数一致，resume 可完整恢复事件（持久化 + resume）", async () => {
		const store = createSessionStore({ home });
		const handle = await store.create({ cwd: "/w", mode: "build", model: "gpt-test" });

		const written: SessionEvent[] = [handle.log.events[0] as SessionEvent];
		written.push(await handle.append({ type: "user/message", payload: { content: "hello" } }));
		written.push(await handle.append({ type: "assistant/message", payload: { content: "hi" } }));
		written.push(await handle.append({ type: "user/message", payload: { content: "again" } }));
		await handle.close();

		const file = join(home, "sessions", `${handle.sessionId}.jsonl`);
		expect(jsonlLines(file).length).toBe(written.length);
		expect(jsonlLines(file).length).toBe(4);

		const resumed = await createSessionStore({ home }).resume(handle.sessionId);
		expect(resumed.log.length).toBe(written.length);
		expect(resumed.log.events).toEqual(written);

		await store.dispose();
	});

	it("索引文件被删除后 resume 仍可用（JSONL 单独存在即可）", async () => {
		const store = createSessionStore({ home });
		const handle = await store.create({ cwd: "/w", mode: "plan" });
		const second = await handle.append({ type: "user/message", payload: { content: "x" } });
		await handle.close();

		const indexFile = join(home, "index.sqlite");
		expect(existsSync(indexFile)).toBe(true);
		rmSync(indexFile, { force: true });
		expect(existsSync(indexFile)).toBe(false);

		const resumed = await createSessionStore({ home }).resume(handle.sessionId);
		expect(resumed.log.length).toBe(2);
		expect(resumed.log.events[1]).toEqual(second);

		await store.dispose();
	});

	it("索引可由 JSONL 全量重建，且与实时索引逐条深等", async () => {
		const store = createSessionStore({ home });
		const handle = await store.create({ cwd: "/proj", mode: "build", model: "m" });
		for (let i = 0; i < 5; i++) {
			await handle.append({ type: "user/message", payload: { content: `msg-${i}` } });
		}
		await handle.close();
		await store.dispose();

		const indexFile = join(home, "index.sqlite");
		const snapshotA = readIndexSnapshot(indexFile);

		// 删除索引，完全依赖 JSONL 重建
		rmSync(indexFile, { force: true });

		const store2 = createSessionStore({ home });
		const report = await store2.rebuildIndex();
		expect(report).toEqual({ sessions: 1, events: 6 });

		const snapshotB = readIndexSnapshot(indexFile);
		// 逐条一致（sessions 表 + events 表全量有序快照）
		expect(snapshotB).toEqual(snapshotA);

		await store2.dispose();
	});

	it("list 返回的 SessionMeta 字段正确", async () => {
		const store = createSessionStore({ home });
		const handle = await store.create({ cwd: "/proj", mode: "build", model: "m1" });
		const start = handle.log.events[0] as SessionEvent;

		await handle.append({
			type: "user/message",
			payload: { content: "a" },
			at: "2020-01-01T00:00:01.000Z",
		});
		await handle.append({
			type: "assistant/message",
			payload: { content: "b" },
			at: "2020-01-01T00:00:02.000Z",
		});

		const list = await store.list();
		expect(list.length).toBe(1);
		const meta = list[0];
		expect(meta?.sessionId).toBe(handle.sessionId);
		expect(meta?.cwd).toBe("/proj");
		expect(meta?.mode).toBe("build");
		expect(meta?.model).toBe("m1");
		expect(meta?.eventCount).toBe(3);
		expect(meta?.lastSeq).toBe(2);
		expect(meta?.createdAt).toBe(start.at);
		expect(meta?.updatedAt).toBe("2020-01-01T00:00:02.000Z");

		await store.dispose();
	});

	it("首个存储错误即封禁：抛错且不重试、不产生新 JSONL 行", async () => {
		const store = createSessionStore({ home });
		const handle = await store.create({ cwd: "/w", mode: "plan" });
		const file = join(home, "sessions", `${handle.sessionId}.jsonl`);

		// 把 JSONL 路径替换为一个目录 -> 之后的写入必然失败
		rmSync(file, { force: true });
		mkdirSync(file, { recursive: true });

		let firstError: unknown;
		try {
			await handle.append({ type: "user/message", payload: { content: "boom" } });
		} catch (err) {
			firstError = err;
		}
		expect(firstError).toBeInstanceOf(Error);

		// 再次 append 抛同一错误（已封禁，不重试）
		await expect(
			handle.append({ type: "user/message", payload: { content: "again" } }),
		).rejects.toBe(firstError);

		// 没有产生任何新的 JSONL 行（该路径仍是空目录）
		expect(readdirSync(file).length).toBe(0);

		await store.dispose();
	});

	it("rebuildIndex 幂等：连续两次重建结果一致", async () => {
		const store = createSessionStore({ home });
		const h1 = await store.create({ cwd: "/a", mode: "plan" });
		await h1.append({ type: "user/message", payload: { content: "1" } });
		await h1.close();

		const h2 = await store.create({ cwd: "/b", mode: "build", model: "m2" });
		await h2.append({ type: "user/message", payload: { content: "2" } });
		await h2.append({ type: "assistant/message", payload: { content: "3" } });
		await h2.close();
		await store.dispose();

		const indexFile = join(home, "index.sqlite");
		rmSync(indexFile, { force: true });

		const store2 = createSessionStore({ home });
		const first = await store2.rebuildIndex();
		const snapshot1 = readIndexSnapshot(indexFile);
		const second = await store2.rebuildIndex();
		const snapshot2 = readIndexSnapshot(indexFile);

		expect(second).toEqual(first);
		expect(snapshot2).toEqual(snapshot1);
		expect(second).toEqual({ sessions: 2, events: 5 });

		await store2.dispose();
	});
});
