/**
 * events 模块公共类型契约（ADR-004）。
 *
 * 设计要点：只保留 `waterfall + effect + inject` 三件套，
 * 不搬迁完整 DI 容器；一切注册经 `ctx.effect()` 纳入作用域，
 * 卸载时自动回滚（注册即 effect）。
 */

/** 反注册函数：撤销一次注册；约定**幂等**（重复调用无副作用）。 */
export type Disposer = () => void;

/** 通用事件监听器；接收派发时透传的全部实参。 */
export type EventHandler = (...args: unknown[]) => unknown;

/** waterfall 中间件的 `next`：调用即把控制权交予内层（下一个监听器或兜底函数）。 */
export type WaterfallNext = () => Promise<unknown>;

/**
 * waterfall 监听器签名：`(...data, next)`。
 * **不调用 `next()` 即短路**——后续监听器与兜底函数都不执行，直接返回自身结果。
 */
export type WaterfallHandler = (...args: [...unknown[], WaterfallNext]) => unknown;

/** `on` 的注册选项。 */
export interface RegisterOptions {
	/** true 表示插到最前（更外层、更早执行）。 */
	prepend?: boolean;
}

/** `inject` 的处理函数签名。 */
export type InjectCallback = (services: Record<string, unknown>, ctx: Context) => Disposer | void;

export interface Context {
	/** 注册监听器，返回反注册函数。 */
	on(event: string, handler: EventHandler, options?: RegisterOptions): Disposer;
	/** 同步派发，忽略返回值。 */
	emit(event: string, ...args: unknown[]): void;
	/** 并发执行全部监听器，等待全部完成。 */
	parallel(event: string, ...args: unknown[]): Promise<void>;
	/** 串行执行全部监听器，等待全部完成。 */
	serial(event: string, ...args: unknown[]): Promise<void>;
	/** 短路派发：返回**首个**非 undefined 的返回值。 */
	bail<T = unknown>(event: string, ...args: unknown[]): T | undefined;
	/**
	 * 中间件式派发。约定：监听器签名为 `(...data, next)`，其中 next 为「继续向内委派」的回调。
	 * - 调用 `next()` -> 执行下一个监听器；全部监听器跑完后执行**兜底函数**。
	 * - **不调用 `next()` 即短路**：后续监听器与兜底函数都不执行，直接返回该监听器自己的返回值。
	 * - 返回最终结果（Promise）。
	 */
	waterfall<T = unknown>(event: string, ...args: unknown[]): Promise<T>;
	/**
	 * 注册即 effect：执行 callback，把 callback 期间由 ctx 创建的一切可反注册对象
	 * （on/provide/effect/inject 的返回值）自动纳入本次 effect 的作用域；callback 自身
	 * 返回的 Disposer（若有）也会被执行。返回一个综合 Disposer，调用后本次注册
	 * **全部回滚且幂等**（重复调用无副作用）。
	 */
	effect(callback: () => Disposer | void): Disposer;
	/** 注册一个服务（供 inject 取用），返回反注册函数。 */
	provide(name: string, value: unknown): Disposer;
	/**
	 * 注入：当 names 中的所有服务都已 provide 时，同步执行 callback。
	 * callback 返回 Disposer 或 void；返回值被纳入一个 Disposer 返回。
	 * 若服务尚未就绪，则登记等待，待其 provide 时同步触发。
	 */
	inject(names: string[], callback: InjectCallback): Disposer;
	/** 取出已注册的服务。 */
	get(name: string): unknown;
	/** 反注册本上下文创建的一切（all listeners/providers/injects），幂等。 */
	dispose(): void;
}
