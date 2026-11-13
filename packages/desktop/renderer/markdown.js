/**
 * 极简 Markdown → DOM（M22，ADR-040）——**零依赖、绝不拼 HTML 字符串**。
 *
 * 为什么不用现成库：仓库的 renderer 只跑本地静态资源（CSP `default-src 'none'`），
 * 且**不引新依赖**是项目纪律；而绝大多数 markdown 库都把"输出 HTML 字符串"当接口，
 * 一旦配合 `innerHTML` 就给注入面。这里全程 `document.createElement` / `textContent`。
 *
 * 支持（只覆盖模型实际会写的那一小撮）：
 *   ```lang 围栏代码块（含未闭合的流式尾巴）、`行内代码`、**粗体**、*斜体*、
 *   # 标题（1–3 级）、- / * 无序列表、1. 有序列表、> 引用、--- 分隔线、
 *   [文字](url) 链接（**渲染成不可点击的文本 + title**：renderer 的 CSP 不允许导航）。
 *
 * 安全：所有文本一律 `textContent`；代码块内容原样保留（不做行内解析）。
 */
(() => {
	/** 行内解析：把一段文本拆成若干行内节点（代码优先，避免 `**` 落在 code 里被误解析）。 */
	function inlineNodes(text) {
		const nodes = [];
		const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]*\]\([^)\s]+\))/g;
		let last = 0;
		for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
			if (match.index > last) nodes.push(document.createTextNode(text.slice(last, match.index)));
			const token = match[0];
			if (token.startsWith("`")) {
				const code = document.createElement("code");
				code.className = "md-code";
				code.textContent = token.slice(1, -1);
				nodes.push(code);
			} else if (token.startsWith("**")) {
				const strong = document.createElement("strong");
				strong.textContent = token.slice(2, -2);
				nodes.push(strong);
			} else if (token.startsWith("[")) {
				const closing = token.indexOf("](");
				const label = token.slice(1, closing);
				const href = token.slice(closing + 2, -1);
				const link = document.createElement("span");
				link.className = "md-link";
				link.textContent = label;
				link.title = href;
				nodes.push(link);
			} else {
				const em = document.createElement("em");
				em.textContent = token.slice(1, -1);
				nodes.push(em);
			}
			last = match.index + token.length;
		}
		if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
		return nodes;
	}

	/** 一行「普通文本」→ 一个带行内格式的 div（空行留一个占位，保持段落间距）。 */
	function paragraph(text) {
		const node = document.createElement("div");
		node.className = "md-p";
		if (text.trim() === "") {
			node.classList.add("md-gap");
			return node;
		}
		for (const child of inlineNodes(text)) node.append(child);
		return node;
	}

	/** 围栏代码块：语言标签放在左上角（没有语言就不显示）。 */
	function codeBlock(language, lines) {
		const wrap = document.createElement("div");
		wrap.className = "md-pre";
		if (language !== "") {
			const tag = document.createElement("span");
			tag.className = "md-lang";
			tag.textContent = language;
			wrap.append(tag);
		}
		const pre = document.createElement("pre");
		pre.textContent = lines.join("\n");
		wrap.append(pre);
		return wrap;
	}

	/** 主入口：把 markdown 文本转成 DocumentFragment（调用方直接 append）。 */
	function renderMarkdown(text) {
		const fragment = document.createDocumentFragment();
		const lines = String(text ?? "").split("\n");
		let index = 0;

		while (index < lines.length) {
			const line = lines[index];

			// 围栏代码块：允许"没闭合"（流式结尾），到文末即收
			const fence = /^\s*```(\S*)\s*$/.exec(line);
			if (fence !== null) {
				const language = fence[1] ?? "";
				const body = [];
				index += 1;
				while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
					body.push(lines[index]);
					index += 1;
				}
				index += 1; // 跳过收尾围栏（若有）
				fragment.append(codeBlock(language, body));
				continue;
			}

			// 分隔线
			if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
				const hr = document.createElement("div");
				hr.className = "md-hr";
				fragment.append(hr);
				index += 1;
				continue;
			}

			// 标题（1–3 级；再多按 3 级处理，视觉上不再细分）
			const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
			if (heading !== null) {
				const level = Math.min(heading[1].length, 3);
				const node = document.createElement(`h${level}`);
				node.className = "md-h";
				for (const child of inlineNodes(heading[2])) node.append(child);
				fragment.append(node);
				index += 1;
				continue;
			}

			// 引用：连续 `>` 行合成一个块
			if (/^\s*>\s?/.test(line)) {
				const quote = document.createElement("blockquote");
				quote.className = "md-quote";
				while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
					quote.append(paragraph(lines[index].replace(/^\s*>\s?/, "")));
					index += 1;
				}
				fragment.append(quote);
				continue;
			}

			// 列表（无序 / 有序各自成块；不嵌套，够用且不会把模型写坏的结构渲染成灾难）
			const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
			if (bullet !== null) {
				const list = document.createElement("ul");
				list.className = "md-list";
				while (index < lines.length) {
					const item = /^(\s*)([-*+])\s+(.*)$/.exec(lines[index]);
					if (item === null) break;
					const li = document.createElement("li");
					for (const child of inlineNodes(item[3])) li.append(child);
					list.append(li);
					index += 1;
				}
				fragment.append(list);
				continue;
			}
			const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
			if (ordered !== null) {
				const list = document.createElement("ol");
				list.className = "md-list";
				while (index < lines.length) {
					const item = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[index]);
					if (item === null) break;
					const li = document.createElement("li");
					for (const child of inlineNodes(item[3])) li.append(child);
					list.append(li);
					index += 1;
				}
				fragment.append(list);
				continue;
			}

			fragment.append(paragraph(line));
			index += 1;
		}

		return fragment;
	}

	// renderer 侧没有模块加载器：挂一个全局，app.js 判存在再用
	window.renderMarkdown = renderMarkdown;
})();
