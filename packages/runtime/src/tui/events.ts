/**
 * 结构化事件 → 屏幕行（ADR-022）。
 *
 * 镜像（`--attach`）与将来的 TUI 都**按事件类型直接映射**成会话行——
 * 不再靠"文本前缀嗅探 + 横幅回读"（那是 M10 的临时手法，`06 §3` 的 M10b 第 1 项要消掉它）。
 *
 * 两条纪律：
 *  - **纯函数**：给定帧/事件与主题，输出*确定*的行 ⇒ 可被单测逐行断言；
 *  - **不丢事实**：**未知事件类型回退为 `[event] <type>`**，绝不静默丢弃——
 *    镜像的职责是呈现已有事实，不是替用户筛选。
 */
import type { StreamFrame } from "@chenxi/protocol";
import type { SessionEvent } from "@chenxi/schema";
import { payloadLines } from "./rich-text.js";
import type { Theme } from "./theme.js";

/** 取首行（工具结果/错误可能多行，终端一行只放得下首行）。 */
function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index === -1 ? text : text.slice(0, index);
}

/**
 * 呈现策略（**前端差异**，不是事实差异）：
 *  - `assistantContent`（缺省 true）：是否渲染 `assistant/message` 的**正文**。
 *    **流式前端**（TUI）传 false —— 正文已由**流式文本通道**呈现（它不是事件，只是增量）；
 *    此时仍渲染该事件的 **tool_call 轨迹**（那部分没有文本通道覆盖）。
 *  - `turnEnd`（缺省 true）：是否渲染 `turn/end`。**有"回合收尾文本行"的前端**（TUI 会打印
 *    `[assistant stopped: …, steps=N]`）传 false，避免同一件事出现两遍。
 */
export interface DescribeOptions {
	readonly assistantContent?: boolean;
	readonly turnEnd?: boolean;
	/**
	 * **工具结果折叠**（ADR-026，缺省 false ⇒ 保持"一行摘要"的既有行为）：
	 * 开启后，`tool/result` 折叠态会带 `· N 行 · 折叠 · 3ms` 标记（`N` = 被隐藏的输出行数，
	 * **无隐藏内容时不加标记**）；`expanded` 里的 `seq` 则渲染成"首行 + 逐行 `│ …`"。
	 *
	 * 折叠状态是**视图状态**（谁传谁持有，见 `transcript`），**绝不进 JSONL**。
	 */
	readonly collapse?: boolean;
	/** 已展开的 `tool/result` 事件 `seq` 集合（只在 `collapse: true` 时生效）。 */
	readonly expanded?: ReadonlySet<number>;
}

/** 入参摘要（可能含不可序列化的值，一律兜底成可读文本，绝不抛）。 */
function summarize(input: unknown): string {
	try {
		return JSON.stringify(input ?? null) ?? "null";
	} catch {
		return "<unserializable>";
	}
}

/**
 * 一条 `tool/result` **被折叠藏起来的行数**（`0` = 没有可展开的内容）。
 *
 * 这是"能不能展开"的**唯一判据**：`describeEvent` 的折叠分支与 `transcript` 的点击处理
 * 都调它，避免两处各算一份（那样会出现"没标记但点一下却有变化"的不一致）。
 */
export function toolResultHiddenLines(event: SessionEvent): number {
	if (event.type !== "tool/result") return 0;
	const payload = event.payload;
	const body = payload.ok
		? payloadLines(payload.output)
		: payloadLines(payload.error?.message ?? "");
	// 折叠头已经显示了错误消息的首行，故错误态要减掉那一行
	return payload.ok ? body.length : Math.max(0, body.length - 1);
}

/**
 * 把一条**已记录事件**映射成屏幕行（纯函数）。
 * 行内自闭合上色（与 `tui/format.ts` 同一纪律：颜色不渗到下一行）。
 *
 * `options` 是**前端差异**（不是事实差异）：同一份事实在不同前端的**呈现**策略不同，
 * 例如 TUI 的 assistant 正文走**流式文本通道**、回合收尾另有文本行（见 `DescribeOptions`）。
 */
export function describeEvent(
	event: SessionEvent,
	theme: Theme,
	options: DescribeOptions = {},
): string[] {
	switch (event.type) {
		case "session/start":
			// 会话身份（`session/start` 不进 SSE 流，但回放/本地投影里会有它）
			return [
				theme.paint("muted", `session: ${event.sessionId}`),
				theme.paint(
					"muted",
					`format v${event.payload.formatVersion} | mode ${event.payload.mode} | cwd ${event.payload.cwd}`,
				),
			];
		case "user/message": {
			// 多行消息按**多行**渲染（ADR-025）：否则一个数组元素里含 `\n` 会破坏
			// "一行 = 一个屏幕行"的不变量（截断/差分都按行数组工作）
			const rows = event.payload.content.split("\n");
			return [
				theme.paint("user", `› ${rows[0] ?? ""}`),
				...rows.slice(1).map((line) => theme.paint("user", `  ${line}`)),
			];
		}
		case "assistant/message": {
			const lines: string[] = [];
			if (options.assistantContent !== false && event.payload.content !== "") {
				lines.push(event.payload.content);
			}
			for (const call of event.payload.toolCalls ?? []) {
				lines.push(theme.paint("tool", `  → tool_call: ${call.toolName} ${summarize(call.input)}`));
			}
			return lines;
		}
		case "tool/result": {
			const payload = event.payload;
			const status = payload.ok
				? "ok"
				: `error(${payload.error?.code ?? "unknown"}): ${firstLine(payload.error?.message ?? "")}`;
			const head = `  ← tool_result: ${payload.toolName} ${status}`;
			const color = payload.ok ? "ok" : "err";
			if (options.collapse !== true) {
				// 缺省：一行摘要（M10b-1 起的行为，`--attach` 与单测都吃这一档）
				return [theme.paint(color, head)];
			}
			// 折叠 / 展开（ADR-026）：`hidden` 是**被藏起来的行数**——没藏东西就不提示"可折叠"
			const hidden = toolResultHiddenLines(event);
			const expanded = options.expanded?.has(event.seq) === true;
			const marker = hidden === 0 ? "" : ` · ${hidden} 行 · ${expanded ? "展开" : "折叠"}`;
			const lines = [theme.paint(color, `${head} · ${payload.durationMs}ms${marker}`)];
			if (expanded) {
				const body = payload.ok
					? payloadLines(payload.output)
					: payloadLines(payload.error?.message ?? "");
				for (const row of body) lines.push(theme.paint("muted", `  │ ${row}`));
			}
			return lines;
		}
		case "mode/changed":
			return [theme.paint("accent", `  mode: ${event.payload.from} -> ${event.payload.to}`)];
		case "memory/injected":
			return [
				theme.paint("tool", `  ~ memory: injected ${event.payload.memoryIds.length} record(s)`),
			];
		case "memory/written": {
			// ADR-033：写入**决策**本身是事实——成功、跳过、被闸门拒、链路失败都要能看见
			const payload = event.payload;
			const color =
				payload.decision === "added" ? "tool" : payload.decision === "failed" ? "err" : "warn";
			const detail = payload.reason === undefined ? "" : ` · ${payload.reason}`;
			return [theme.paint(color, `  ~ memory: ${payload.decision}${detail}`)];
		}
		case "permission/decision":
			return [
				theme.paint(
					event.payload.decision === "allow" ? "ok" : "warn",
					`  ! permission: ${event.payload.toolName} -> ${event.payload.decision}`,
				),
			];
		case "subagent/result": {
			const payload = event.payload;
			const summary = payload.ok
				? firstLine(payload.summary ?? "")
				: `error: ${firstLine(payload.error ?? "unknown")}`;
			return [
				theme.paint(
					payload.ok ? "tool" : "err",
					`  · subagent ${payload.kind}: ${summary} (child ${payload.childSessionId})`,
				),
			];
		}
		case "turn/start":
			// 回合边界是**记账**事件（唯一作用是把 turnId/index 记下来）：**不产生可见行**
			// —— 这是显式选择，不是"漏渲染"（未知类型仍会回退成 `[event]`，见 default）
			return [];
		case "turn/end":
			return options.turnEnd === false
				? []
				: [theme.paint("muted", `  [turn stopped: ${event.payload.stopReason}]`)];
		case "session/end":
			return [theme.paint("muted", `  [session ended: ${event.payload.reason}]`)];
		default:
			// 未知（或本层不专门渲染的）事件类型：**不丢事实**，回退成可读一行
			return [theme.paint("muted", `  [event] ${event.type}`)];
	}
}

/**
 * 把一条**流帧**映射成屏幕行（纯函数）：
 *  - `hello` → 协议版本 + `resume`（明示**不做断点续传**）；
 *  - `event`  → 交给 `describeEvent`；
 *  - `error`  → 可读错误 + 是否可续（可续 = 重连后整段回放）；
 *  - `session`→ 会话标识。
 */
export function describeFrame(
	frame: StreamFrame,
	theme: Theme,
	options: DescribeOptions = {},
): string[] {
	switch (frame.kind) {
		case "hello":
			return [
				theme.paint("muted", `attach: protocol v${frame.protocolVersion} | resume ${frame.resume}`),
				theme.paint("muted", "attach: no resume on the stream — reconnect and replay instead"),
			];
		case "event":
			return describeEvent(frame.event, theme, options);
		case "error":
			return [
				theme.paint("err", `  ! stream error [${frame.code}]: ${frame.message}`),
				theme.paint("muted", frame.retryable ? "  ! (retryable: replay)" : "  ! (not retryable)"),
			];
		case "session":
			return [theme.paint("muted", `session: ${frame.sessionId}`)];
	}
}
