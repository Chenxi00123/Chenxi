/**
 * L1 记忆质量判官（ADR-028，M12b）：**纯函数 / 离线 / 无 LLM / 零外部依赖**。
 *
 * 定位（别夸大，ADR 里已写死）：这是 `05 §3.2` 三层门禁里**每次 PR 必跑**的那层——**规则判官**；
 * 它判的是**记忆层输出**（fixture 里的抽取 / 检索结果），**不是**"写入闸门"（自动抽取不做，ADR-016）。
 *
 * 四条**可证伪**断言：
 *  ① `judgeExtraction`  **抽取完备性**：抽取集 ⊇ golden 集（归一化后比对，**缺一即失败**）；
 *  ② `judgeRetrieval`   **检索命中**：`top-k` 必须包含目标记忆；
 *  ③ `judgeBoundary`    **Memory Boundary**：**未被提及**的 query **必须返回空**（编造即失败）；
 *  ④ `judgeUpdate`      **更新原子性**：新事实生效 **且** 旧记忆失效（两条矛盾同时可检索即失败）。
 *
 * 判官原则（思想借鉴 HaluMem 的指标定义，**文字与实现原创**）：**禁止外部知识**（只看 fixture 给出的事实）；
 * 多元素"缺一即 Omission"（= ①的集合语义）；既有"该有而没有"又有"凭空多出"时**分别报**，本层不做主观加权打分。
 */
import type { MemoryRecord } from "@aster/schema";

export type L1FindingKind =
	| "missing" // 该有的记忆没被抽取出来
	| "miss" // 检索 top-k 没命中目标
	| "fabricated" // 未提及的 query 却返回了记忆（编造）
	| "conflict"; // 新旧矛盾记忆可同时检索 / 旧记忆未失效

export interface L1Finding {
	readonly kind: L1FindingKind;
	/** 可读详情（**失败时必须能直接看出差在哪**，不做概括）。 */
	readonly detail: string;
}

export interface L1Report {
	readonly ok: boolean;
	readonly findings: readonly L1Finding[];
}

function report(findings: L1Finding[]): L1Report {
	return { ok: findings.length === 0, findings };
}

/** 两个 CJK 字符之间的空白（含全角空格）——中文里空格几乎总是噪音：`用户 偏好` ≡ `用户偏好`。 */
const CJK_CORE_SPACE_RE =
	/(?<=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g;

/**
 * 归一化（**L1 只做词法比对，不做语义等价**——语义等价是 L2 判官的活，ADR-028 已写明）：
 *  1. 空白折叠成单空格 + 去首尾 + 大小写不敏感；
 *  2. **两个 CJK 字符之间的空白一律去掉**；英文词间的空格**保留**（`fast edit` ≠ `fastedit`）。
 */
export function normalizeMemoryText(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase().replace(CJK_CORE_SPACE_RE, "");
}

/** ① 抽取完备性：抽取记忆集 **⊇** golden 集。 */
export function judgeExtraction(extracted: readonly string[], golden: readonly string[]): L1Report {
	const pool = new Set(extracted.map(normalizeMemoryText));
	const findings: L1Finding[] = [];
	for (const item of golden) {
		if (!pool.has(normalizeMemoryText(item))) {
			findings.push({ kind: "missing", detail: `golden 记忆未被抽取：${item}` });
		}
	}
	return report(findings);
}

/** ② 检索命中：`top-k` 必须包含全部目标记忆（`k` 由 fixture 给出）。 */
export function judgeRetrieval(
	records: readonly MemoryRecord[],
	goldenIds: readonly string[],
	k: number,
): L1Report {
	const top = records.slice(0, Math.max(0, k)).map((record) => record.id);
	const findings: L1Finding[] = [];
	for (const id of goldenIds) {
		if (!top.includes(id)) {
			findings.push({
				kind: "miss",
				detail: `top-${k} 未命中 ${id}（实际：${top.length === 0 ? "(空)" : top.join(", ")}）`,
			});
		}
	}
	return report(findings);
}

/**
 * ③ Memory Boundary：**未被提及**的 query **必须返回空**（"没有记忆"是正确回答）。
 * 返回非空即 `fabricated`——这是 R13 记忆污染长尾的**离线可测形态**。
 */
export function judgeBoundary(records: readonly MemoryRecord[], query: string): L1Report {
	if (records.length === 0) return report([]);
	return report([
		{
			kind: "fabricated",
			detail: `未提及的 query「${query}」返回了 ${records.length} 条记忆：${records
				.map((record) => record.id)
				.join(", ")}`,
		},
	]);
}

/** ④ 更新原子性（`05 §3.3` 断言 1）：不允许"旧记忆未失效 + 新事实已生效"同时成立。 */
export function judgeUpdate(params: {
	readonly oldRecord: MemoryRecord;
	readonly newRecord: MemoryRecord;
}): L1Report {
	const findings: L1Finding[] = [];
	if (params.oldRecord.invalidAt === undefined || params.oldRecord.invalidAt === null) {
		findings.push({
			kind: "conflict",
			detail: `旧记忆未失效（invalidAt 为空）：${params.oldRecord.id}`,
		});
	}
	if (params.newRecord.invalidAt !== undefined && params.newRecord.invalidAt !== null) {
		findings.push({ kind: "conflict", detail: `新事实却被标为失效：${params.newRecord.id}` });
	}
	return report(findings);
}

/** 把一组报告合成一个（`ok` 全真才真；findings 汇总，便于"一条命令看清哪里坏了"）。 */
export function mergeReports(
	reports: readonly { readonly label: string; readonly report: L1Report }[],
): L1Report {
	const findings: L1Finding[] = [];
	for (const entry of reports) {
		for (const finding of entry.report.findings) {
			findings.push({ kind: finding.kind, detail: `[${entry.label}] ${finding.detail}` });
		}
	}
	return report(findings);
}
