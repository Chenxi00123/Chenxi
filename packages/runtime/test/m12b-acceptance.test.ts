/**
 * M12b 验收测试（总工程师独立编写）：L1 记忆质量判官（ADR-028）。
 *
 * 覆盖：
 *  - **fixture 纪律**：vendored 进仓、`version` pin、**sha256 与仓内常量一致**（数据漂移当场变红）；
 *  - **四条断言的正例**：抽取完备性（⊇ golden）/ top-k 命中 / **Memory Boundary（未提及的 query 必须返回空）** /
 *    更新原子性（新事实生效 + 旧记忆失效）；
 *  - **反例（关键）**：**故意篡改**输入必须让判官变红——缺一条 golden、top-k 挤掉目标、给边界 query 塞记录（= 编造）、
 *    旧记忆没失效 / 新事实被标失效；**判官不是"永远 ok 的摆设"**；
 *  - **离线纪律**：判官源码**零外部依赖**（只允许一处 `import type` 自 `@aster/schema`，无 `node:` / `fetch(` / 网络）。
 *
 * 说明（如实标注）：本批只做 **L1**；**L2（采样 LLM 判官）/ L3（全量）** 需要真实模型端点 ⇒ 本机无法实测，**显式未做**。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryRecord } from "@aster/schema";
import { describe, expect, it } from "vitest";
import {
	judgeBoundary,
	judgeExtraction,
	judgeRetrieval,
	judgeUpdate,
	mergeReports,
	normalizeMemoryText,
} from "../src/memory/index.js";

/** fixture 的 sha256（**数据 pin**：改了数据集就必须同步改这里，否则测试变红）。 */
const FIXTURE_SHA256 = "c1342575fa940301cfdb840e7e9b15afba57391cd932f49a33f85d8b7a1d88ad";
/** 本测试文件所在目录（ESM 下用 `import.meta.url` 解析，不依赖 `__dirname`）。 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "memory-l1", "memory-l1.json");

interface ExtractionCase {
	readonly case: string;
	readonly extracted: readonly string[];
	readonly golden: readonly string[];
}
interface RetrievalCase {
	readonly case: string;
	readonly query: string;
	readonly k: number;
	readonly records: readonly MemoryRecord[];
	readonly goldenIds: readonly string[];
}
interface BoundaryCase {
	readonly case: string;
	readonly query: string;
	readonly records: readonly MemoryRecord[];
}
interface UpdateCase {
	readonly case: string;
	readonly oldRecord: MemoryRecord;
	readonly newRecord: MemoryRecord;
}
interface Fixture {
	readonly version: string;
	readonly note: string;
	readonly extraction: readonly ExtractionCase[];
	readonly retrieval: readonly RetrievalCase[];
	readonly boundary: readonly BoundaryCase[];
	readonly update: readonly UpdateCase[];
}

function loadFixture(): { readonly raw: Buffer; readonly data: Fixture } {
	const raw = readFileSync(FIXTURE_PATH);
	return { raw, data: JSON.parse(raw.toString("utf8")) as Fixture };
}

describe("M12b fixture 纪律：vendored + 版本 pin + sha256", () => {
	it("文件在仓内、版本被 pin、**sha256 与常量一致**（且数据里不含真实用户数据）", () => {
		const { raw, data } = loadFixture();
		expect(data.version).toBe("l1-1");
		expect(data.note).toContain("不含任何真实用户数据");
		expect(createHash("sha256").update(raw).digest("hex")).toBe(FIXTURE_SHA256);
		// 四类用例都**非空**（空的 fixture 会让门禁变成摆设）
		expect(data.extraction.length).toBeGreaterThan(0);
		expect(data.retrieval.length).toBeGreaterThan(0);
		expect(data.boundary.length).toBeGreaterThan(0);
		expect(data.update.length).toBeGreaterThan(0);
	});
});

describe("M12b 四条断言的正例：fixture 全过", () => {
	it("抽取完备性 / top-k 命中 / Memory Boundary / 更新原子性 全部 ok", () => {
		const { data } = loadFixture();
		const reports = [
			...data.extraction.map((item) => ({
				label: `extraction: ${item.case}`,
				report: judgeExtraction(item.extracted, item.golden),
			})),
			...data.retrieval.map((item) => ({
				label: `retrieval: ${item.case}`,
				report: judgeRetrieval(item.records, item.goldenIds, item.k),
			})),
			...data.boundary.map((item) => ({
				label: `boundary: ${item.case}`,
				report: judgeBoundary(item.records, item.query),
			})),
			...data.update.map((item) => ({
				label: `update: ${item.case}`,
				report: judgeUpdate({ oldRecord: item.oldRecord, newRecord: item.newRecord }),
			})),
		];
		const merged = mergeReports(reports);
		// 失败时把 findings 打出来，便于"一条命令看清哪里坏了"
		expect(merged.findings.map((finding) => finding.detail)).toEqual([]);
		expect(merged.ok).toBe(true);
		expect(reports.length).toBeGreaterThanOrEqual(6);
	});

	it("归一化：空白折叠 + 大小写不敏感（中英混排都不误判）", () => {
		expect(normalizeMemoryText("  用户偏好   FAST 编辑  ")).toBe("用户偏好 fast 编辑");
		expect(judgeExtraction(["USER likes short replies"], ["user Likes   Short Replies"]).ok).toBe(
			true,
		);
		expect(judgeExtraction(["用户  偏好 fast"], ["用户偏好 fast"]).ok).toBe(true);
	});
});

describe("M12b 反例：判官必须**真的会因为坏事变红**", () => {
	it("缺一条 golden -> missing（并指出缺的是哪条）", () => {
		const { data } = loadFixture();
		const golden = data.extraction[0]?.golden ?? [];
		const report = judgeExtraction(golden.slice(1), golden); // 少抽一条
		expect(report.ok).toBe(false);
		expect(report.findings[0]?.kind).toBe("missing");
		expect(report.findings[0]?.detail).toContain(golden[0] as string);
	});

	it("top-k 被挤掉 -> miss（`k` 越小越容易看出来）", () => {
		const { data } = loadFixture();
		const item = data.retrieval[0] as RetrievalCase;
		expect(judgeRetrieval(item.records, item.goldenIds, item.k).ok).toBe(true);
		const squeezed = judgeRetrieval(item.records, item.goldenIds, 0); // k=0：什么都没取
		expect(squeezed.ok).toBe(false);
		expect(squeezed.findings[0]?.kind).toBe("miss");
	});

	it("**未提及的 query 返回了记忆 = 编造**（R13 记忆污染长尾的离线可测形态）", () => {
		const { data } = loadFixture();
		const item = data.boundary[0] as BoundaryCase;
		expect(judgeBoundary(item.records, item.query).ok).toBe(true);
		// 记忆层"凭空想起"了一件从没提过的事 —— 必须判红，这正是 L1 最有价值的一条
		const fabricated = judgeBoundary([{ id: "m-pet", content: "用户的猫叫咪咪" }], item.query);
		expect(fabricated.ok).toBe(false);
		expect(fabricated.findings[0]?.kind).toBe("fabricated");
		expect(fabricated.findings[0]?.detail).toContain("m-pet");
	});

	it("旧记忆没失效 / 新事实被标失效 -> conflict", () => {
		const { data } = loadFixture();
		const item = data.update[0] as UpdateCase;
		const stale = judgeUpdate({
			oldRecord: { ...item.oldRecord, invalidAt: null },
			newRecord: item.newRecord,
		});
		expect(stale.ok).toBe(false);
		expect(stale.findings[0]?.detail).toContain(item.oldRecord.id);
		const selfInvalidated = judgeUpdate({
			oldRecord: item.oldRecord,
			newRecord: { ...item.newRecord, invalidAt: "2026-10-01T00:00:00.000Z" },
		});
		expect(selfInvalidated.ok).toBe(false);
		expect(selfInvalidated.findings[0]?.detail).toContain(item.newRecord.id);
	});
});

describe("M12b 离线纪律：判官源码零外部依赖、无网络、无 LLM", () => {
	it("只允许一处 `import type` 自 `@aster/schema`；不得出现 node: / fetch / http", () => {
		const source = readFileSync(join(HERE, "..", "src", "memory", "quality.ts"), "utf8");
		const imports = [...source.matchAll(/^import .*$/gm)].map((match) => match[0]);
		expect(imports).toEqual(['import type { MemoryRecord } from "@aster/schema";']);
		expect(source).not.toContain("node:");
		expect(source).not.toContain("fetch(");
		expect(source).not.toContain("http");
		// 判官本身**不读写文件**（fixture 由测试加载，判官只吃内存里的数据）
		expect(source).not.toContain("readFileSync");
	});
});
