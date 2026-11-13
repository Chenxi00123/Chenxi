/**
 * ZCode 会话文件适配器（ADR-019，**best-effort、有损**）。
 *
 * 形状来源 = 公开源码快照（`07-证据索引` §5 记录的 zcode 公开仓库）：
 *  - `packages/shared/src/validation.ts:1746` `zcodeSessionFileSchema = { meta, messages,
 *    fileChanges?, turnCheckpoints? }`（**没有任何版本字段**——这正是主张 4 要补的缺口）；
 *  - `packages/shared/src/zcode-task-types-core.ts:1090` `ZCodePersistedMessage = { id?, role:
 *    "user" | "assistant", content: string, timestamp: number, model?, … }`；
 *  - `packages/shared/src/zcode-task-mode-schema.ts:6` 的 `mode` 取值域里**含 `plan` / `build`**。
 *
 * 纪律：
 *  - **导入端宽容**：我们**不拥有**对方的 schema，因此只按"我们要读的字段"校验，
 *    缺字段按缺省处理（不因为对方多写了 `fileChanges` 就拒收）；
 *  - **导出端不造数**：不写 `fileChanges` / `turnCheckpoints`（我们无对应事实），
 *    也**不加版本字段**（那会破坏它的 schema 校验）；版本化只发生在**我们自己的**交换文档里。
 */
import type { AgentMode } from "@chenxi/schema";
import { z } from "zod";
import { epochMsToIso, isoToEpochMs, type PortableTurn } from "./turns.js";

export interface ZCodeImport {
	readonly cwd?: string;
	/** 仅当对方的 mode 恰好落在我们的取值域（`plan` / `build`）时才取用。 */
	readonly mode?: AgentMode;
	readonly model?: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
	readonly title?: string;
	readonly turns: readonly PortableTurn[];
}

const messageSchema = z.object({
	role: z.enum(["user", "assistant"]),
	content: z.string(),
	timestamp: z.number(),
	model: z.string().optional(),
});

const metaSchema = z.object({
	workspacePath: z.string().optional(),
	title: z.string().optional(),
	createdAt: z.number().optional(),
	updatedAt: z.number().optional(),
	model: z.string().optional(),
	mode: z.string().optional(),
});

const sessionFileSchema = z.object({
	meta: metaSchema.optional(),
	messages: z.array(messageSchema),
});

/** zcode 的 `mode` 取值域很大（`default`/`yolo`/`guarded`/…）；只有 `plan` / `build` 与我们对得上。 */
function toAgentMode(value: string | undefined): AgentMode | undefined {
	return value === "plan" || value === "build" ? value : undefined;
}

/** 解析 ZCode 会话文件文本。 */
export function importZCodeSession(text: string): ZCodeImport {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`zcode session file is not valid JSON: ${message}`);
	}
	const parsed = sessionFileSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`zcode session file does not match the shape we can read — ${issues}`);
	}
	const messages = parsed.data.messages;
	if (messages.length === 0) {
		throw new Error("zcode session file contains no messages (nothing to import)");
	}

	const turns: PortableTurn[] = messages.map((message) => ({
		role: message.role,
		content: message.content,
		at: epochMsToIso(Math.trunc(message.timestamp)),
	}));
	const meta = parsed.data.meta;
	const mode = toAgentMode(meta?.mode);
	const createdAt =
		meta?.createdAt === undefined ? undefined : epochMsToIso(Math.trunc(meta.createdAt));
	const updatedAt =
		meta?.updatedAt === undefined ? undefined : epochMsToIso(Math.trunc(meta.updatedAt));
	const model = meta?.model;
	const cwd = meta?.workspacePath;
	const title = meta?.title;

	return {
		...(cwd === undefined || cwd === "" ? {} : { cwd }),
		...(mode === undefined ? {} : { mode }),
		...(model === undefined || model === "" ? {} : { model }),
		...(createdAt === undefined ? {} : { createdAt }),
		...(updatedAt === undefined ? {} : { updatedAt }),
		...(title === undefined || title === "" ? {} : { title }),
		turns,
	};
}

/** 由第一条用户消息派生标题（单行、截断）；没有用户消息则用中性兜底。 */
function deriveTitle(turns: readonly PortableTurn[]): string {
	const first = turns.find((turn) => turn.role === "user" && turn.content.trim() !== "");
	if (first === undefined) return "Chenxi session";
	const single = first.content.replace(/\s+/g, " ").trim();
	return single.length > 60 ? `${single.slice(0, 59)}…` : single;
}

/**
 * 产出 ZCode 会话文件（`{ meta, messages }`）。
 * `traceId` 是我们自己生成的关联 id（对方的 schema 只要求非空字符串，算法未公开），
 * 因此**不是** zcode 的 `generateTraceId` 产物——这一点已写进 ADR/README。
 */
export function exportZCodeSession(params: {
	readonly sessionId: string;
	readonly cwd: string;
	readonly mode: AgentMode;
	readonly model?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly turns: readonly PortableTurn[];
}): string {
	const taskId = `chenxi-${params.sessionId}`;
	const firstTurnMs = isoToEpochMs(params.turns.find((turn) => turn.at !== undefined)?.at);
	const createdAt = isoToEpochMs(params.createdAt) ?? firstTurnMs ?? Date.now();
	const updatedAt = isoToEpochMs(params.updatedAt) ?? createdAt;
	const document = {
		meta: {
			taskId,
			traceId: `${taskId}-trace`,
			title: deriveTitle(params.turns),
			workspacePath: params.cwd,
			createdAt,
			updatedAt: Math.max(createdAt, updatedAt),
			// `plan` / `build` 都在对方的 mode 取值域内（证据：zcode-task-mode-schema.ts:6）
			mode: params.mode,
			...(params.model === undefined ? {} : { model: params.model }),
		},
		messages: params.turns.map((turn) => ({
			role: turn.role,
			content: turn.content,
			timestamp: isoToEpochMs(turn.at) ?? createdAt,
			...(params.model === undefined ? {} : { model: params.model }),
		})),
	};
	return `${JSON.stringify(document, null, 2)}\n`;
}
