/**
 * 记忆**写入缝**（ADR-033 / ADR-034）——`after_turn` 的落点。
 *
 * 位置纪律：与 `before_turn` 同一层（CLI 的 `executeTurn`），**`loop` 一行不改**（ADR-004）。
 *
 * 每一次候选决策都落一条 `memory/written`（ADR-033）：写入不是"悄悄发生的副作用"，
 * 而是**可审计的事实**——包括"为什么没写"（重复 / 被闸门拒 / 链路失败）。
 *
 * 失败语义：**fail-open**（记忆是增强，不是依赖）——任何一步失败都只记一条 `failed` 事件
 * + 一条可读提示，**绝不中断回合**。
 *
 * ⚠️ 能力边界：去重只认**归一化后完全相等**；冲突只处理**用户把旧事实也说出来**的显式取代
 * （`不要再 vim，改成 neovim`）——识别不出旧记录时**不猜**，如实记为"未能失效"。
 */
import { createHash } from "node:crypto";
import {
	type EventDraft,
	type EventType,
	MEMORY_ANY_SESSION,
	type MemoryAdapter,
	type MemoryProvenance,
	type MemoryRecord,
	type MemoryScope,
	type MemoryWrittenPayload,
	type SessionEvent,
} from "@chenxi/schema";
import {
	type ExtractionOptions,
	extractMemoryCandidates,
	type MemoryCandidate,
} from "./extract.js";
import { normalizeMemoryText } from "./quality.js";

type AppendFn = <T extends EventType>(draft: EventDraft<T>) => Promise<SessionEvent>;

export interface MemoryWriterOptions extends ExtractionOptions {
	readonly adapter: MemoryAdapter;
	/** **写入**用的作用域：`session` 必须是**真实**会话 id（`*` 只用于检索）。 */
	readonly scope: MemoryScope;
	/** 注入/审计用的来源标签（例如 `mcp:memory/search_memory`）。 */
	readonly source: string;
	/** 可注入时钟（测试确定性）；缺省 `new Date().toISOString()`。 */
	readonly now?: () => string;
}

/** 一轮的写入汇总（调用方据此打印一行可读提示；细节都在事件里）。 */
export interface MemoryWriteReport {
	readonly added: number;
	readonly skipped: number;
	readonly rejected: number;
	readonly failed: number;
}

export interface MemoryWriteSeam {
	afterTurn(
		input: { readonly prompt: string; readonly sourceSeq: number },
		append: AppendFn,
	): Promise<MemoryWriteReport>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isOpen(record: MemoryRecord): boolean {
	return record.invalidAt === undefined || record.invalidAt === null;
}

export function createMemoryWriter(options: MemoryWriterOptions): MemoryWriteSeam {
	const recallScope: MemoryScope = { ...options.scope, session: MEMORY_ANY_SESSION };
	const now = options.now ?? (() => new Date().toISOString());

	/** 落一条审计事件；**落盘失败也不抛**（否则记忆会把回合带崩，违反 fail-open）。 */
	async function record(payload: MemoryWrittenPayload, append: AppendFn): Promise<void> {
		try {
			await append({ type: "memory/written", payload });
		} catch {
			// 审计事件写不进去时我们**没有**别的可写路径；静默（宁可丢审计，不阻塞对话）
		}
	}

	async function writeOne(
		candidate: MemoryCandidate,
		sourceSeq: number,
		promptHash: string,
	): Promise<MemoryWrittenPayload> {
		const content = candidate.text;

		// ① 去重（**跨会话**检索：长期记忆的意义就在这里）
		let existing: readonly MemoryRecord[];
		try {
			const result = await options.adapter.search({ query: content, scope: recallScope, limit: 5 });
			existing = Array.isArray(result?.records) ? result.records : [];
		} catch (error) {
			// 查不了重就不写：宁可漏记，也不制造重复（记忆污染是最难收拾的）
			return {
				decision: "failed",
				content,
				sourceSeq,
				reason: `dedupe search failed, not writing: ${errorMessage(error)}`,
			};
		}
		const normalized = normalizeMemoryText(content);
		const duplicate = existing.find((record) => normalizeMemoryText(record.content) === normalized);
		if (duplicate !== undefined) {
			return {
				decision: "skipped_duplicate",
				content,
				sourceSeq,
				memoryId: duplicate.id,
				reason: `duplicate of ${duplicate.id}`,
			};
		}

		// ② 写入（provenance 只记 hash 元数据，不存 prompt 正文——ADR-010）
		const provenance: MemoryProvenance = {
			promptId: `user-msg-${sourceSeq}`,
			promptVersion: "1",
			promptHash,
		};
		let written: MemoryRecord;
		try {
			written = await options.adapter.add({ content, scope: options.scope, provenance });
		} catch (error) {
			return {
				decision: "failed",
				content,
				sourceSeq,
				reason: `add failed: ${errorMessage(error)}`,
			};
		}

		// ③ 显式取代（M17b）：只有用户把**旧事实**也说清楚时才尝试失效它
		if (candidate.supersedesQuery === undefined) {
			return { decision: "added", content, sourceSeq, memoryId: written.id };
		}
		const oldQuery = candidate.supersedesQuery;
		if (options.adapter.invalidate === undefined) {
			return {
				decision: "added",
				content,
				sourceSeq,
				memoryId: written.id,
				reason: "invalidate tool is not configured; the old fact may still be retrievable",
			};
		}

		let targets: readonly MemoryRecord[];
		try {
			const result = await options.adapter.search({
				query: oldQuery,
				scope: recallScope,
				limit: 5,
			});
			targets = Array.isArray(result?.records) ? result.records : [];
		} catch (error) {
			return {
				decision: "added",
				content,
				sourceSeq,
				memoryId: written.id,
				reason: `supersede search failed: ${errorMessage(error)}`,
			};
		}
		const oldNormalized = normalizeMemoryText(oldQuery);
		const matched = targets.filter(
			(record) =>
				record.id !== written.id &&
				isOpen(record) &&
				normalizeMemoryText(record.content).includes(oldNormalized),
		);
		if (matched.length === 0) {
			return {
				decision: "added",
				content,
				sourceSeq,
				memoryId: written.id,
				reason: `supersede target "${oldQuery}" not found; the old fact may still be retrievable`,
			};
		}

		const invalidatedIds: string[] = [];
		let invalidateError: string | undefined;
		for (const target of matched) {
			try {
				// ⚠️ 用**跨会话作用域**：旧事实可能是**别的会话**写的（长期记忆的定义），
				// 用当前会话 id 去失效它，服务端会找不到（真实缺陷，M17 冒烟抓到）。
				await options.adapter.invalidate({ id: target.id, scope: recallScope, invalidAt: now() });
				invalidatedIds.push(target.id);
			} catch (error) {
				invalidateError = errorMessage(error);
			}
		}

		// ④ 写后验证（更新原子性，ADR-028 的 `judgeUpdate` 的运行时形态）：
		//    重检索旧检索词，**仍能看到未失效的旧记录** ⇒ 矛盾已存在，如实记 `old_still_visible`。
		let oldStillVisible = false;
		try {
			const result = await options.adapter.search({
				query: oldQuery,
				scope: recallScope,
				limit: 5,
			});
			const after = Array.isArray(result?.records) ? result.records : [];
			oldStillVisible = matched.some((target) => {
				const found = after.find((record) => record.id === target.id);
				return found !== undefined && isOpen(found);
			});
		} catch {
			// 验证查不了 ⇒ 我们不能声称"已失效"，但也**不谎报** old_still_visible
			return {
				decision: "added",
				content,
				sourceSeq,
				memoryId: written.id,
				invalidatedIds,
				reason: "post-write verification could not run (search failed)",
			};
		}

		return {
			decision: "added",
			content,
			sourceSeq,
			memoryId: written.id,
			invalidatedIds,
			verification: oldStillVisible ? "old_still_visible" : "ok",
			...(invalidateError === undefined ? {} : { reason: `invalidate failed: ${invalidateError}` }),
		};
	}

	return {
		async afterTurn(input, append) {
			const report = { added: 0, skipped: 0, rejected: 0, failed: 0 };
			if (input.prompt.trim() === "") return report;

			const extraction = extractMemoryCandidates(input.prompt, options);
			for (const rejected of extraction.rejected) {
				report.rejected += 1;
				await record(
					{
						decision: "rejected",
						content: rejected.text,
						sourceSeq: input.sourceSeq,
						reason: rejected.reason,
					},
					append,
				);
			}

			const promptHash = createHash("sha256").update(input.prompt, "utf8").digest("hex");
			for (const candidate of extraction.candidates) {
				const payload = await writeOne(candidate, input.sourceSeq, promptHash);
				if (payload.decision === "added") report.added += 1;
				else if (payload.decision === "skipped_duplicate") report.skipped += 1;
				else if (payload.decision === "failed") report.failed += 1;
				await record(payload, append);
			}
			return report;
		},
	};
}
