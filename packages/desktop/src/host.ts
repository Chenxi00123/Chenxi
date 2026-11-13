/**
 * 桌面会话宿主（ADR-029）——**纯 Node，不依赖 Electron**：因此它能被 `vitest` 直接测，
 * 而 Electron 那一层（窗口 / IPC）保持**薄**。
 *
 * M13a（本批）只做**只读**：列会话 + 读一条会话的**已记录事件**（回放），把事件交给 renderer 渲染。
 * 纪律：
 *  - **GUI 不复制终端行模型**：渲染器拿的是**结构化事件**（JSON），不是 `describeEvent` 的行；
 *    终端那套"一行 = 一个屏幕行"的呈现属 TUI（ADR-020/023/026），GUI 用 DOM 卡片表达同一份事实；
 *  - **只读 ⇒ 不产生任何写入**：本批只有 `store.list()` 与 `store.resume(id)`（读），
 *    `resume` 只读 JSONL 与索引，**绝不 append**（写入路径仍唯一属于 CLI/server，ADR-021/022）。
 */
import { closeSync, openSync, readSync } from "node:fs";
import {
	createSessionStore,
	payloadLines,
	type SessionStore,
	sessionFilePath,
} from "@chenxi/runtime";
import type { SessionEvent, SessionId } from "@chenxi/schema";
import { loadTitles, type TitleMap } from "./session-titles.js";

/** 会话列表项（只取 GUI 需要的字段，不从别的表"顺手"多读）。 */
export interface SessionSummary {
	readonly sessionId: string;
	readonly updatedAt: string;
	/** M22：桌面标题（来自 `session-titles.json`，**不是**会话事实；缺省则界面显示 sessionId）。 */
	readonly title?: string;
	/** M22：第一条用户消息的摘要（搜索用；由 JSONL 前 64KB 现读，不落任何缓存）。 */
	readonly preview?: string;
}

/** 预览读取上限：只看文件头部（第一条 user/message 一定在最前面附近）。 */
const PREVIEW_BYTES = 64 * 1024;
const PREVIEW_CHARS = 100;

/**
 * 读一条会话的"第一条用户消息"作预览（M22 搜索用）。
 *
 * 只读文件前 64KB、**不解析整份日志**、**不写任何东西**：会话很长时也不会拖慢列表。
 * 截断导致的坏行直接跳过（末行可能被切断），找不到就返回 undefined。
 */
function readPreview(home: string, sessionId: SessionId): string | undefined {
	try {
		const fd = openSync(sessionFilePath(home, sessionId), "r");
		try {
			const buffer = Buffer.allocUnsafe(PREVIEW_BYTES);
			const read = readSync(fd, buffer, 0, PREVIEW_BYTES, 0);
			const text = buffer.subarray(0, read).toString("utf8");
			for (const line of text.split("\n")) {
				if (!line.includes("user/message")) continue;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					continue; // 被截断的末行
				}
				const record = event as { type?: unknown; payload?: { content?: unknown } };
				if (record.type !== "user/message" || typeof record.payload?.content !== "string") continue;
				const flat = record.payload.content.replace(/\s+/g, " ").trim();
				if (flat === "") continue;
				return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
			}
		} finally {
			closeSync(fd);
		}
	} catch {
		// 文件暂时读不到（被移动 / 权限）⇒ 没有预览，不影响列表
	}
	return undefined;
}

/** 一条会话的事件回放（按 seq 升序，原样给出已记录事件）。 */
export interface SessionReplay {
	readonly sessionId: SessionId;
	readonly events: readonly SessionEvent[];
}

export interface DesktopHost {
	/** 数据根（供界面显示"数据在哪"，也是"绝不碰 C 盘"的可读证据）。 */
	readonly home: string;
	list(): Promise<readonly SessionSummary[]>;
	read(sessionId: string): Promise<SessionReplay>;
	dispose(): Promise<void>;
}

export interface DesktopHostOptions {
	/** 数据根（缺省由调用方给出；**必须落在 D 盘**——由 `paths.ts` 的校验保证）。 */
	readonly home: string;
}

export function createDesktopHost(options: DesktopHostOptions): DesktopHost {
	const store: SessionStore = createSessionStore({ home: options.home });
	return {
		home: options.home,
		async list(): Promise<readonly SessionSummary[]> {
			const metas = await store.list();
			const titles: TitleMap = loadTitles(options.home);
			// 最近更新的在前：GUI 上"接着上次"是最高频动作
			return [...metas]
				.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
				.map((meta) => {
					const title = titles[meta.sessionId];
					const preview = readPreview(options.home, meta.sessionId);
					return {
						sessionId: meta.sessionId,
						updatedAt: meta.updatedAt,
						...(title === undefined ? {} : { title }),
						...(preview === undefined ? {} : { preview }),
					};
				});
		},
		async read(sessionId: string): Promise<SessionReplay> {
			const handle = await store.resume(sessionId as SessionId);
			try {
				return { sessionId: handle.sessionId, events: [...handle.log.events] };
			} finally {
				// 只读句柄用完即关（本批不持有长期句柄；M13b 的实时会话另有宿主）
				await handle.close();
			}
		},
		async dispose(): Promise<void> {
			await store.dispose();
		},
	};
}

/**
 * 事件 → **可渲染卡片**（纯函数；renderer 侧只做 DOM 组装）。
 * 这是"结构化事件 → 结构化卡片"的**唯一映射**：GUI **不**复用 `describeEvent` 的终端行模型，
 * 但**同样不丢事实**——未知类型一律保留，界面用 `[event] <type>` 兜底显示。
 */
export interface EventCard {
	/** 语义角色（renderer 据此上色/排版；与事件类型一一对应，不做启发式猜测）。 */
	readonly role:
		| "session"
		| "user"
		| "assistant"
		| "tool"
		| "permission"
		| "mode"
		| "memory"
		| "unknown";
	readonly type: string;
	readonly seq: number;
	/** 主文本（可能多行：由 renderer 按 `\n` 分成多行显示）。 */
	readonly text: string;
	/** 次要信息（工具名 / 子代理 kind / 会话 id 之类）。 */
	readonly meta?: string;
	/**
	 * **结构化模式字段**（只在 `session/start` 与 `mode/changed` 上有值）。
	 * 有它，renderer 才**不必**去解析 `format v1 | mode plan` 这种文本（ADR-023 的"不嗅探文本"纪律）。
	 */
	readonly mode?: string;
	/**
	 * **被折叠起来的剩余行**（M13d-2，只有 `tool/result` 且正文多行时才有）。
	 * `text` 是首行（折叠态可见），`detail` 是其余行——**展开态由前端自己持有**（视图状态，**绝不进 JSONL**）。
	 */
	readonly detail?: string;
	/** 正文（`text` + `detail`）的总行数；供前端显示「N 行 · 展开」用。 */
	readonly lines?: number;
	/** 是否**默认折叠**（M13d-2）：正文多行即为真——与 TUI 的折叠**同一个判据**（"藏了内容就能展开"）。 */
	readonly defaultFolded?: boolean;
}

/** 一条事件 → 一张卡片（纯函数，可逐条断言）。 */
export function toEventCard(event: SessionEvent): EventCard {
	switch (event.type) {
		case "session/start":
			return {
				role: "session",
				type: event.type,
				seq: event.seq,
				text: `format v${event.payload.formatVersion} | mode ${event.payload.mode}`,
				meta: event.payload.cwd,
				mode: event.payload.mode,
			};
		case "session/end":
			return { role: "session", type: event.type, seq: event.seq, text: event.payload.reason };
		case "turn/start":
			return {
				role: "session",
				type: event.type,
				seq: event.seq,
				text: `turn #${event.payload.index}`,
			};
		case "turn/end":
			return { role: "session", type: event.type, seq: event.seq, text: event.payload.stopReason };
		case "user/message":
			return { role: "user", type: event.type, seq: event.seq, text: event.payload.content };
		case "assistant/message": {
			const calls = event.payload.toolCalls ?? [];
			const meta = calls.length === 0 ? undefined : calls.map((call) => call.toolName).join(", ");
			return {
				role: "assistant",
				type: event.type,
				seq: event.seq,
				text: event.payload.content,
				...(meta === undefined ? {} : { meta }),
			};
		}
		case "tool/call":
			return {
				role: "tool",
				type: event.type,
				seq: event.seq,
				text: JSON.stringify(event.payload.input ?? null),
				meta: event.payload.toolName,
			};
		case "tool/result": {
			const payload = event.payload;
			// M13d-2：正文由**载荷本身**决定（字符串按行 / 其余 JSON 缩进）——与 TUI 的折叠**同一套规则**
			// （`payloadLines` 由 @chenxi/runtime 根入口定向转出，避免两处漂移）。
			// ⚠️ 旧实现是 `String(payload.output)`：工具返回**对象**时会渲染成 "[object Object]"（真缺陷，本批修掉）。
			const body = payload.ok
				? payloadLines(payload.output)
				: payloadLines(payload.error?.message ?? "");
			const head = payload.ok
				? (body[0] ?? "")
				: `${payload.error?.code ?? "unknown"}: ${body[0] ?? ""}`;
			const rest = body.slice(1);
			return {
				role: "tool",
				type: event.type,
				seq: event.seq,
				text: head,
				// 只给"有没有可展开的内容"；**展开与否由前端自己持有**（视图状态，绝不进 JSONL）
				...(rest.length === 0
					? {}
					: { detail: rest.join("\n"), lines: body.length, defaultFolded: true }),
				meta: `${payload.toolName} ${payload.ok ? "ok" : "error"} · ${payload.durationMs}ms`,
			};
		}
		case "permission/decision":
			return {
				role: "permission",
				type: event.type,
				seq: event.seq,
				text: event.payload.reason,
				meta: `${event.payload.toolName} → ${event.payload.decision}`,
			};
		case "mode/changed":
			return {
				role: "mode",
				type: event.type,
				seq: event.seq,
				text: `${event.payload.from} → ${event.payload.to}`,
				meta: event.payload.reason,
				mode: event.payload.to,
			};
		case "memory/injected":
			return {
				role: "memory",
				type: event.type,
				seq: event.seq,
				text: event.payload.content,
				meta: `${event.payload.source} · ${event.payload.memoryIds.length} record(s)`,
			};
		case "memory/written":
			// ADR-033：写入决策（含"为什么没写"）是**事实**，卡片上要能看见
			return {
				role: "memory",
				type: event.type,
				seq: event.seq,
				text: event.payload.content,
				meta:
					event.payload.reason === undefined
						? event.payload.decision
						: `${event.payload.decision} · ${event.payload.reason}`,
			};
		case "context/compacted":
			// M23：压缩是**事实**（它改变了投影），界面上要能看见"哪段被省略了"
			return {
				role: "session",
				type: event.type,
				seq: event.seq,
				text: event.payload.summary,
				meta: `省略 ${event.payload.removedMessages} 条 · seq ${event.payload.fromSeq}-${event.payload.toSeq}`,
			};
		case "subagent/context-imported":
			return {
				role: "unknown",
				type: event.type,
				seq: event.seq,
				text: `${event.payload.messages.length} message(s) imported`,
			};
		case "subagent/result":
			return {
				role: "unknown",
				type: event.type,
				seq: event.seq,
				text: event.payload.summary ?? event.payload.error ?? "",
				meta: `${event.payload.kind} ${event.payload.ok ? "ok" : "error"}`,
			};
		default: {
			// 未知类型**不丢事实**（与 ADR-022 同一条纪律）：原样保留类型，界面兜底显示
			const unknown = event as SessionEvent;
			return {
				role: "unknown",
				type: unknown.type,
				seq: unknown.seq,
				text: `[event] ${unknown.type}`,
			};
		}
	}
}

/** 批量映射（顺序不变）。 */
export function toEventCards(events: readonly SessionEvent[]): readonly EventCard[] {
	return events.map((event) => toEventCard(event));
}
