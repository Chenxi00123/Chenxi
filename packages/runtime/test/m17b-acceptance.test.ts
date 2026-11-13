/**
 * M17b 验收测试：**显式取代 + bitemporal 失效 + 写后验证**（ADR-034）。
 *
 * 主张 3 的运行时形态：**失效而非删除**，且**绝不假装成功**——
 * 写入侧必须真的重检索旧事实，确认它已不可见（或已带 `invalidAt`），才记 `verification: "ok"`；
 * 否则如实记 `old_still_visible`。
 *
 * 边界（与 ADR 一致）：只有用户**把旧事实也说出来**（`不要再 vim，改成 neovim`）才可能失效它；
 * 只说"改成 neovim"时**不猜**目标，记为"未能失效"。
 */
import type {
	EventDraft,
	EventType,
	MemoryAdapter,
	MemoryRecord,
	MemoryScope,
} from "@aster/schema";
import { describe, expect, it } from "vitest";
import {
	createMemoryWriter,
	extractMemoryCandidates,
	normalizeMemoryText,
} from "../src/memory/index.js";

const SCOPE: MemoryScope = { user: "u1", agent: "aster", session: "s1" };
const NOW = "2026-10-21T00:00:00.000Z";

type CapturedEvent = { type: string; payload: Record<string, unknown> };

function collector(): {
	events: CapturedEvent[];
	append: <T extends EventType>(draft: EventDraft<T>) => Promise<never>;
} {
	const events: CapturedEvent[] = [];
	const append = async <T extends EventType>(draft: EventDraft<T>): Promise<never> => {
		events.push({ type: draft.type, payload: draft.payload as unknown as Record<string, unknown> });
		return { seq: events.length - 1 } as never;
	};
	return { events, append };
}

interface StoreOptions {
	readonly seed?: readonly MemoryRecord[];
	readonly withInvalidate?: boolean;
	readonly ignoreInvalidate?: boolean;
	readonly failInvalidate?: boolean;
}

function makeStore(options: StoreOptions = {}): {
	adapter: MemoryAdapter;
	records: MemoryRecord[];
	invalidated: string[];
	invalidateScopes: MemoryScope[];
} {
	const records: MemoryRecord[] = [...(options.seed ?? [])];
	const invalidated: string[] = [];
	const invalidateScopes: MemoryScope[] = [];
	let nextId = records.length + 1;
	const adapter: MemoryAdapter = {
		async search(req) {
			const query = normalizeMemoryText(req.query);
			return {
				records: records
					.filter((record) => record.invalidAt === undefined || record.invalidAt === null)
					.filter((record) => query === "" || normalizeMemoryText(record.content).includes(query)),
			};
		},
		async getSessionMemories() {
			return { records };
		},
		async add(req) {
			const record: MemoryRecord = {
				id: `new${nextId}`,
				content: req.content,
				createdAt: NOW,
				validAt: NOW,
				invalidAt: null,
				...(req.provenance === undefined ? {} : { provenance: req.provenance }),
			};
			nextId += 1;
			records.push(record);
			return record;
		},
		...(options.withInvalidate === false
			? {}
			: {
					async invalidate(req) {
						if (options.failInvalidate === true) throw new Error("invalidate is down");
						invalidateScopes.push(req.scope);
						const target = records.find((record) => record.id === req.id);
						if (target === undefined) throw new Error(`no such memory: ${req.id}`);
						if (options.ignoreInvalidate === true) return;
						invalidated.push(req.id);
						records[records.indexOf(target)] = { ...target, invalidAt: req.invalidAt ?? NOW };
					},
				}),
	};
	return { adapter, records, invalidated, invalidateScopes };
}

function oldVim(): MemoryRecord {
	return { id: "old", content: "我的编辑器偏好是 vim", ...{ validAt: NOW, invalidAt: null } };
}

describe("M17b 取代句式抽取（ADR-034）", () => {
	it("`不要再 X，改成 Y` ⇒ 新事实 Y + 旧检索词 X", () => {
		const result = extractMemoryCandidates("不要再 vim，改成 neovim");
		expect(result.candidates).toEqual([{ text: "neovim", supersedesQuery: "vim" }]);
	});

	it("`以后用 Y 代替 X` ⇒ 新事实 Y + 旧检索词 X", () => {
		const result = extractMemoryCandidates("以后用 neovim 代替 vim");
		expect(result.candidates).toEqual([{ text: "neovim", supersedesQuery: "vim" }]);
	});

	it("英文 `never use X, use Y` 同样识别", () => {
		const result = extractMemoryCandidates("Never use tabs, use spaces from now on");
		expect(result.candidates).toEqual([{ text: "spaces from now on", supersedesQuery: "tabs" }]);
	});

	it("只说 `改成 Y`（没给出旧事实）⇒ **不猜**目标，`supersedesQuery` 缺席", () => {
		const result = extractMemoryCandidates("记住 改成 neovim");
		expect(result.candidates.some((candidate) => candidate.text.includes("neovim"))).toBe(true);
		expect(result.candidates.every((candidate) => candidate.supersedesQuery === undefined)).toBe(
			true,
		);
	});

	it("取代句式不会被普通标记重复抽一遍（同一句只产一条候选）", () => {
		const result = extractMemoryCandidates("记住 不要再 vim，改成 neovim");
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]?.supersedesQuery).toBe("vim");
	});
});

describe("M17b 失效与写后验证（ADR-034）", () => {
	it('写入新事实 + 失效旧事实 + 验证通过：`verification: "ok"`', async () => {
		const { adapter, records, invalidated, invalidateScopes } = makeStore({ seed: [oldVim()] });
		const writer = createMemoryWriter({ adapter, scope: SCOPE, source: "test", now: () => NOW });
		const { events, append } = collector();
		const report = await writer.afterTurn(
			{ prompt: "不要再 vim，改成 neovim", sourceSeq: 9 },
			append,
		);

		expect(report.added).toBe(1);
		expect(invalidated).toEqual(["old"]);
		// 旧事实可能是**别的会话**写的 ⇒ 失效必须用**跨会话**作用域（M17 冒烟抓到的真缺陷）
		expect(invalidateScopes).toEqual([{ ...SCOPE, session: "*" }]);
		expect(records.find((record) => record.id === "old")?.invalidAt).toBe(NOW);
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({
			decision: "added",
			content: "neovim",
			sourceSeq: 9,
			invalidatedIds: ["old"],
			verification: "ok",
		});
	});

	it("没配失效工具 ⇒ 仍写入，但**如实说**旧事实可能还能检索到（不声称已失效）", async () => {
		const { adapter } = makeStore({ seed: [oldVim()], withInvalidate: false });
		const writer = createMemoryWriter({ adapter, scope: SCOPE, source: "test", now: () => NOW });
		const { events, append } = collector();
		await writer.afterTurn({ prompt: "不要再 vim，改成 neovim", sourceSeq: 10 }, append);
		expect(events[0]?.payload).toMatchObject({ decision: "added", content: "neovim" });
		expect(events[0]?.payload.verification).toBeUndefined();
		expect(String(events[0]?.payload.reason)).toContain("not configured");
	});

	it('失效调用**接受但不生效** ⇒ `verification: "old_still_visible"`（绝不假装成功）', async () => {
		const { adapter } = makeStore({ seed: [oldVim()], ignoreInvalidate: true });
		const writer = createMemoryWriter({ adapter, scope: SCOPE, source: "test", now: () => NOW });
		const { events, append } = collector();
		await writer.afterTurn({ prompt: "不要再 vim，改成 neovim", sourceSeq: 11 }, append);
		expect(events[0]?.payload).toMatchObject({
			decision: "added",
			verification: "old_still_visible",
			invalidatedIds: ["old"],
		});
	});

	it("失效调用**报错** ⇒ 记 `old_still_visible` + 可读原因", async () => {
		const { adapter } = makeStore({ seed: [oldVim()], failInvalidate: true });
		const writer = createMemoryWriter({ adapter, scope: SCOPE, source: "test", now: () => NOW });
		const { events, append } = collector();
		await writer.afterTurn({ prompt: "不要再 vim，改成 neovim", sourceSeq: 12 }, append);
		expect(events[0]?.payload).toMatchObject({
			decision: "added",
			verification: "old_still_visible",
			invalidatedIds: [],
		});
		expect(String(events[0]?.payload.reason)).toContain("invalidate failed");
	});

	it("找不到旧事实 ⇒ 只写新的，并**明说**没能失效（不猜、不静默）", async () => {
		const { adapter, invalidated } = makeStore();
		const writer = createMemoryWriter({ adapter, scope: SCOPE, source: "test", now: () => NOW });
		const { events, append } = collector();
		await writer.afterTurn({ prompt: "不要再 vim，改成 neovim", sourceSeq: 13 }, append);
		expect(invalidated).toEqual([]);
		expect(events[0]?.payload).toMatchObject({ decision: "added" });
		expect(String(events[0]?.payload.reason)).toContain("not found");
		expect(events[0]?.payload.verification).toBeUndefined();
	});

	it("写后验证的检索失败 ⇒ 不谎报 `ok`，也不谎报 `old_still_visible`", async () => {
		const records: MemoryRecord[] = [oldVim()];
		let searchCall = 0;
		const adapter: MemoryAdapter = {
			async search(req) {
				searchCall += 1;
				// 第 3 次 = 写后验证（第 1 次去重、第 2 次找旧事实）
				if (searchCall >= 3) throw new Error("verification search is down");
				const query = normalizeMemoryText(req.query);
				return {
					records: records.filter(
						(record) => query === "" || normalizeMemoryText(record.content).includes(query),
					),
				};
			},
			async getSessionMemories() {
				return { records };
			},
			async add(req) {
				const record: MemoryRecord = { id: "new", content: req.content };
				records.push(record);
				return record;
			},
			async invalidate(req) {
				const target = records.find((record) => record.id === req.id);
				if (target !== undefined) records[records.indexOf(target)] = { ...target, invalidAt: NOW };
			},
		};
		const writer = createMemoryWriter({ adapter, scope: SCOPE, source: "test", now: () => NOW });
		const { events, append } = collector();
		await writer.afterTurn({ prompt: "不要再 vim，改成 neovim", sourceSeq: 14 }, append);
		expect(events[0]?.payload).toMatchObject({ decision: "added", invalidatedIds: ["old"] });
		expect(events[0]?.payload.verification).toBeUndefined();
		expect(String(events[0]?.payload.reason)).toContain("verification could not run");
	});
});
