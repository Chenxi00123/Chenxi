import { describe, expect, it, vi } from "vitest";
import { createContext } from "../src/events/index.js";

describe("emit / on", () => {
	it("同步调用全部监听器，Disposer 生效", () => {
		const ctx = createContext();
		const hits: number[] = [];
		ctx.on("ping", () => hits.push(1));
		const off = ctx.on("ping", () => hits.push(2));

		ctx.emit("ping");
		expect(hits).toEqual([1, 2]);

		off();
		ctx.emit("ping");
		expect(hits).toEqual([1, 2, 1]);
	});

	it("反注册幂等（重复调用无副作用）", () => {
		const ctx = createContext();
		const hits: string[] = [];
		const off = ctx.on("a", () => hits.push("x"));

		off();
		off();
		ctx.emit("a");
		expect(hits).toEqual([]);
	});
});

describe("bail", () => {
	it("返回首个非 undefined 值并停止后续", () => {
		const ctx = createContext();
		const seen: string[] = [];
		ctx.on("q", () => {
			seen.push("a");
			return undefined;
		});
		ctx.on("q", () => {
			seen.push("b");
			return "first";
		});
		ctx.on("q", () => {
			seen.push("c");
			return "second";
		});

		expect(ctx.bail<string>("q")).toBe("first");
		expect(seen).toEqual(["a", "b"]);
	});
});

describe("parallel / serial", () => {
	it("parallel 并发执行（两监听器同时启动）", async () => {
		const ctx = createContext();
		const started: number[] = [];
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		ctx.on("go", async () => {
			started.push(1);
			await gate;
		});
		ctx.on("go", async () => {
			started.push(2);
			await gate;
		});

		const running = ctx.parallel("go");
		// 两个监听器都已在等待同一个 gate -> 并发而非串行
		expect(started).toEqual([1, 2]);
		release();
		await running;
	});

	it("serial 串行执行（顺序等待）", async () => {
		const ctx = createContext();
		const order: number[] = [];
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		ctx.on("seq", async () => {
			order.push(1);
			await gate;
		});
		ctx.on("seq", async () => {
			order.push(2);
		});

		const running = ctx.serial("seq");
		await Promise.resolve();
		// 第二个监听器尚未开始 -> 串行
		expect(order).toEqual([1]);
		release();
		await running;
		expect(order).toEqual([1, 2]);
	});
});

describe("waterfall", () => {
	const wrap = async (...args: unknown[]): Promise<unknown> => {
		const next = args.at(-1) as () => Promise<unknown>;
		const inner = await next();
		return { wrapped: inner };
	};

	it("调 next() 委派到兜底函数", async () => {
		const ctx = createContext();
		const order: string[] = [];
		ctx.on("w", async (...args: unknown[]) => {
			order.push("mw:in");
			const result = await wrap(...args);
			order.push("mw:out");
			return result;
		});

		const fallback = vi.fn(async () => "builtin");
		const out = await ctx.waterfall("w", { tool: "read" }, fallback);

		// 中间件包了一层，说明其确实拿到了兜底函数的返回值
		expect(out).toEqual({ wrapped: "builtin" });
		expect(fallback).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["mw:in", "mw:out"]);
	});

	it("不调 next() 即短路，兜底函数不被调用", async () => {
		const ctx = createContext();
		ctx.on("w", wrap);
		ctx.on("w", async () => ({ ok: true, value: "short-circuited" }));

		const fallback = vi.fn(async () => ({ ok: true, value: "builtin" }));
		const out = await ctx.waterfall("w", { tool: "read" }, fallback);

		expect(out).toEqual({ wrapped: { ok: true, value: "short-circuited" } });
		expect(fallback).not.toHaveBeenCalled();
	});

	it("prepend: true 的中间件更靠外", async () => {
		const ctx = createContext();
		const order: string[] = [];
		const tracer =
			(label: string) =>
			async (...args: unknown[]) => {
				order.push(label);
				const next = args.at(-1) as () => Promise<unknown>;
				return next();
			};

		ctx.on("w", tracer("inner"));
		ctx.on("w", tracer("outer"), { prepend: true });

		const fallback = vi.fn(async () => "ok");
		const out = await ctx.waterfall("w", { d: 1 }, fallback);

		expect(out).toBe("ok");
		expect(order).toEqual(["outer", "inner"]);
		expect(fallback).toHaveBeenCalledTimes(1);
	});

	it("无监听器时直接执行兜底函数", async () => {
		const ctx = createContext();
		const fallback = vi.fn(async (n: unknown) => `fb:${String(n)}`);
		const out = await ctx.waterfall<string>("w", 3, fallback);
		expect(out).toBe("fb:3");
	});
});

describe("effect（注册即 effect）", () => {
	it("dispose 后注册表归零，且重复 dispose 幂等", () => {
		const ctx = createContext();
		const hits: string[] = [];

		const dispose = ctx.effect(() => {
			ctx.on("e", () => hits.push("a"));
			ctx.on("e", () => hits.push("b"));
			ctx.provide("svc", 42);
		});

		expect(ctx.get("svc")).toBe(42);
		ctx.emit("e");
		expect(hits).toEqual(["a", "b"]);

		dispose();
		expect(ctx.get("svc")).toBeUndefined();
		ctx.emit("e");
		expect(hits).toEqual(["a", "b"]);

		// 重复 dispose 无副作用
		dispose();
		expect(ctx.get("svc")).toBeUndefined();
		ctx.emit("e");
		expect(hits).toEqual(["a", "b"]);
	});

	it("callback 返回的 Disposer 也随本次 effect 回滚", () => {
		const ctx = createContext();
		let cleanup = 0;
		const dispose = ctx.effect(() => {
			ctx.on("e", () => undefined);
			return () => {
				cleanup += 1;
			};
		});

		expect(cleanup).toBe(0);
		dispose();
		expect(cleanup).toBe(1);
		dispose();
		expect(cleanup).toBe(1);
	});

	it("嵌套 effect 随外层一并回滚", () => {
		const ctx = createContext();
		const hits: string[] = [];
		const outer = ctx.effect(() => {
			ctx.effect(() => {
				ctx.on("n", () => hits.push("inner"));
			});
		});

		ctx.emit("n");
		expect(hits).toEqual(["inner"]);

		outer();
		ctx.emit("n");
		expect(hits).toEqual(["inner"]);
	});
});

describe("inject", () => {
	it("服务已就绪时同步执行回调，dispose 触发回调 Disposer", () => {
		const ctx = createContext();
		ctx.provide("log", { level: "info" });

		const seen: unknown[] = [];
		let cleanup = 0;
		const dispose = ctx.inject(["log"], (services) => {
			seen.push(services.log);
			return () => {
				cleanup += 1;
			};
		});

		expect(seen).toEqual([{ level: "info" }]);
		expect(cleanup).toBe(0);

		dispose();
		expect(cleanup).toBe(1);
		dispose();
		expect(cleanup).toBe(1);
	});

	it("服务后续 provide 时触发", () => {
		const ctx = createContext();
		const seen: unknown[] = [];
		let cleanup = 0;
		ctx.inject(["late"], (services) => {
			seen.push(services.late);
			return () => {
				cleanup += 1;
			};
		});

		expect(seen).toEqual([]);
		ctx.provide("late", 7);
		expect(seen).toEqual([7]);

		ctx.dispose();
		expect(cleanup).toBe(1);
	});
});

describe("ctx.dispose", () => {
	it("反注册全部并幂等", () => {
		const ctx = createContext();
		const hits: string[] = [];
		ctx.on("x", () => hits.push("h"));
		ctx.provide("s", 1);

		ctx.emit("x");
		expect(hits).toEqual(["h"]);

		ctx.dispose();
		expect(ctx.get("s")).toBeUndefined();
		ctx.emit("x");
		expect(hits).toEqual(["h"]);

		ctx.dispose();
		expect(ctx.get("s")).toBeUndefined();
	});
});
