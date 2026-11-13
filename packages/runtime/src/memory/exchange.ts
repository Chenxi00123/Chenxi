/**
 * canonical 记忆交换文档的构建与解析（ADR-030，兑现主张 4 的**记忆侧**）。
 *
 * 与 `portable/exchange.ts`（会话侧）**同构**，三条纪律也一致：
 *  - **版本门禁是真实分支**：`formatVersion > 当前` → 快速失败（绝不静默降级去读自己看不懂的格式）；
 *    更早版本 → 同样拒绝（v1 是首版，**没有更早版本**，故此刻没有任何迁移路径；将来在此登记迁移）；
 *  - **只校验结构，不做语义判分**：一条记忆"好不好"是 L1/L2 判官的活（ADR-028），
 *    这里只管"它是不是一条合法记录"——避免把两件事混成一个判据；
 *  - **解析即规范化**：只保留契约里**声明**的字段（未知键剥掉）⇒ 外部记忆层带进来的私货
 *    不会渗进下游（尤其是**不得**让它们混进 `metadata` 之类的越权通道，ADR-010）。
 */
import {
	type ExchangeProducer,
	MEMORY_EXCHANGE_FORMAT,
	MEMORY_EXCHANGE_FORMAT_VERSION,
	type MemoryExchangeDocument,
	type MemoryRecord,
	type MemoryScope,
} from "@chenxi/schema";
import { z } from "zod";

/** 记忆交换文档格式错误（稳定 code 供测试与 CLI 断言）。 */
export class MemoryExchangeFormatError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "MemoryExchangeFormatError";
		this.code = code;
	}
}

export interface ParsedMemoryExchangeDocument {
	readonly formatVersion: number;
	readonly producer: ExchangeProducer;
	readonly scope: MemoryScope;
	/** 已规范化（未知键剥掉）的记录。 */
	readonly records: readonly MemoryRecord[];
}

const producerSchema = z.strictObject({
	name: z.string().min(1),
	version: z.string().min(1),
});

/** 作用域三键（ADR-010）：三个都必填，缺一个就无从重建隔离。 */
const scopeSchema = z.strictObject({
	user: z.string().min(1),
	agent: z.string().min(1),
	session: z.string().min(1),
});

const provenanceSchema = z.object({
	promptId: z.string().min(1),
	promptVersion: z.string().min(1),
	promptHash: z.string().min(1),
});

/**
 * 一条记忆的**唯一合法形状**（= `MemoryRecord` 的运行时投影）。
 *
 * 两条刻意的选择：
 *  - **非 strict（未声明键一律剥掉）**：`records` 是**外部**（记忆层 / 别家工具）来的载荷，
 *    剥掉未声明键既是"解析即规范化"，也是 ADR-010 的可测形态——外部塞进来的身份键
 *    （如 `metadata.user`）**进不了**下游；
 *  - `.optional()` 只表示"允许缺席"：**缺席与显式 `null` 是两种事实**
 *    （`validAt: null` 在 bitemporal 模型里有含义），故 `nullable` 与 `optional` **并存**且不折叠。
 */
const recordSchema = z.object({
	id: z.string().min(1),
	content: z.string().min(1),
	score: z.number().finite().optional(),
	createdAt: z.string().min(1).optional(),
	validAt: z.string().min(1).nullable().optional(),
	invalidAt: z.string().min(1).nullable().optional(),
	provenance: provenanceSchema.optional(),
});

const documentSchema = z.object({
	format: z.literal(MEMORY_EXCHANGE_FORMAT),
	formatVersion: z.number().int().nonnegative(),
	producer: producerSchema,
	scope: scopeSchema,
	records: z.array(recordSchema),
});

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
	return issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
			return `${path}: ${issue.message}`;
		})
		.join("; ");
}

/**
 * 把**外部**（记忆层 / 手写文档）给的记录装进我们的形状：不合法项**丢弃**、未声明键**剥掉**。
 *
 * 为什么这里宽容而 `parseMemoryExchangeDocument` 严格：两者的**失败语义**不同——
 *  - 装载侧面对的是一个**外部系统**（可能返回垃圾）⇒ 与 `memory/seam.ts` 的既有纪律一致
 *    （"形状不符按无记忆处理"），垃圾丢掉、**不阻塞**导出（导出面对的是一屋子可能读不动的记忆，
 *    不该因为其中一条坏了就整次失败）；
 *  - 解析侧面对的是一份**声明为我们格式**的文档，其中有坏记录 ⇒ 这份文档本身就坏了，必须快速失败。
 */
export function selectExportableRecords(records: readonly unknown[]): readonly MemoryRecord[] {
	const kept: MemoryRecord[] = [];
	for (const candidate of records) {
		const parsed = recordSchema.safeParse(candidate);
		if (parsed.success) kept.push(parsed.data);
	}
	return kept;
}

/** 由作用域 + 记录 + 产出方构建 canonical 文档。 */
export function buildMemoryExchangeDocument(params: {
	readonly scope: MemoryScope;
	readonly records: readonly MemoryRecord[];
	readonly producer: ExchangeProducer;
}): MemoryExchangeDocument {
	return {
		format: MEMORY_EXCHANGE_FORMAT,
		formatVersion: MEMORY_EXCHANGE_FORMAT_VERSION,
		producer: params.producer,
		scope: params.scope,
		records: params.records,
	};
}

/** 解析（并做版本门禁 + 记录形状校验）。`raw` 通常是 `JSON.parse` 的结果。 */
export function parseMemoryExchangeDocument(raw: unknown): ParsedMemoryExchangeDocument {
	const parsed = documentSchema.safeParse(raw);
	if (!parsed.success) {
		throw new MemoryExchangeFormatError(
			"document_invalid",
			`not a valid ${MEMORY_EXCHANGE_FORMAT} document — ${describeIssues(parsed.error.issues)}`,
		);
	}
	const version = parsed.data.formatVersion;
	if (version > MEMORY_EXCHANGE_FORMAT_VERSION) {
		throw new MemoryExchangeFormatError(
			"version_unsupported",
			`document formatVersion ${version} is newer than this client supports ` +
				`(${MEMORY_EXCHANGE_FORMAT_VERSION}); upgrade Chenxi instead of importing blindly`,
		);
	}
	if (version < MEMORY_EXCHANGE_FORMAT_VERSION) {
		throw new MemoryExchangeFormatError(
			"version_unmigratable",
			`document formatVersion ${version} predates ${MEMORY_EXCHANGE_FORMAT_VERSION} ` +
				"and no migration is registered",
		);
	}
	return {
		formatVersion: version,
		producer: parsed.data.producer,
		scope: parsed.data.scope,
		records: parsed.data.records,
	};
}

/** 解析 JSON 文本（`JSON.parse` 失败 -> 可读格式错误，而不是裸 `SyntaxError`）。 */
export function parseMemoryExchangeJson(text: string): ParsedMemoryExchangeDocument {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new MemoryExchangeFormatError("json_invalid", `document is not valid JSON: ${message}`);
	}
	return parseMemoryExchangeDocument(raw);
}

/**
 * 把一份（已解析的）文档**规范化重写**为 canonical 文档：换成本仓产出方身份 + 当前版本号。
 *
 * 用途 = 主张 4 里的「**前向/后向迁移**」的落点：将来新增版本时，迁移逻辑就加在这里；
 * 今天它的可观测效果是"**剥掉未知键、把文档重写成我们自己的写法**"（规范化），
 * 并让"这份文档是谁写的 / 什么版本"变成**我们**的（接收方可审计）。
 */
export function normalizeMemoryExchangeDocument(
	parsed: ParsedMemoryExchangeDocument,
	producer: ExchangeProducer,
): MemoryExchangeDocument {
	return buildMemoryExchangeDocument({
		scope: parsed.scope,
		records: parsed.records,
		producer,
	});
}
