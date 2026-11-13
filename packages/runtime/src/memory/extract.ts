/**
 * 规则版记忆抽取器（ADR-033）——**纯函数 / 离线 / 无 LLM**。
 *
 * 能力边界（必须与文档口径一致，不许美化）：
 *  - **只从用户原话里抽"显式标记"后面的一句**（`记住…` / `以后都…` / `remember that…`）；
 *  - **不摘要 / 不归纳 / 不推断 / 不做代词消解**——"用户说了三次 vim"不会被抽出来；
 *  - 去重只认**归一化后完全相等**（复用 L1 判官的归一化），不做近义或语义去重；
 *  - 命中密钥样式 / 提示注入样式的候选**一律拒绝**（确定性闸门，宁可漏记）。
 *
 * 为什么只从**用户消息**抽（调用方保证）：从模型输出自抽取会形成
 * 「模型幻觉 → 写入 → 下轮注入 → 自我强化」的污染链；用户显式陈述才是可采信的事实源。
 */
import { normalizeMemoryText } from "./quality.js";

/** 一个可写入的候选。 */
export interface MemoryCandidate {
	/** 要写入的新事实（已去掉标记与首尾分隔符）。 */
	readonly text: string;
	/**
	 * M17b：需要被**失效**的旧事实检索词（仅当用户把"旧的是什么"也说出来时才有）。
	 * 例：`不要再 vim，改成 neovim` ⇒ text=`neovim`、supersedesQuery=`vim`。
	 */
	readonly supersedesQuery?: string;
}

export interface RejectedCandidate {
	readonly text: string;
	reason: "too_short" | "too_long" | "secret_like" | "injection_like" | "over_limit";
}

export interface ExtractionResult {
	readonly candidates: readonly MemoryCandidate[];
	readonly rejected: readonly RejectedCandidate[];
}

export interface ExtractionOptions {
	readonly maxCandidates?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
}

export const DEFAULT_MAX_CANDIDATES = 3;
/**
 * 最短长度取 **4**（不是 8）：真实偏好常常很短（"用 vim" / "别用 tabs"），
 * 8 会把它们全判成 `too_short`；长度闸门的真正职责是挡"空壳"，不是挡短句。
 */
export const DEFAULT_MIN_LENGTH = 4;
export const DEFAULT_MAX_LENGTH = 200;

/** 事实标记（中文 + 英文）——**只认这些显式说法**，不猜语气。 */
const FACT_MARKERS: readonly string[] = [
	"请记住",
	"帮我记住",
	"记住",
	"记一下",
	"以后都",
	"从现在起",
	"今后",
	"我的偏好是",
	"我偏好",
	"remember that",
	"remember:",
	"from now on",
	"always use",
	"my preference is",
];

/** 句末（中文逗号**不算**句末：`不要再 vim，改成 neovim` 是一句话）。 */
const SENTENCE_END_RE = /[。！？!?.;\n]/;

/** 首尾要剥掉的分隔符（保留句末标点本身，不做二次改写）。 */
const LEADING_SEPARATORS_RE = /^[\s:：,，;；、\-—"'“”‘’]+/;
const TRAILING_SEPARATORS_RE = /[\s,，;；"'“”‘’]+$/;

/**
 * 显式"取代"句式（M17b）：**必须把旧的事实也说清楚**才可能失效它。
 * 认三种：`不要再 X，改成 Y` / `以后用 Y 代替 X` / `never use X, use Y`。
 */
interface SupersedePattern {
	readonly re: RegExp;
	/** 用哪一组当新事实、哪一组当旧检索词。 */
	readonly newGroup: number;
	readonly oldGroup: number | undefined;
}

const SUPERSEDE_PATTERNS: readonly SupersedePattern[] = [
	{ re: /不要再?\s*(.+?)\s*[，,；;]\s*(?:改成|换成|改为|换为)\s*(.+)/, newGroup: 2, oldGroup: 1 },
	{
		re: /以后?\s*(?:不要|别用|不用)\s*(.+?)\s*[，,；;]\s*(?:改成|换成|改为|换为)\s*(.+)/,
		newGroup: 2,
		oldGroup: 1,
	},
	{ re: /以后用\s*(.+?)\s*代替\s*(.+)/, newGroup: 1, oldGroup: 2 },
	{ re: /never\s+use\s+(.+?)[,;]\s*(?:use|switch to|go with)\s+(.+)/i, newGroup: 2, oldGroup: 1 },
	{ re: /use\s+(.+?)\s+instead\s+of\s+(.+)/i, newGroup: 1, oldGroup: 2 },
];

/** 密钥样式（确定性拒绝：**绝不把凭据写进记忆层**）。 */
const SECRET_PATTERNS: readonly RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	// 清洗会把开头的 `-----` 剥掉 ⇒ 再认一遍"没有前导横线"的形态（否则 PEM 头会漏网）
	/\bBEGIN [A-Z ]*PRIVATE KEY-----/,
	/\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*\S{8,}/i,
	/\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

/** 提示注入样式（记忆是**数据**，但这些句子连"像数据"都不像，直接不记）。 */
const INJECTION_PATTERNS: readonly RegExp[] = [
	/忽略.{0,8}(?:指令|提示|规则)/,
	/ignore\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|prompts)/i,
	/system\s*prompt/i,
	/你现在是/,
];

/** 正则转义（标记里有 `:` 等字符，不能直接拼进 RegExp）。 */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 两个候选之间判重用的归一化（**与 L1 判官同一实现**，避免两处口径漂移）：见 `normalizeMemoryText`。 */

/** 从 `start` 起截到句末（不含句末标点）。 */
function untilSentenceEnd(prompt: string, start: number): string {
	const rest = prompt.slice(start);
	const match = SENTENCE_END_RE.exec(rest);
	return match === null ? rest : rest.slice(0, match.index);
}

/** 清洗一段候选正文：去首尾分隔符、折叠内部空白。 */
function clean(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(LEADING_SEPARATORS_RE, "")
		.replace(TRAILING_SEPARATORS_RE, "")
		.trim();
}

function matchesSecret(text: string): boolean {
	return SECRET_PATTERNS.some((re) => re.test(text));
}

function matchesInjection(text: string): boolean {
	return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** 重叠判定（防止同一句既被 supersede 句式抓走、又被普通标记再抽一遍）。 */
function overlaps(spans: readonly [number, number][], start: number, end: number): boolean {
	return spans.some(([from, to]) => start < to && end > from);
}

/**
 * 从**本轮用户原话**抽取候选。
 * @param prompt 用户这轮说的话（调用方只传 `user/message` 的 content）
 */
export function extractMemoryCandidates(
	prompt: string,
	options: ExtractionOptions = {},
): ExtractionResult {
	const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
	const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
	const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

	const raw: MemoryCandidate[] = [];
	const spans: [number, number][] = [];
	const rejected: RejectedCandidate[] = [];

	// ① 先抽"取代"句式（它包含旧事实检索词，普通标记不该再抓同一段）
	for (const pattern of SUPERSEDE_PATTERNS) {
		const match = pattern.re.exec(prompt);
		if (match === null) continue;
		const fresh = clean(match[pattern.newGroup] ?? "");
		if (fresh === "") continue;
		const old = pattern.oldGroup === undefined ? "" : clean(match[pattern.oldGroup] ?? "");
		raw.push({ text: fresh, ...(old === "" ? {} : { supersedesQuery: old }) });
		const at = match.index;
		spans.push([at, at + match[0].length]);
		break; // 一轮只认第一条取代句式（多句会互相覆盖，宁可不猜）
	}

	// ② 再抽普通"记住"标记（跳过已归属取代句式的区段）
	for (const marker of FACT_MARKERS) {
		// 大小写不敏感：`Remember that …` 与 `remember that …` 必须同权（中英混排时尤其重要）
		const markerRe = new RegExp(escapeRegExp(marker), "gi");
		for (const match of prompt.matchAll(markerRe)) {
			const at = match.index ?? 0;
			const start = at + match[0].length;
			const text = clean(untilSentenceEnd(prompt, start));
			const end = start + text.length;
			if (text !== "" && !overlaps(spans, at, Math.max(end, start + 1))) {
				raw.push({ text });
				spans.push([at, end]);
			}
		}
	}

	// ③ 闸门 + 轮内去重 + 每轮上限
	const seen = new Set<string>();
	const candidates: MemoryCandidate[] = [];
	for (const candidate of raw) {
		const text = candidate.text;
		const normalized = normalizeMemoryText(text);
		if (text.length < minLength) {
			rejected.push({ text: text.slice(0, maxLength), reason: "too_short" });
			continue;
		}
		if (text.length > maxLength) {
			rejected.push({ text: text.slice(0, maxLength), reason: "too_long" });
			continue;
		}
		if (matchesSecret(text)) {
			rejected.push({ text: text.slice(0, maxLength), reason: "secret_like" });
			continue;
		}
		if (matchesInjection(text)) {
			rejected.push({ text: text.slice(0, maxLength), reason: "injection_like" });
			continue;
		}
		if (seen.has(normalized)) continue; // 轮内重复：静默跳过（同一句话不需要两条审计）
		seen.add(normalized);
		if (candidates.length >= maxCandidates) {
			rejected.push({ text: text.slice(0, maxLength), reason: "over_limit" });
			continue;
		}
		candidates.push(candidate);
	}

	return { candidates, rejected };
}
