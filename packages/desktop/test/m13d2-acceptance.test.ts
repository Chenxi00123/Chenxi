/**
 * M13d-2 验收测试（总工程师独立编写）：桌面版的**工具结果呈现与折叠**（ADR-029 增补）。
 *
 * 这一批修掉一个**真缺陷**：`tool/result` 的 `output` 是工具返回的**值本身**（对象居多），
 * 旧映射 `String(payload.output)` 会把它渲染成 **`"[object Object]"`** —— 也就是说桌面版
 * **根本看不到工具结果**。现在正文由 `payloadLines`（与 TUI 的折叠**同一套规则**）给出：
 * 字符串按 `\n` 切、其余 `JSON.stringify(…, null, 2)`。
 *
 * 折叠（点击展开）是**视图状态**：
 *  - 「能不能展开」的判据（`detail` / `lines` / `defaultFolded`）由 **`host.ts` 单一给出**（纯函数，可逐条断言）；
 *  - renderer **不自己算**"多少行才折"，只按 `defaultFolded` 渲染、点卡头切换；**绝不写进 JSONL**。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { payloadLines } from "@chenxi/runtime";
import { describe, expect, it } from "vitest";
import { toEventCard } from "../src/host.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const base = { seq: 7, id: "evt_7", sessionId: "ses_x", at: "at" } as const;

function toolResult(payload: Record<string, unknown>) {
	return toEventCard({
		...base,
		type: "tool/result",
		payload: { callId: "c1", toolName: "read", durationMs: 4, ok: true, ...payload },
	} as never);
}

describe('M13d-2 工具结果按**载荷本身**渲染（修掉 "[object Object]"）', () => {
	it('**对象**载荷走 JSON 缩进：首行进 text、其余进 detail，绝不出现 "[object Object]"', () => {
		const card = toolResult({ output: { content: "a\nb", truncated: false } });
		expect(card.text).toBe("{");
		expect(card.text).not.toBe("[object Object]");
		expect(card.lines).toBe(4); // `{` / `"content"` / `"truncated"` / `}`
		expect(card.detail?.split("\n")).toEqual([
			'  "content": "a\\nb",',
			'  "truncated": false',
			"}",
		]);
		expect(card.defaultFolded).toBe(true);
	});

	it("**字符串**载荷按行切：首行进 text，其余进 detail", () => {
		const card = toolResult({ output: "l1\nl2\nl3" });
		expect(card.text).toBe("l1");
		expect(card.detail).toBe("l2\nl3");
		expect(card.lines).toBe(3);
		expect(card.defaultFolded).toBe(true);
	});

	it("**单行**载荷不折叠（没有可展开的内容就不给标记——与 TUI 的判据同源）", () => {
		const card = toolResult({ output: "only" });
		expect(card.text).toBe("only");
		expect(card.detail).toBeUndefined();
		expect(card.lines).toBeUndefined();
		expect(card.defaultFolded).toBeUndefined();
	});

	it("错误态：text = `code: 首行`、其余行进 detail（单行错误则不折叠，与 M13a 的既有断言一致）", () => {
		const multi = toolResult({
			ok: false,
			output: undefined,
			error: { code: "permission_denied", message: "nope\nstack", retryable: false },
		});
		expect(multi.text).toBe("permission_denied: nope");
		expect(multi.detail).toBe("stack");
		expect(multi.defaultFolded).toBe(true);

		const single = toolResult({
			ok: false,
			output: undefined,
			error: { code: "permission_denied", message: "nope", retryable: false },
		});
		expect(single.text).toBe("permission_denied: nope");
		expect(single.detail).toBeUndefined();
		expect(single.defaultFolded).toBeUndefined();
	});

	it("折叠只是**卡片字段**：同一事件映射两次逐字段相同（纯函数；不读不写任何存储）", () => {
		const event = {
			...base,
			type: "tool/result",
			payload: {
				callId: "c1",
				toolName: "write",
				ok: true,
				output: { path: "a", bytes: 3 },
				durationMs: 2,
			},
		} as never;
		expect(toEventCard(event)).toEqual(toEventCard(event));
	});
});

describe("M13d-2 「载荷 → 行」的规则是**唯一来源**（与 TUI 折叠同一套）", () => {
	it("payloadLines 由 @chenxi/runtime 根入口**定向**转出，行为就是 host 依赖的那套", () => {
		expect(payloadLines(undefined)).toEqual([]);
		expect(payloadLines(null)).toEqual([]);
		expect(payloadLines("a\nb")).toEqual(["a", "b"]);
		expect(payloadLines({ x: 1 })).toEqual(["{", '  "x": 1', "}"]);
		expect(payloadLines(["a", "b"])).toEqual(["[", '  "a",', '  "b"', "]"]); // 数组也是 JSON 缩进
	});
});

describe("M13d-2 契约（源码级断言，防漂移）", () => {
	const hostSource = readFileSync(join(PKG, "src", "host.ts"), "utf8");
	const rendererSource = readFileSync(join(PKG, "renderer", "app.js"), "utf8");
	const rootSource = readFileSync(join(PKG, "..", "runtime", "src", "index.ts"), "utf8");

	it('host 用共享的 payloadLines（不再有 String(output) 那种会出 "[object Object]" 的写法）', () => {
		expect(hostSource).toContain("payloadLines");
		// 旧写法（会把对象渲染成 "[object Object]"）必须**真的没了**；注意别把源码注释也算进来
		expect(hostSource).not.toContain('String(payload.output ?? "")');
		expect(rootSource).toContain("export { payloadLines }");
	});

	it("renderer 不自己算折叠：只认卡片给的 defaultFolded / detail（视图状态，不外发）", () => {
		expect(rendererSource).toContain("card.defaultFolded");
		expect(rendererSource).toContain("card.detail");
		// 折叠是纯视图：renderer 不为它调任何 IPC（`chenxi.*` 里没有 fold/expand 之类动作）
		expect(rendererSource).not.toMatch(/chenxi\.(fold|expand|toggle)/i);
		// 也不注入 HTML 字符串
		expect(/\.innerHTML\s*=/.test(rendererSource)).toBe(false);
	});
});
