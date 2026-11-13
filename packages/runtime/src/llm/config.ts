/**
 * LLM 配置解析（只解析，不发请求）。
 *
 * 纪律：错误信息只回显**缺失的变量名**，绝不回显任何已提供的值（README 环境变量契约）。
 */
import { LlmConfigError, type LlmProviderConfig } from "./types.js";

/** 与 `process.env` 形状兼容的最小环境变量视图。 */
export interface EnvLike {
	readonly [key: string]: string | undefined;
}

const BASE_URL_KEY = "CHENXI_BASE_URL";
const API_KEY_KEY = "CHENXI_API_KEY";
const MODEL_KEY = "CHENXI_MODEL";

/** 读取并归一化单个变量：undefined / 空白 一律视为「缺失」。 */
function readVar(env: EnvLike, key: string): string | undefined {
	const raw = env[key];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * 从环境变量解析 provider 配置。
 *
 * - 缺任一项（含空串）→ `LlmConfigError`，`missing` 为缺失的变量名。
 * - `baseUrl` 去掉尾部 `/`（归一化，避免拼出 `//chat/completions`）。
 * - 抛出的错误**只包含变量名**，不含 `apiKey` 等任何值。
 */
export function resolveLlmConfig(env: EnvLike = process.env): LlmProviderConfig {
	const baseUrl = readVar(env, BASE_URL_KEY);
	const apiKey = readVar(env, API_KEY_KEY);
	const defaultModel = readVar(env, MODEL_KEY);

	const missing: string[] = [];
	if (baseUrl === undefined) missing.push(BASE_URL_KEY);
	if (apiKey === undefined) missing.push(API_KEY_KEY);
	if (defaultModel === undefined) missing.push(MODEL_KEY);
	if (missing.length > 0) {
		// 消息只由变量名拼成，天然不含任何值。
		throw new LlmConfigError(
			missing,
			`missing required environment variable(s): ${missing.join(", ")}`,
		);
	}

	return {
		baseUrl: (baseUrl as string).replace(/\/+$/, ""),
		apiKey: apiKey as string,
		defaultModel: defaultModel as string,
	};
}
