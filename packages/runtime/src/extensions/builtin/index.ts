/**
 * 内置示例扩展集合（ADR-004 扩展缝示范）。
 */
import type { Extension } from "../types.js";
import { createShortCircuitExtension } from "./short-circuit.js";
import { createExtensionTimeout } from "./timeout.js";

export * from "./short-circuit.js";
export * from "./timeout.js";

/** 示例：超时用 200ms；短路拦截名为 "probe" 的工具。 */
export function createExampleExtensions(): readonly Extension[] {
	return [
		createExtensionTimeout({ timeoutMs: 200 }),
		createShortCircuitExtension({
			toolName: "probe",
			value: { injected: true },
			reason: "example short-circuit",
		}),
	];
}
