/**
 * 桌面版「模型接入设置」的**纯逻辑**（M21，ADR-039）。
 *
 * 纪律：
 *  - 这是**桌面应用配置**，不是会话事实 ⇒ 只落 `<home>\desktop\chenxi-settings.json`，**绝不进 JSONL**；
 *  - 密钥**只以密文落盘**（Windows DPAPI，经 Electron `safeStorage`）；没有可用的加密能力就**拒绝保存**
 *    （绝不静默降级成明文）；
 *  - 本文件**不依赖 Electron**（加密能力由 `SecretBox` 注入）⇒ vitest 能直接测；
 *  - 任何返回值 / 错误信息**都不包含密钥**，界面只能看到 `hasKey`。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const SETTINGS_FORMAT = "chenxi-desktop-settings";
export const SETTINGS_VERSION = 1;
export const SETTINGS_FILENAME = "chenxi-settings.json";

/** 注入的最小加密能力（真实实现是 Electron `safeStorage`，测试里用假盒子）。 */
export interface SecretBox {
	readonly available: boolean;
	encrypt(plain: string): Buffer;
	decrypt(cipher: Buffer): string;
}

export interface ProviderSettingsInput {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly model: string;
}

/** 读出来的设置（`apiKey` 只在 main 进程内可见，**永不**发给 renderer）。 */
export interface LoadedProviderSettings {
	/** `none` = 没有文件；`file` = 读成功；`invalid` = 文件在但不可用。 */
	readonly source: "none" | "file" | "invalid";
	readonly baseUrl?: string;
	readonly model?: string;
	readonly apiKey?: string;
	readonly encryptionAvailable: boolean;
	/** 可读问题（invalid / 解密失败时）；**绝不**含密钥内容。 */
	readonly problem?: string;
}

/** 设置文件的绝对路径（`<home>\desktop\chenxi-settings.json`）。 */
export function settingsPath(home: string, filename: string = SETTINGS_FILENAME): string {
	return join(resolve(home, "desktop"), filename);
}

/** 归一化 Base URL：去空白、去尾部 `/`（避免拼出 `//chat/completions`）。 */
export function normalizeBaseUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

export type ValidatedInput =
	| { readonly ok: true; readonly value: ProviderSettingsInput }
	| { readonly ok: false; readonly error: string };

/** 校验界面输入（三个都空 = 清空设置；只填一部分 = 明确报错）。 */
export function validateProviderInput(input: ProviderSettingsInput): ValidatedInput {
	const baseUrl = normalizeBaseUrl(input.baseUrl ?? "");
	const apiKey = (input.apiKey ?? "").trim();
	const model = (input.model ?? "").trim();
	const blank = baseUrl === "" && apiKey === "" && model === "";
	if (blank) return { ok: false, error: "三项都为空（若要清空设置，请用「清除设置」）" };
	if (baseUrl === "") return { ok: false, error: "Base URL 不能为空" };
	if (!/^http(s)?:\/\//i.test(baseUrl))
		return { ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" };
	if (apiKey === "") return { ok: false, error: "API Key 不能为空" };
	if (model === "") return { ok: false, error: "模型不能为空" };
	return { ok: true, value: { baseUrl, apiKey, model } };
}

/** 读设置文件（失败**不抛**，返回 `invalid` + 可读原因；密钥解密失败也不让应用起不来）。 */
export function loadProviderSettings(options: {
	readonly home: string;
	readonly secretBox?: SecretBox;
}): LoadedProviderSettings {
	const encryptionAvailable = options.secretBox?.available === true;
	const file = settingsPath(options.home);
	if (!existsSync(file)) return { source: "none", encryptionAvailable };

	let doc: unknown;
	try {
		doc = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return { source: "invalid", encryptionAvailable, problem: "设置文件不是合法 JSON" };
	}
	if (typeof doc !== "object" || doc === null)
		return { source: "invalid", encryptionAvailable, problem: "设置文件根不是对象" };

	const record = doc as Record<string, unknown>;
	if (record.format !== SETTINGS_FORMAT)
		return { source: "invalid", encryptionAvailable, problem: "不是 Chenxi 桌面设置文件" };
	if (record.formatVersion !== SETTINGS_VERSION)
		return {
			source: "invalid",
			encryptionAvailable,
			problem: `设置文件版本不受支持（${String(record.formatVersion)}）`,
		};

	const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl : undefined;
	const model = typeof record.model === "string" ? record.model : undefined;
	const secret = record.apiKey;
	let apiKey: string | undefined;
	let problem: string | undefined;
	if (typeof secret === "object" && secret !== null) {
		const boxed = secret as Record<string, unknown>;
		if (boxed.scheme !== "windows-dpapi" || typeof boxed.ciphertext !== "string") {
			problem = "密钥字段形状不受支持";
		} else if (!encryptionAvailable) {
			problem = "当前环境不可用 DPAPI，密钥无法解密";
		} else {
			try {
				apiKey = options.secretBox?.decrypt(Buffer.from(boxed.ciphertext, "base64"));
			} catch {
				problem = "密钥无法解密（换 Windows 用户或换了机器？）";
			}
		}
	}
	return {
		source: "file",
		baseUrl,
		model,
		apiKey,
		encryptionAvailable,
		...(problem ? { problem } : {}),
	};
}

/** 由设置推出要注入的环境变量（三项齐全才返回；缺一项就当没配置，交给环境变量兜底）。 */
export function providerEnvFromSettings(
	loaded: LoadedProviderSettings,
): Record<string, string> | undefined {
	if (loaded.source !== "file") return undefined;
	const { baseUrl, apiKey, model } = loaded;
	if (baseUrl === undefined || baseUrl === "" || apiKey === undefined || model === undefined) {
		return undefined;
	}
	return { CHENXI_BASE_URL: baseUrl, CHENXI_API_KEY: apiKey, CHENXI_MODEL: model };
}

/** 可审计的一行（进启动横幅）：**只出现 baseUrl / model，永不出现密钥**。 */
export function describeProviderSettings(loaded: LoadedProviderSettings, file: string): string {
	if (loaded.source === "none")
		return "desktop settings: none (falls back to environment variables)";
	if (loaded.source === "invalid")
		return `desktop settings: invalid (${file}) — ${loaded.problem ?? "未知原因"}；回退到环境变量`;
	if (loaded.apiKey === undefined)
		return `desktop settings: ${file} (baseUrl=${loaded.baseUrl ?? "?"}, model=${
			loaded.model ?? "?"
		}, apiKey=unreadable) — 回退到环境变量`;
	return `desktop settings: ${file} (baseUrl=${loaded.baseUrl}, model=${loaded.model}, apiKey=encrypted)`;
}

export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** 保存设置（密钥加密后才落盘；没有加密能力 ⇒ 拒绝）。 */
export function saveProviderSettings(options: {
	readonly home: string;
	readonly input: ProviderSettingsInput;
	readonly secretBox: SecretBox;
}): SaveResult {
	const { input, secretBox } = options;
	const baseUrl = normalizeBaseUrl(input.baseUrl ?? "");
	const apiKey = (input.apiKey ?? "").trim();
	const model = (input.model ?? "").trim();
	if (baseUrl === "" && apiKey === "" && model === "") {
		const file = settingsPath(options.home);
		if (existsSync(file)) unlinkSync(file);
		return { ok: true };
	}
	const validated = validateProviderInput(input);
	if (!validated.ok) return validated;
	if (!secretBox.available)
		return { ok: false, error: "Windows DPAPI 不可用 ⇒ 拒绝保存明文密钥（请改用环境变量）" };
	const cipher = secretBox.encrypt(validated.value.apiKey);
	const file = settingsPath(options.home);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify(
			{
				format: SETTINGS_FORMAT,
				formatVersion: SETTINGS_VERSION,
				baseUrl: validated.value.baseUrl,
				model: validated.value.model,
				apiKey: { scheme: "windows-dpapi", ciphertext: cipher.toString("base64") },
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return { ok: true };
}

/** 发给 renderer 的**安全视图**（没有密钥、没有密文，只有"有没有"）。 */
export function publicSettingsView(loaded: LoadedProviderSettings): {
	readonly baseUrl: string;
	readonly model: string;
	readonly hasKey: boolean;
	readonly source: LoadedProviderSettings["source"];
	readonly encryptionAvailable: boolean;
	readonly problem?: string;
} {
	return {
		baseUrl: loaded.baseUrl ?? "",
		model: loaded.model ?? "",
		hasKey: loaded.apiKey !== undefined,
		source: loaded.source,
		encryptionAvailable: loaded.encryptionAvailable,
		...(loaded.problem === undefined ? {} : { problem: loaded.problem }),
	};
}
