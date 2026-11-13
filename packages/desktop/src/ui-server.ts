/**
 * renderer 的**本地静态托管**（ADR-029 ③的"只加载本地资源"）：只绑 `127.0.0.1`、只服务 `renderer/` 下的白名单文件。
 *
 * 为什么不直接 `file://`：`file://` 是不透明源，CSP 的 `script-src 'self'` 行为不可靠；
 * 用同进程托管的 loopback 让 CSP **真正生效**（`default-src 'none'` + `script-src 'self'` ⇒ renderer
 * **连一次网络请求都发不出去**）。这个服务**不接收任何写操作**，也不暴露任何会话数据（数据只走 IPC）。
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

/** 允许的类型（白名单；其余一律 404）。 */
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

export interface UiServer {
	/** 形如 `http://127.0.0.1:<port>/`。 */
	readonly url: string;
	close(): Promise<void>;
}

/** 启动 renderer 托管（`rendererDir` 必须真实存在；只读、无写路径）。 */
export function startUiServer(rendererDir: string): Promise<UiServer> {
	const root = resolve(rendererDir);
	const server: Server = createServer((request, response) => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
			return;
		}
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
		const target = join(root, normalize(relative));
		// 白名单 + 目录逃逸防护（**任何**越界一律 404，不泄漏文件系统布局）
		if (!target.startsWith(root) || TYPES[extname(target)] === undefined) {
			response.writeHead(404, { "content-type": "text/plain" }).end("not found");
			return;
		}
		try {
			const body = readFileSync(target);
			response.writeHead(200, {
				"content-type": TYPES[extname(target)] as string,
				"cache-control": "no-store",
			});
			response.end(request.method === "HEAD" ? undefined : body);
		} catch {
			response.writeHead(404, { "content-type": "text/plain" }).end("not found");
		}
	});

	return new Promise<UiServer>((resolvePromise, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolvePromise({
				url: `http://127.0.0.1:${port}/`,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}
