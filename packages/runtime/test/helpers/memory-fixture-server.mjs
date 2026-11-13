#!/usr/bin/env node
/**
 * 测试夹具：**记忆层**的 stdio MCP 服务端（零依赖，JSON-RPC 2.0 按行分隔）。
 *
 * 存在的理由：我们**不自研**记忆层（ADR-010），但"真进程桥接 → 读写记忆"这条链路必须能实测。
 *
 * 两种模式（**默认模式的行为与 M14 完全一致，不能改**）：
 *  - 缺省（`--mode=records`，M14 用）：只暴露 `search_memory`，固定返回 2 条合法记录 + 1 条坏记录
 *    （用于断言"坏项被丢弃"）。**不看参数**——旧测试依赖这一点。
 *  - `--mode=store`（M17 用）：一个**真的**内存记忆库：
 *      · `search_memory` 按 `user`+`agent` 过滤；`session: "*"` = 跨会话；`query` 为空返回全部；
 *        **只返回未失效**（`invalidAt` 为空）的记录——失效语义与真实记忆层一致；
 *      · `add_memory` 追加一条并返回 `{ records: [{ id, content, … }] }`；
 *      · `invalidate_memory` 给指定 id 写 `invalidAt`（"失效而非删除"）；
 *      · `--ignore-invalidate`：**接受**失效调用但**不生效** ⇒ 专门用来验证写入侧的
 *        `old_still_visible` 断言（不假装成功）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-11-25";

const SCOPE_PROPS = {
	user: { type: "string" },
	agent: { type: "string" },
	session: { type: "string" },
};

const SEARCH_INPUT_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string" },
		limit: { type: "number" },
		...SCOPE_PROPS,
	},
	additionalProperties: false,
};

const ADD_INPUT_SCHEMA = {
	type: "object",
	properties: {
		content: { type: "string" },
		...SCOPE_PROPS,
		provenance: { type: "object" },
	},
	required: ["content"],
	additionalProperties: false,
};

const INVALIDATE_INPUT_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string" },
		invalidAt: { type: "string" },
		...SCOPE_PROPS,
	},
	required: ["id"],
	additionalProperties: false,
};

/** 夹具记忆库（缺省模式）：含 bitemporal 字段与 provenance（保证导出的是"完整形状"）。 */
const RECORDS = [
	{
		id: "m1",
		content: "用户偏好：编辑用 vim",
		score: 0.91,
		createdAt: "2026-01-01T00:00:00.000Z",
		validAt: "2026-01-01T00:00:00.000Z",
		invalidAt: null,
		provenance: { promptId: "p1", promptVersion: "v1", promptHash: "sha256-fixture" },
	},
	{
		id: "m2",
		content: "旧事实：默认分支是 master",
		createdAt: "2026-01-01T00:00:01.000Z",
		validAt: "2026-01-01T00:00:01.000Z",
		invalidAt: "2026-01-02T00:00:00.000Z",
	},
	// 坏记录：没有 content ⇒ 导出侧应当**丢弃并报数**（绝不让它混进文档）
	{ id: "m3-broken", score: "not-a-number" },
];

const modeArg = process.argv
	.slice(2)
	.find((arg) => arg.startsWith("--mode="))
	?.slice("--mode=".length);
const mode = modeArg === undefined ? "records" : modeArg;
const store = mode === "store";
const ignoreInvalidate = process.argv.slice(2).includes("--ignore-invalidate");
/**
 * 持久化文件（`--store=<file>`）：**跨进程共享**记忆库——真实记忆层是持久的，
 * 而"跨会话检索"必须跨 CLI 进程验证（每个 CLI 进程会各起一个 fixture 进程）。
 */
const storeFile = process.argv
	.slice(2)
	.find((arg) => arg.startsWith("--store="))
	?.slice("--store=".length);

/** store 模式的内存库（可选落盘；每次测试自己决定是否共享）。 */
const db = [];
let nextId = 1;

function loadStore() {
	if (storeFile === undefined) return;
	try {
		const parsed = JSON.parse(readFileSync(storeFile, "utf8"));
		if (!Array.isArray(parsed)) return;
		db.push(...parsed);
		nextId = db.length + 1;
	} catch {
		// 首次运行：文件不存在 = 空库
	}
}

function saveStore() {
	if (storeFile === undefined) return;
	writeFileSync(storeFile, JSON.stringify(db, null, 2), "utf8");
}

loadStore();

const TOOLS = store
	? [
			{
				name: "search_memory",
				description: "Search long-term memory (store mode).",
				inputSchema: SEARCH_INPUT_SCHEMA,
				annotations: { readOnlyHint: true },
			},
			{
				name: "add_memory",
				description: "Add one long-term memory.",
				inputSchema: ADD_INPUT_SCHEMA,
				annotations: { readOnlyHint: false },
			},
			{
				name: "invalidate_memory",
				description: "Invalidate one memory (bitemporal: mark invalidAt, do not delete).",
				inputSchema: INVALIDATE_INPUT_SCHEMA,
				annotations: { readOnlyHint: false },
			},
		]
	: [
			{
				name: "search_memory",
				description: "Search long-term memory. Returns { records: [...] } as text.",
				inputSchema: SEARCH_INPUT_SCHEMA,
				annotations: { readOnlyHint: true },
			},
		];

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(id, text, isError) {
	send({
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text }], ...(isError === true ? { isError: true } : {}) },
	});
}

function sameScope(record, params) {
	if ((params.user ?? "") !== record.scope.user) return false;
	if ((params.agent ?? "") !== record.scope.agent) return false;
	if ((params.session ?? "") === "*" || params.session === undefined) return true;
	return params.session === record.scope.session;
}

function searchStore(params) {
	const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
	const limit = typeof params.limit === "number" ? Math.max(0, params.limit) : 50;
	const hits = db
		.filter((record) => sameScope(record, params))
		.filter((record) => record.invalidAt === null) // 失效的事实**不返回**（与真实记忆层一致）
		.filter((record) => query === "" || record.content.toLowerCase().includes(query))
		.slice(0, limit);
	return hits;
}

function addMemory(params) {
	const now = new Date().toISOString();
	const record = {
		id: `m${nextId}`,
		content: String(params.content),
		scope: {
			user: String(params.user ?? ""),
			agent: String(params.agent ?? ""),
			session: String(params.session ?? ""),
		},
		createdAt: now,
		validAt: now,
		invalidAt: null,
		...(typeof params.provenance === "object" && params.provenance !== null
			? { provenance: params.provenance }
			: {}),
	};
	nextId += 1;
	db.push(record);
	return record;
}

function invalidateMemory(params) {
	const target = db.find((record) => record.id === params.id && sameScope(record, params));
	if (target === undefined) return false;
	if (ignoreInvalidate) return true; // **接受但不生效**：专门用于验证写入侧的诚实断言
	target.invalidAt = typeof params.invalidAt === "string" ? params.invalidAt : new Date().toISOString();
	return true;
}

const reader = createInterface({ input: process.stdin, terminal: false });
reader.on("line", (line) => {
	if (line.trim() === "") return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return; // 非 JSON 行忽略
	}
	const id = message.id;
	const params = message.params ?? {};

	switch (message.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "chenxi-memory-fixture", version: "1.0.0" },
				},
			});
			break;
		case "notifications/initialized":
			break;
		case "tools/list":
			send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
			break;
		case "tools/call": {
			const name = params.name;
			const args = params.arguments ?? {};
			if (store) {
				if (name === "search_memory") {
					textResult(id, JSON.stringify({ records: searchStore(args) }));
				} else if (name === "add_memory") {
					const record = addMemory(args);
					saveStore();
					textResult(id, JSON.stringify({ records: [record] }));
				} else if (name === "invalidate_memory") {
					const ok = invalidateMemory(args);
					saveStore();
					textResult(id, JSON.stringify({ ok }), !ok);
				} else {
					textResult(id, `unknown tool: ${String(name)}`, true);
				}
				break;
			}
			// 缺省模式（M14 的既有行为，**不得改动**）
			if (name !== "search_memory") {
				textResult(id, `unknown tool: ${String(name)}`, true);
				break;
			}
			if (mode === "broken") {
				textResult(id, "this is not JSON at all");
				break;
			}
			textResult(id, JSON.stringify({ records: mode === "empty" ? [] : RECORDS }));
			break;
		}
		default:
			if (id !== undefined) {
				send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			}
	}
});
