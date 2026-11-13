/**
 * M21（ADR-039）：桌面模型接入设置的**纯逻辑**回归。
 *
 * 这条路径的承诺是「密钥只以密文落盘、任何出口都不含密钥」——所以测试的核心不是"能读写"，
 * 而是**明文绝不出现在文件里、也绝不出现在任何返回值里**。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeProviderSettings,
	loadProviderSettings,
	normalizeBaseUrl,
	providerEnvFromSettings,
	publicSettingsView,
	type SecretBox,
	saveProviderSettings,
	settingsPath,
	validateProviderInput,
} from "../src/provider-settings.js";

const SECRET = "sk-test-do-not-leak-1234567890";

/** 假加密盒子：真实现是 Windows DPAPI；这里只验证"密文落盘 + 能解回"。 */
function fakeBox(available = true): SecretBox {
	return {
		available,
		encrypt: (plain) =>
			Buffer.from(`dpapi:${Buffer.from(plain, "utf8").toString("base64")}`, "utf8"),
		decrypt: (cipher) => {
			const text = cipher.toString("utf8");
			if (!text.startsWith("dpapi:")) throw new Error("bad ciphertext");
			return Buffer.from(text.slice("dpapi:".length), "base64").toString("utf8");
		},
	};
}

const homes: string[] = [];
function makeHome(): string {
	const home = mkdtempSync(join(tmpdir(), "aster-m21-"));
	homes.push(home);
	return home;
}

/** 直接铺一份"坏文件"（父目录先建好，模拟用户手改过的现场）。 */
function writeRaw(home: string, text: string): string {
	const file = settingsPath(home);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text, "utf8");
	return file;
}

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("设置文件位置与归一化", () => {
	it("落在 <home>\\desktop\\aster-settings.json（与 Electron 内部路径同根、在 D 盘）", () => {
		const home = makeHome();
		const file = settingsPath(home);
		expect(file.endsWith(join("desktop", "aster-settings.json"))).toBe(true);
		expect(file.startsWith(home)).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	it("Base URL 去空白与尾部斜杠（避免 //chat/completions）", () => {
		expect(normalizeBaseUrl("  https://api.example.com/v1/// ")).toBe("https://api.example.com/v1");
		expect(normalizeBaseUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
	});
});

describe("输入校验", () => {
	it("三项都空 ⇒ 明确提示用「清除设置」（不当作保存成功）", () => {
		const result = validateProviderInput({ baseUrl: "", apiKey: "", model: "" });
		expect(result.ok).toBe(false);
	});

	it("只填一部分 ⇒ 指出缺哪项", () => {
		expect(validateProviderInput({ baseUrl: "https://x.example", apiKey: "", model: "m" })).toEqual(
			{
				ok: false,
				error: "API Key 不能为空",
			},
		);
		expect(
			validateProviderInput({ baseUrl: "https://x.example", apiKey: SECRET, model: "" }),
		).toEqual({
			ok: false,
			error: "模型不能为空",
		});
	});

	it("非 http(s) 的 Base URL 一律拒绝", () => {
		expect(
			validateProviderInput({ baseUrl: "file:///etc/passwd", apiKey: SECRET, model: "m" }).ok,
		).toBe(false);
		expect(
			validateProviderInput({ baseUrl: "api.example.com", apiKey: SECRET, model: "m" }).ok,
		).toBe(false);
	});

	it("三项齐全（含归一化）⇒ 通过", () => {
		const result = validateProviderInput({
			baseUrl: "https://api.example.com/v1/",
			apiKey: `  ${SECRET}  `,
			model: " gpt-4o-mini ",
		});
		expect(result).toEqual({
			ok: true,
			value: { baseUrl: "https://api.example.com/v1", apiKey: SECRET, model: "gpt-4o-mini" },
		});
	});
});

describe("保存 / 读取：密钥只以密文落盘", () => {
	it("保存后文件里**没有明文密钥**，读取能解回", () => {
		const home = makeHome();
		const box = fakeBox();
		const saved = saveProviderSettings({
			home,
			input: { baseUrl: "https://api.example.com/v1/", apiKey: SECRET, model: "gpt-4o-mini" },
			secretBox: box,
		});
		expect(saved.ok).toBe(true);

		const text = readFileSync(settingsPath(home), "utf8");
		expect(text).not.toContain(SECRET);
		expect(text).toContain("windows-dpapi");

		const loaded = loadProviderSettings({ home, secretBox: box });
		expect(loaded.source).toBe("file");
		expect(loaded.baseUrl).toBe("https://api.example.com/v1");
		expect(loaded.model).toBe("gpt-4o-mini");
		expect(loaded.apiKey).toBe(SECRET);
	});

	it("没有加密能力 ⇒ **拒绝保存**，磁盘上不产生文件（绝不降级成明文）", () => {
		const home = makeHome();
		const saved = saveProviderSettings({
			home,
			input: { baseUrl: "https://x.example", apiKey: SECRET, model: "m" },
			secretBox: fakeBox(false),
		});
		expect(saved.ok).toBe(false);
		expect(existsSync(settingsPath(home))).toBe(false);
	});

	it("DPAPI 不可用时读文件**不抛**：返回 file + problem，密钥缺席", () => {
		const home = makeHome();
		saveProviderSettings({
			home,
			input: { baseUrl: "https://x.example", apiKey: SECRET, model: "m" },
			secretBox: fakeBox(),
		});
		const loaded = loadProviderSettings({ home, secretBox: fakeBox(false) });
		expect(loaded.source).toBe("file");
		expect(loaded.apiKey).toBeUndefined();
		expect(loaded.problem).toContain("DPAPI");
	});

	it("密文被篡改 ⇒ 解密失败也不抛，problem 可读", () => {
		const home = makeHome();
		const file = settingsPath(home);
		const box = fakeBox();
		saveProviderSettings({
			home,
			input: { baseUrl: "https://x.example", apiKey: SECRET, model: "m" },
			secretBox: box,
		});
		const doc = JSON.parse(readFileSync(file, "utf8"));
		doc.apiKey.ciphertext = Buffer.from("plain-text-not-dpapi", "utf8").toString("base64");
		writeFileSync(file, JSON.stringify(doc), "utf8");

		const loaded = loadProviderSettings({ home, secretBox: box });
		expect(loaded.source).toBe("file");
		expect(loaded.apiKey).toBeUndefined();
		expect(loaded.problem).toContain("无法解密");
	});

	it("三项全空 = 清除：删掉文件并回到 none", () => {
		const home = makeHome();
		const box = fakeBox();
		saveProviderSettings({
			home,
			input: { baseUrl: "https://x.example", apiKey: SECRET, model: "m" },
			secretBox: box,
		});
		expect(existsSync(settingsPath(home))).toBe(true);
		expect(
			saveProviderSettings({ home, input: { baseUrl: "", apiKey: "", model: "" }, secretBox: box }),
		).toEqual({
			ok: true,
		});
		expect(existsSync(settingsPath(home))).toBe(false);
		expect(loadProviderSettings({ home, secretBox: box }).source).toBe("none");
	});
});

describe("坏文件：宁可报 invalid 也不拖垮启动", () => {
	it("不是合法 JSON", () => {
		const home = makeHome();
		writeRaw(home, "{oops");
		const loaded = loadProviderSettings({ home, secretBox: fakeBox() });
		expect(loaded.source).toBe("invalid");
		expect(loaded.problem).toContain("JSON");
	});

	it("不是我们的格式", () => {
		const home = makeHome();
		writeRaw(home, JSON.stringify({ format: "other" }));
		expect(loadProviderSettings({ home, secretBox: fakeBox() }).source).toBe("invalid");
	});

	it("版本不受支持", () => {
		const home = makeHome();
		writeRaw(home, JSON.stringify({ format: "aster-desktop-settings", formatVersion: 9 }));
		const loaded = loadProviderSettings({ home, secretBox: fakeBox() });
		expect(loaded.source).toBe("invalid");
		expect(loaded.problem).toContain("版本");
	});
});

describe("注入环境变量与对外视图", () => {
	it("三项齐全才注入；缺密钥就不注入（交给环境变量兜底）", () => {
		const box = fakeBox();
		const home = makeHome();
		saveProviderSettings({
			home,
			input: { baseUrl: "https://x.example", apiKey: SECRET, model: "m" },
			secretBox: box,
		});
		expect(providerEnvFromSettings(loadProviderSettings({ home, secretBox: box }))).toEqual({
			ASTER_BASE_URL: "https://x.example",
			ASTER_API_KEY: SECRET,
			ASTER_MODEL: "m",
		});

		const noKey = loadProviderSettings({ home, secretBox: fakeBox(false) });
		expect(providerEnvFromSettings(noKey)).toBeUndefined();
	});

	it("发给界面的是安全视图：**没有 apiKey、没有密文**，只有 hasKey", () => {
		const home = makeHome();
		const box = fakeBox();
		saveProviderSettings({
			home,
			input: { baseUrl: "https://x.example", apiKey: SECRET, model: "m" },
			secretBox: box,
		});
		const view = publicSettingsView(loadProviderSettings({ home, secretBox: box }));
		expect(view).toEqual({
			baseUrl: "https://x.example",
			model: "m",
			hasKey: true,
			source: "file",
			encryptionAvailable: true,
		});
		expect(JSON.stringify(view)).not.toContain(SECRET);
		expect("apiKey" in view).toBe(false);
	});

	it("启动横幅只出现 baseUrl / model，**永不出现密钥**", () => {
		const home = makeHome();
		const box = fakeBox();
		saveProviderSettings({
			home,
			input: { baseUrl: "https://x.example", apiKey: SECRET, model: "m" },
			secretBox: box,
		});
		const line = describeProviderSettings(
			loadProviderSettings({ home, secretBox: box }),
			settingsPath(home),
		);
		expect(line).toContain("https://x.example");
		expect(line).toContain("m");
		expect(line).toContain("apiKey=encrypted");
		expect(line).not.toContain(SECRET);
	});
});
