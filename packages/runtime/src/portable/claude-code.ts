/**
 * Claude Code 原生会话 JSONL 适配器（ADR-019，**best-effort、有损**）。
 *
 * 形状来源 = 公开源码快照（`07-证据索引` §5 记录的 zcode 公开仓库）：
 *  - `packages/services/src/session/claude-native/claudeNativeSessionImportParser.ts`
 *  - `.../jsonLineRecord.ts`
 * 每行一条记录：`{ type: "user"|"assistant"|"system"|…, message: { role?, content:
 * string | Array<{type:"text"|"tool_result"|…, text?, content?}>, model?, isMeta?,
 * isApiErrorMessage? }, cwd, timestamp, isSidechain }`。
 *
 * 导入规则与 zcode 的同源（只取**用户真正看得见**的文本）：
 *  - `user`：丢 `tool_result` / `local-command` / `ide_opened_file` 这类协议噪音与 IDE 注入；
 *    `isMeta` 记录丢弃；
 *  - `assistant`：只取 `content[].type === "text"`；`model === "<synthetic>"` 的 SDK 占位丢弃；
 *    连续多条 assistant 记录**聚合成一轮**（Claude 一轮回答可能被拆成多条）；
 *  - `system` / `isSidechain` 记录不导入。
 *
 * **明确有损**（ADR-019）：工具轨迹、审批、模式切换、turn 边界等**都没有对应物**，不导出也不重建。
 * **未经真机对测**：本机没有 Claude Code，因此导出只写"证据里确实被读取的字段"
 * （`type` / `message` / `cwd` / `timestamp`），**不臆造** `uuid` / `parentUuid` 之类未经证据确认的字段。
 */
import { epochMsToIso, type PortableTurn } from "./turns.js";

export interface ClaudeCodeImport {
	/** 第一条可见消息所属的 cwd（与 zcode 的判定口径一致）。 */
	readonly cwd?: string;
	/** 第一条可见 assistant 回复的模型（跳过 `<synthetic>` 占位）。 */
	readonly model?: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
	readonly turns: readonly PortableTurn[];
}

const IDE_OPENED_FILE_TAG_RE = /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi;
const COMMAND_TAG_BLOCK_RE =
	/<(?:local-command|command)-[^>]+>[\s\S]*?<\/(?:local-command|command)-[^>]+>/gi;

/** 去掉 IDE / 本地命令噪音，并统一换行（zcode 同款清洗）。 */
function sanitizeVisibleText(text: string): string {
	return text
		.replace(IDE_OPENED_FILE_TAG_RE, " ")
		.replace(COMMAND_TAG_BLOCK_RE, " ")
		.replace(/\r\n/g, "\n")
		.trim();
}

/** 去掉 SDK 合成占位（Claude Code 会写 `model: "<synthetic>"` 的 "No response requested."）。 */
function stripSyntheticPlaceholder(text: string): string {
	return text
		.trimEnd()
		.replace(/(?:\n+\s*)?No response requested\.$/u, "")
		.trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** 时间：数字（秒或毫秒）或 ISO 字符串 -> ISO。 */
function readTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value > 1_000_000_000_000 ? value : value > 1_000_000_000 ? value * 1000 : undefined;
		return ms === undefined ? undefined : epochMsToIso(Math.trunc(ms));
	}
	if (typeof value !== "string") return undefined;
	const numeric = Number(value);
	if (value.trim() !== "" && Number.isFinite(numeric)) return readTimestamp(numeric);
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? epochMsToIso(parsed) : undefined;
}

function readEntryTimestamp(entry: Record<string, unknown>): string | undefined {
	const message = isRecord(entry.message) ? entry.message : undefined;
	const request = isRecord(entry.request) ? entry.request : undefined;
	for (const candidate of [
		entry.timestamp,
		entry.createdAt,
		message?.timestamp,
		request?.timestamp,
	]) {
		const timestamp = readTimestamp(candidate);
		if (timestamp !== undefined) return timestamp;
	}
	return undefined;
}

function itemText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	return readString(value.text) ?? readString(value.content) ?? "";
}

function entryTextParts(value: unknown, opts: { skipToolResult: boolean }): string[] {
	if (typeof value === "string") {
		const text = sanitizeVisibleText(value);
		return text === "" ? [] : [text];
	}
	if (!Array.isArray(value)) return [];
	const parts: string[] = [];
	for (const item of value) {
		if (opts.skipToolResult && isRecord(item) && item.type === "tool_result") continue;
		const text = sanitizeVisibleText(itemText(item));
		if (text !== "") parts.push(text);
	}
	return parts;
}

function isSyntheticPlaceholder(entry: Record<string, unknown>): boolean {
	const message = isRecord(entry.message) ? entry.message : undefined;
	return (
		(readString(entry.model) ?? readString(message?.model)) === "<synthetic>" &&
		entry.isApiErrorMessage !== true &&
		message?.isApiErrorMessage !== true
	);
}

function isSidechain(entry: Record<string, unknown>): boolean {
	const message = isRecord(entry.message) ? entry.message : undefined;
	return entry.isSidechain === true || message?.isSidechain === true;
}

/** 用户**真正可见**的问题文本（`undefined` = 这条记录不是一条可见用户消息）。 */
function visibleUserText(entry: Record<string, unknown>): string | undefined {
	if (entry.type !== "user") return undefined;
	const message = isRecord(entry.message) ? entry.message : undefined;
	if (entry.isMeta === true || message?.isMeta === true) return undefined;
	const content = message?.content ?? (isRecord(entry.request) ? entry.request.prompt : undefined);
	const parts = entryTextParts(content, { skipToolResult: true });
	// 用户内容按段落拼接（zcode 同款）
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** 可见 assistant 文本（`undefined` = 无可展示文本）。 */
function visibleAssistantText(entry: Record<string, unknown>): string | undefined {
	if (entry.type !== "assistant") return undefined;
	if (isSyntheticPlaceholder(entry)) return undefined;
	const message = isRecord(entry.message) ? entry.message : undefined;
	const content = message?.content;
	const parts =
		typeof content === "string"
			? entryTextParts(content, { skipToolResult: false })
			: Array.isArray(content)
				? content
						.filter((item) => isRecord(item) && item.type === "text")
						.flatMap((item) => entryTextParts([item], { skipToolResult: false }))
				: [];
	const text = stripSyntheticPlaceholder(parts.join(""));
	return text === "" ? undefined : text;
}

/** 解析 Claude Code 原生 JSONL 文本。 */
export function importClaudeCodeJsonl(text: string): ClaudeCodeImport {
	const turns: PortableTurn[] = [];
	let pendingAssistant = "";
	let pendingAssistantAt: string | undefined;
	let cwd: string | undefined;
	let model: string | undefined;
	let createdAt: string | undefined;
	let updatedAt: string | undefined;
	let sawUserTurn = false;

	const flushAssistant = (): void => {
		if (pendingAssistant === "" || !sawUserTurn) return;
		turns.push({
			role: "assistant",
			content: pendingAssistant,
			...(pendingAssistantAt === undefined ? {} : { at: pendingAssistantAt }),
		});
		pendingAssistant = "";
		pendingAssistantAt = undefined;
	};

	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line.trim() === "") continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`claude-code jsonl line ${index + 1} is not valid JSON: ${message}`);
		}
		if (!isRecord(entry)) continue;
		if (isSidechain(entry)) continue;

		const at = readEntryTimestamp(entry);
		const entryCwd = readString(entry.cwd);

		const userText = visibleUserText(entry);
		if (userText !== undefined) {
			flushAssistant();
			sawUserTurn = true;
			cwd ??= entryCwd;
			createdAt ??= at;
			updatedAt = at ?? updatedAt;
			turns.push({ role: "user", content: userText, ...(at === undefined ? {} : { at }) });
			continue;
		}

		const assistantText = visibleAssistantText(entry);
		if (assistantText === undefined || !sawUserTurn) continue;
		cwd ??= entryCwd;
		// provider 只认可见回复的模型（`<synthetic>` 已在上面被过滤）
		if (model === undefined) {
			const message = isRecord(entry.message) ? entry.message : undefined;
			model = readString(entry.model) ?? readString(message?.model);
		}
		pendingAssistant += assistantText;
		pendingAssistantAt = at ?? pendingAssistantAt;
		updatedAt = pendingAssistantAt ?? updatedAt;
	}
	flushAssistant();

	if (turns.length === 0) {
		throw new Error("claude-code jsonl contains no importable visible message (nothing to import)");
	}

	return {
		...(cwd === undefined ? {} : { cwd }),
		...(model === undefined ? {} : { model }),
		...(createdAt === undefined ? {} : { createdAt }),
		...(updatedAt === undefined ? {} : { updatedAt }),
		turns,
	};
}

/**
 * 产出 Claude Code 可读的**最小** JSONL（只写证据里确实被读取的字段）。
 * **不写** `uuid` / `parentUuid` / 工具轨迹等：前者无证据、后者我们无对应事实。
 */
export function exportClaudeCodeJsonl(params: {
	readonly cwd: string;
	readonly turns: readonly PortableTurn[];
}): string {
	const lines = params.turns.map((turn) =>
		JSON.stringify({
			type: turn.role,
			message: { role: turn.role, content: turn.content },
			cwd: params.cwd,
			...(turn.at === undefined ? {} : { timestamp: turn.at }),
		}),
	);
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
