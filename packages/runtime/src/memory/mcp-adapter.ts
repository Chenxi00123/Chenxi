/**
 * MCP 外挂记忆适配器（ADR-010 / ADR-016 / ADR-030）。
 *
 * **我们对记忆服务器提出的契约**（不是它给我们的）：
 *  - 检索工具接收 `{ query, limit, user, agent, session }`；
 *  - 返回的 `content[0].text` 是 **JSON**：`{ records: [{ id, content, score? }] }` **或裸数组**；
 *  - **可选字段**（ADR-030 起）：服务端若额外给出 `createdAt` / `validAt` / `invalidAt` / `provenance`，
 *    我们**原样携带**——它们是 bitemporal 与溯源事实（主张 1/3），
 *    记忆交换格式（`chenxi-memory-exchange`）要靠它们才是**无损**的；
 *    服务端**没给**就不带（绝不臆造时间），形状不符的字段**丢掉这一个字段**（不连累整条记录）。
 *
 * 宽容与失败语义（ADR-016 / ADR-033 / ADR-034）：
 *  - 解析失败 / 形状不符 / 无 `content` 的项 -> **丢弃**（返回空结果，即"无记忆"）；
 *  - `id` 缺失时用 `record-<序号>` 兜底（仅供审计把注入与记录对齐，不构成稳定标识）；
 *  - `add`：配置了 `addTool` 才可写（ADR-033）；服务端没给出可用记录时**如实失败**
 *    （写没写成我们不知道，绝不编一个 id 假装成功）；
 *  - `invalidate`：配置了 `invalidateTool` 时才有这个方法（ADR-034）；缺省 ≠ 静默无操作。
 */
import type {
	MemoryAdapter,
	MemoryAddRequest,
	MemoryInvalidateRequest,
	MemoryProvenance,
	MemoryRecord,
	MemoryScope,
	MemorySearchRequest,
	MemorySearchResult,
} from "@chenxi/schema";

/** 调用一个 MCP 工具（通常来自 `BridgedMcpServer.callTool`）。 */
export type McpToolCaller = (name: string, args: unknown) => Promise<unknown>;

export interface McpMemoryAdapterOptions {
	readonly callTool: McpToolCaller;
	/** 服务端侧的检索工具名。 */
	readonly searchTool: string;
	/** 服务端侧的**写入**工具名（ADR-033）；缺省 ⇒ `add` 显式拒绝（与旧行为一致）。 */
	readonly addTool?: string;
	/** 服务端侧的**失效**工具名（ADR-034）；缺省 ⇒ 适配器**不含** `invalidate`。 */
	readonly invalidateTool?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** 从 `CallToolResult` 信封里取第一段文本。 */
function extractText(result: unknown): string | undefined {
	const envelope = asRecord(result);
	if (!Array.isArray(envelope?.content)) return undefined;
	for (const item of envelope.content) {
		const text = asRecord(item)?.text;
		if (typeof text === "string") return text;
	}
	return undefined;
}

/** 服务端把失败写成 `isError: true` 时按失败处理（不把错误文本当数据解析）。 */
function assertNotErrorResult(result: unknown, tool: string): void {
	const envelope = asRecord(result);
	if (envelope?.isError === true) {
		const text = extractText(result) ?? "unknown error";
		throw new Error(`memory tool "${tool}" failed: ${text}`);
	}
}

/** 解析**单条**写入结果（`{record}` / `{records:[…]}` / 裸数组 / 裸记录）。 */
function parseSingleRecord(
	text: string | undefined,
	requestContent: string,
): MemoryRecord | undefined {
	if (text === undefined || text.trim() === "") return undefined;
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	const records = parseRecords(JSON.stringify(json));
	if (records.length > 0) return records[0];
	// 裸记录：`{ id, content }`（没有包一层）
	const bare = asRecord(json);
	if (bare !== undefined && typeof bare.content === "string" && bare.content.trim() !== "") {
		const id = typeof bare.id === "string" && bare.id !== "" ? bare.id : undefined;
		return id === undefined
			? { id: "unverified", content: requestContent }
			: { id, content: bare.content };
	}
	return undefined;
}

/** 宽容解析 records（`{records:[…]}` 或裸数组）。 */
function parseRecords(text: string | undefined): readonly MemoryRecord[] {
	if (text === undefined) return [];
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return [];
	}
	const container = asRecord(json);
	const raw: unknown = Array.isArray(json) ? json : container?.records;
	if (!Array.isArray(raw)) return [];

	const records: MemoryRecord[] = [];
	for (const item of raw) {
		const record = asRecord(item);
		if (record === undefined) continue;
		if (typeof record.content !== "string" || record.content.trim() === "") continue;
		const id =
			typeof record.id === "string" && record.id !== "" ? record.id : `record-${records.length}`;
		records.push({ id, content: record.content, ...readOptionalFields(record) });
	}
	return records;
}

/** ISO 时间戳（缺 / 形状不符 -> `undefined`，绝不臆造时间）。 */
function readStamp(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 可空时间戳：`null` 是**有意义的事实**（如 `invalidAt: null` = "仍未失效"），必须与"缺席"区分开。 */
function readNullableStamp(value: unknown): string | null | undefined {
	if (value === null) return null;
	return readStamp(value);
}

/** 溯源：三段 hash 元数据**必须齐**才采纳（缺一段就等于没有溯源，不拼半截）。 */
function readProvenance(value: unknown): MemoryProvenance | undefined {
	const record = asRecord(value);
	if (record === undefined) return undefined;
	const promptId = readStamp(record.promptId);
	const promptVersion = readStamp(record.promptVersion);
	const promptHash = readStamp(record.promptHash);
	if (promptId === undefined || promptVersion === undefined || promptHash === undefined) {
		return undefined;
	}
	return { promptId, promptVersion, promptHash };
}

/**
 * 服务端**额外给出**的可选字段（ADR-030）：原样携带，但只带**合法的**那一个。
 * 形状不符的字段只丢自己，**不连累整条记录**（一条记忆的内容比它的时间戳重要得多）。
 */
function readOptionalFields(record: Record<string, unknown>): Partial<MemoryRecord> {
	const createdAt = readStamp(record.createdAt);
	const validAt = readNullableStamp(record.validAt);
	const invalidAt = readNullableStamp(record.invalidAt);
	const provenance = readProvenance(record.provenance);
	const score =
		typeof record.score === "number" && Number.isFinite(record.score) ? record.score : undefined;
	return {
		...(createdAt === undefined ? {} : { createdAt }),
		...(validAt === undefined ? {} : { validAt }),
		...(invalidAt === undefined ? {} : { invalidAt }),
		...(provenance === undefined ? {} : { provenance }),
		...(score === undefined ? {} : { score }),
	};
}

function scopeArgs(scope: MemoryScope): Record<string, string> {
	return { user: scope.user, agent: scope.agent, session: scope.session };
}

export function createMcpMemoryAdapter(options: McpMemoryAdapterOptions): MemoryAdapter {
	return {
		async search(req: MemorySearchRequest): Promise<MemorySearchResult> {
			const result = await options.callTool(options.searchTool, {
				query: req.query,
				...(req.limit === undefined ? {} : { limit: req.limit }),
				...scopeArgs(req.scope),
			});
			return { records: parseRecords(extractText(result)) };
		},

		async getSessionMemories(scope: MemoryScope): Promise<MemorySearchResult> {
			// 契约延伸：空 query = 「本会话已有记忆」（沿用同一个检索工具）
			const result = await options.callTool(options.searchTool, {
				query: "",
				...scopeArgs(scope),
			});
			return { records: parseRecords(extractText(result)) };
		},

		add(req: MemoryAddRequest): Promise<MemoryRecord> {
			const tool = options.addTool;
			if (tool === undefined) {
				// 显式拒绝而非静默无操作：没配写入工具就是不支持写入（ADR-016 / ADR-033）
				return Promise.reject(
					new Error(
						"memory write is not configured in this build (no memory.write.addTool; see ADR-033)",
					),
				);
			}
			return (async () => {
				const result = await options.callTool(tool, {
					content: req.content,
					...scopeArgs(req.scope),
					...(req.provenance === undefined ? {} : { provenance: req.provenance }),
					...(req.metadata === undefined ? {} : { metadata: req.metadata }),
				});
				assertNotErrorResult(result, tool);
				const record = parseSingleRecord(extractText(result), req.content);
				if (record === undefined) {
					// 写没写成我们**不知道** ⇒ 如实失败（绝不编一个 id 假装成功）
					throw new Error(`memory tool "${tool}" returned no usable record`);
				}
				return record;
			})();
		},

		...(options.invalidateTool === undefined
			? {}
			: {
					async invalidate(req: MemoryInvalidateRequest): Promise<void> {
						const tool = options.invalidateTool as string;
						const result = await options.callTool(tool, {
							id: req.id,
							...scopeArgs(req.scope),
							...(req.invalidAt === undefined ? {} : { invalidAt: req.invalidAt }),
						});
						assertNotErrorResult(result, tool);
					},
				}),
	};
}
