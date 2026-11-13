/**
 * Unix 惯用法检测（判据 #11）：在 Windows/pwsh 下给出等价 PowerShell 写法。
 *
 * 纪律：**只提示、不硬失败**——检测到的命令照常交给 shell 执行。
 * 匹配一律使用**词边界** `\b`，避免 `list` 命中 `ls` 之类的子串误报。
 */

interface UnixismRule {
	readonly pattern: RegExp;
	readonly unix: string;
	readonly pwsh: string;
}

/** 常见 Unix 命令 -> PowerShell 等价写法。 */
const RULES: readonly UnixismRule[] = [
	{ pattern: /\bls\b/, unix: "ls", pwsh: "Get-ChildItem" },
	{ pattern: /\bcat\b/, unix: "cat", pwsh: "Get-Content" },
	{ pattern: /\brg\b/, unix: "rg", pwsh: "Select-String" },
	{ pattern: /\bgrep\b/, unix: "grep", pwsh: "Select-String" },
	{ pattern: /\bfind\b/, unix: "find", pwsh: "Get-ChildItem -Recurse" },
	{ pattern: /\bhead\b/, unix: "head", pwsh: "Select-Object -First" },
	{ pattern: /\btail\b/, unix: "tail", pwsh: "Select-Object -Last" },
	{ pattern: /\bwc\b/, unix: "wc", pwsh: "Measure-Object" },
	{ pattern: /\brm\b/, unix: "rm", pwsh: "Remove-Item" },
	{ pattern: /\bmkdir\b\s+-p\b/, unix: "mkdir -p", pwsh: "New-Item -ItemType Directory -Force" },
	{ pattern: /\btouch\b/, unix: "touch", pwsh: "New-Item" },
	{ pattern: /\bsed\b/, unix: "sed", pwsh: "-replace" },
	{ pattern: /\bps\b/, unix: "ps", pwsh: "Get-Process" },
];

/**
 * 检测命令中的 Unix 惯用法，返回**可读中文提示**数组；未命中返回 `[]`。
 *
 * @param command 待执行的原始命令文本。
 */
export function detectUnixisms(command: string): readonly string[] {
	const hints: string[] = [];
	for (const rule of RULES) {
		if (rule.pattern.test(command)) {
			hints.push(`检测到 Unix 惯用法：${rule.unix} — PowerShell 等价写法：${rule.pwsh}`);
		}
	}
	return hints;
}
