/**
 * 记忆交换的**读侧**（ADR-030）。
 *
 * 与 `portable/session.ts`（会话侧）的关键差别，必须写在最前面：
 *  - 会话是**我们自己**的事实源 ⇒ 会话侧有完整的读 + 写（导入走 `persist` 的单一写入路径）；
 *  - 记忆层按 ADR-010/016 是**外挂**（MCP），且 `MemoryAdapter.add` 被**显式拒绝**（ADR-016 推迟写入）
 *    ⇒ **本文件只有读侧（导出），没有写侧**——这不是"漏了一半"，而是**结构性的围栏**：
 *    谁都不许在这里顺手打开记忆层的写入路径。
 *
 * 读侧纪律（与注入缝同源，但在**失败语义**上刻意不同）：
 *  - 导出是**用户显式发起**的动作 ⇒ 适配器报错**如实抛出**（不像 `before_turn` 那样 fail-open，
 *    否则用户会拿到一个"看起来成功、其实空"的文档）；
 *  - 但外部服务器返回的**形状垃圾**按宽容处理：交由 `selectExportableRecords` **丢弃并报数**
 *    （导出永远产出**合法**文档）。
 */
import type { ExchangeProducer, MemoryAdapter, MemoryRecord, MemoryScope } from "@aster/schema";
import { selectExportableRecords } from "./exchange.js";

export interface ExportedMemory {
	readonly scope: MemoryScope;
	readonly producer: ExchangeProducer;
	/** 已规范化的记录（未声明键剥掉、不合法项丢弃）。 */
	readonly records: readonly MemoryRecord[];
}

/**
 * 从记忆层读出**该作用域下已有的记忆**（`getSessionMemories`，不是按 query 检索——
 * 导出要的是"库里有什么"，而不是"跟某句话像什么"）。
 */
export async function readMemoryLayerForExport(params: {
	readonly adapter: MemoryAdapter;
	readonly scope: MemoryScope;
	readonly producer: ExchangeProducer;
}): Promise<ExportedMemory> {
	const result = await params.adapter.getSessionMemories(params.scope);
	const raw = Array.isArray(result?.records) ? result.records : [];
	return {
		scope: params.scope,
		producer: params.producer,
		records: selectExportableRecords(raw),
	};
}
