/**
 * 模型接入设置的 Electron 侧（M21，ADR-039）：把**纯逻辑**（`provider-settings.ts`）接到
 * `safeStorage`（Windows DPAPI）与 IPC 上。
 *
 * 三条边界：
 *  - **启动前注入**：`applyDesktopProviderSettings` 只写 `process.env`（进程内），不动系统环境、不 `setx`；
 *    桌面设置存在时**优先于**继承来的环境变量（用界面显式配置的人期望它生效）；
 *  - **密钥不过 IPC**：`settings:get` 只回 `hasKey`；密钥只在 main 进程里解密；
 *  - **保存后要重启**：provider 在 `bootstrapSessionRuntime` 装配期解析 ⇒ 改配置需要重装配，
 *    最可靠的做法是**重启应用**（`app.relaunch()`），而不是在运行时里热换 provider。
 */
import { app, ipcMain, safeStorage } from "electron";
import {
	describeProviderSettings,
	loadProviderSettings,
	normalizeBaseUrl,
	type ProviderSettingsInput,
	providerEnvFromSettings,
	publicSettingsView,
	type SaveResult,
	type SecretBox,
	saveProviderSettings,
	settingsPath,
} from "./provider-settings.js";

/** 真实加密能力：Windows 上底层就是 DPAPI（当前用户绑定）。 */
export function createSafeStorageBox(): SecretBox {
	return {
		get available() {
			try {
				return safeStorage.isEncryptionAvailable();
			} catch {
				return false;
			}
		},
		encrypt: (plain) => safeStorage.encryptString(plain),
		decrypt: (cipher) => safeStorage.decryptString(cipher),
	};
}

/**
 * 启动时应用设置：三项齐全 ⇒ 注入 `process.env`（**只在本进程**）。
 * 返回给启动横幅的一行（只含 baseUrl / model，**绝不含密钥**）。
 */
export function applyDesktopProviderSettings(options: {
	readonly home: string;
	readonly secretBox: SecretBox;
}): string {
	const loaded = loadProviderSettings({ home: options.home, secretBox: options.secretBox });
	const env = providerEnvFromSettings(loaded);
	if (env !== undefined) {
		process.env.ASTER_BASE_URL = env.ASTER_BASE_URL;
		process.env.ASTER_API_KEY = env.ASTER_API_KEY;
		process.env.ASTER_MODEL = env.ASTER_MODEL;
	}
	return describeProviderSettings(loaded, settingsPath(options.home));
}

/** IPC 边界：**绝不信任 renderer**，只接受形状正确的字符串。 */
function readInput(raw: unknown): ProviderSettingsInput | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const pick = (key: string): string =>
		typeof record[key] === "string" ? (record[key] as string) : "";
	return { baseUrl: pick("baseUrl"), apiKey: pick("apiKey"), model: pick("model") };
}

export interface ConnectionTest {
	readonly ok: boolean;
	readonly message: string;
}

/**
 * 真的发一次最小请求（`POST /chat/completions`，`max_tokens: 1`）：
 * 同时验证 Base URL、密钥与模型名；任何情况都**只回状态与截断后的响应体**。
 */
export async function testConnection(
	input: ProviderSettingsInput,
	options: { readonly home: string; readonly secretBox: SecretBox },
): Promise<ConnectionTest> {
	const baseUrl = normalizeBaseUrl(input.baseUrl);
	const model = input.model.trim();
	const typedKey = input.apiKey.trim();
	// 允许"沿用已保存的密钥"：界面上不重复输入
	const apiKey =
		typedKey !== ""
			? typedKey
			: (loadProviderSettings({ home: options.home, secretBox: options.secretBox }).apiKey ?? "");
	if (baseUrl === "" || model === "" || apiKey === "")
		return { ok: false, message: "Base URL / API Key / 模型都要填齐才能测试" };
	if (!/^http(s)?:\/\//i.test(baseUrl))
		return { ok: false, message: "Base URL 必须以 http:// 或 https:// 开头" };
	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				stream: false,
			}),
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			const body = await response.text();
			return {
				ok: false,
				message: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}：${body
					.replace(/\s+/g, " ")
					.slice(0, 200)}`,
			};
		}
		const payload = (await response.json().catch(() => null)) as { model?: unknown } | null;
		const echoed = typeof payload?.model === "string" ? payload.model : model;
		return { ok: true, message: `连接成功（model=${echoed}）` };
	} catch (error) {
		return {
			ok: false,
			message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** 注册四个频道（只由 main 调用一次）。频道名由 main 传入 ⇒ **唯一来源仍是 `main.ts` 的 CHANNELS**。 */
export interface SettingsChannels {
	readonly get: string;
	readonly save: string;
	readonly test: string;
	readonly restart: string;
}

export function registerSettingsIpc(options: {
	readonly home: string;
	readonly secretBox: SecretBox;
	readonly channels: SettingsChannels;
}): void {
	ipcMain.handle(options.channels.get, () =>
		publicSettingsView(loadProviderSettings({ home: options.home, secretBox: options.secretBox })),
	);
	ipcMain.handle(options.channels.save, (_event, raw: unknown): SaveResult => {
		const input = readInput(raw);
		if (input === null) return { ok: false, error: "参数形状不对" };
		return saveProviderSettings({ home: options.home, input, secretBox: options.secretBox });
	});
	ipcMain.handle(options.channels.test, async (_event, raw: unknown) => {
		const input = readInput(raw);
		if (input === null) return { ok: false, message: "参数形状不对" };
		return testConnection(input, options);
	});
	ipcMain.handle(options.channels.restart, () => {
		// 配置在装配期解析 ⇒ 重启应用是最可靠的生效方式（会话文件不受影响）
		app.relaunch();
		app.exit(0);
		return true;
	});
}
