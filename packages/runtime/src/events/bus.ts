/**
 * events 模块实现（ADR-004）：事件总线 + waterfall 中间件 + 注册即 effect。
 *
 * 五种派发：`emit / parallel / serial / bail / waterfall`。
 * `waterfall` 为中间件式：监听器调用 `next()` 才继续向内委派，
 * **不调用 `next()` 即短路内置行为**。
 * 一切注册都经 `effect()` 纳入作用域，卸载时自动回滚。
 */
import type { Context, Disposer, EventHandler, RegisterOptions } from "./types.js";

/** 生成幂等 Disposer：目标最多执行一次，重复调用无副作用。 */
function once(fn: () => void): Disposer {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		fn();
	};
}

/** 尚未就绪（服务未全部 provide）的 inject 登记。 */
interface PendingInject {
	readonly names: readonly string[];
	readonly callback: (services: Record<string, unknown>, ctx: Context) => Disposer | void;
	disposed: boolean;
	disposer: Disposer | undefined;
}

export function createContext(initialServices?: Record<string, unknown>): Context {
	/** 服务表：provide 写入，可回滚到 provide 前的状态。 */
	const services = new Map<string, unknown>();
	if (initialServices) {
		for (const [name, value] of Object.entries(initialServices)) {
			services.set(name, value);
		}
	}

	/** 事件名 -> 有序监听器列表（prepend 时插到最前）。 */
	const listeners = new Map<string, EventHandler[]>();

	/** 作用域栈：栈底为上下文根，栈顶为当前 effect；注册对象归入栈顶。 */
	const rootScope = new Set<Disposer>();
	const scopes: Set<Disposer>[] = [rootScope];

	/** 等待服务就绪的 inject。 */
	const pending: PendingInject[] = [];

	// biome-ignore lint/style/useConst: 需在闭包（inject 等）定义之后才赋值，以支持模块内相互引用
	let context: Context;

	const track = (disposer: Disposer): void => {
		const top = scopes.at(-1);
		if (top) top.add(disposer);
	};

	const listFor = (event: string): EventHandler[] => {
		let list = listeners.get(event);
		if (!list) {
			list = [];
			listeners.set(event, list);
		}
		return list;
	};

	/** 派发前对监听器列表快照，避免回调中途增删导致遍历错位。 */
	const snapshot = (event: string): EventHandler[] => [...(listeners.get(event) ?? [])];

	const on: Context["on"] = (event, handler, options: RegisterOptions = {}) => {
		const list = listFor(event);
		if (options.prepend) list.unshift(handler);
		else list.push(handler);
		const disposer = once(() => {
			const index = list.indexOf(handler);
			if (index >= 0) list.splice(index, 1);
		});
		track(disposer);
		return disposer;
	};

	const emit: Context["emit"] = (event, ...args) => {
		for (const handler of snapshot(event)) handler(...args);
	};

	const parallel: Context["parallel"] = async (event, ...args) => {
		await Promise.all(snapshot(event).map((handler) => handler(...args)));
	};

	const serial: Context["serial"] = async (event, ...args) => {
		for (const handler of snapshot(event)) await handler(...args);
	};

	const bail: Context["bail"] = <T = unknown>(event: string, ...args: unknown[]) => {
		for (const handler of snapshot(event)) {
			const result = handler(...args);
			if (result !== undefined) return result as T;
		}
		return undefined;
	};

	/**
	 * 中间件式派发：`...args` 的**最后一项**为兜底函数，其余透传给监听器。
	 * 监听器接到 `(...data, next)`；`next()` 委派给下一个监听器，
	 * 全部监听器跑完后执行兜底函数。监听器不调 `next()` 即短路。
	 */
	const waterfall: Context["waterfall"] = async <T = unknown>(
		event: string,
		...args: unknown[]
	): Promise<T> => {
		const fallback = args.at(-1);
		const data = args.slice(0, -1);
		const chain = snapshot(event);

		const dispatch = async (index: number): Promise<unknown> => {
			const handler = chain[index];
			if (handler === undefined) {
				// 监听器已全部委派完毕 -> 执行兜底函数
				if (typeof fallback === "function") {
					const fn = fallback as (...innerArgs: unknown[]) => unknown;
					return await fn(...data);
				}
				return fallback;
			}
			const next = (): Promise<unknown> => dispatch(index + 1);
			return await handler(...data, next);
		};

		return (await dispatch(0)) as T;
	};

	const effect: Context["effect"] = (callback) => {
		const scope = new Set<Disposer>();
		scopes.push(scope);
		let own: Disposer | void;
		try {
			own = callback();
		} catch (error) {
			// 回调抛错：立即回滚本次已登记的注册，避免泄漏
			for (const disposer of scope) disposer();
			scope.clear();
			throw error;
		} finally {
			scopes.pop();
		}
		if (own) scope.add(own);
		const disposer = once(() => {
			for (const d of scope) d();
			scope.clear();
		});
		track(disposer);
		return disposer;
	};

	/** 在 effect 作用域内执行 inject 回调，其 Disposer 自动纳入回滚。 */
	const runInject = (
		names: readonly string[],
		callback: (services: Record<string, unknown>, ctx: Context) => Disposer | void,
	): Disposer =>
		effect(() => {
			const resolved: Record<string, unknown> = {};
			for (const name of names) resolved[name] = services.get(name);
			return callback(resolved, context);
		});

	const activatePending = (): void => {
		for (const entry of [...pending]) {
			if (entry.disposed || entry.disposer) continue;
			if (!entry.names.every((name) => services.has(name))) continue;
			entry.disposer = runInject(entry.names, entry.callback);
		}
	};

	const provide: Context["provide"] = (name, value) => {
		const had = services.has(name);
		const previous = services.get(name);
		services.set(name, value);
		const disposer = once(() => {
			if (had) services.set(name, previous);
			else services.delete(name);
		});
		track(disposer);
		// 新服务就绪 -> 触发等待中的 inject
		activatePending();
		return disposer;
	};

	const inject: Context["inject"] = (names, callback) => {
		if (names.every((name) => services.has(name))) {
			return runInject(names, callback);
		}
		const entry: PendingInject = { names, callback, disposed: false, disposer: undefined };
		pending.push(entry);
		const disposer = once(() => {
			entry.disposed = true;
			entry.disposer?.();
			const index = pending.indexOf(entry);
			if (index >= 0) pending.splice(index, 1);
		});
		track(disposer);
		return disposer;
	};

	const get: Context["get"] = (name) => services.get(name);

	const rootDispose = once(() => {
		for (const disposer of rootScope) disposer();
		rootScope.clear();
	});

	const dispose: Context["dispose"] = () => {
		rootDispose();
	};

	context = {
		on,
		emit,
		parallel,
		serial,
		bail,
		waterfall,
		effect,
		provide,
		inject,
		get,
		dispose,
	};

	return context;
}
