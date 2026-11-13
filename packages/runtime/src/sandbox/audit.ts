/**
 * 数据根权限**体检**（ADR-027 的 ③，M12a）：**只读检查 + 给出可复制的收紧命令**。
 *
 * ⚠️ **为什么只读、不动手**（这是实测出来的结论，不是保守）：M12a 实现期我先写了"真的用 `icacls` 收紧"的版本，
 * 实测立刻在临时目录上复现了**把用户自己锁在门外**的后果——`/inheritance:r` 之后**连测试自己都删不掉那个目录**
 * （`EPERM: operation not permitted, unlink`）。在**用户的数据根**上冒这个风险，正是 ADR-027 要避免的"假的安心"。
 * ⇒ 因此本层降级为：**检测 + 说清 + 把命令交到用户手里**，任何权限变更都由用户显式执行。
 *
 * 纪律：**绝不抛**、**绝不写**；做不到就把原因写清楚（非 Windows / 非 NTFS / 读不到 ACL）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/** 能力体检结果（**不是**"已加固"的宣告）。 */
export interface AclAudit {
	/** 现状是否已经"仅当前用户与系统账户可访问"（无继承项、无他人授权）。 */
	readonly tight: boolean;
	/** 可读原因（无论结论都给；含**查到了什么**）。 */
	readonly reason: string;
	/** 想收紧的话，**原样复制执行**的命令（我们替你动手这件事**显式不做**）。 */
	readonly hint: string;
}

/** icacls 的等待上限（只读查询，正常情况下毫秒级）。 */
const ACL_TIMEOUT_MS = 10_000;

/** 一次命令执行（可注入以便单测；缺省真跑 `icacls`）。 */
export type AclRunner = (args: readonly string[]) => {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly failed: boolean;
};

const defaultRunner: AclRunner = (args) => {
	try {
		const result = spawnSync("icacls", [...args], {
			timeout: ACL_TIMEOUT_MS,
			windowsHide: true,
			encoding: "utf8",
		});
		return {
			status: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			failed: result.error !== undefined,
		};
	} catch (error) {
		return { status: null, stdout: "", stderr: String(error), failed: true };
	}
};

/** 当前用户的主体名（`DOMAIN\user`；取不到就退回 `USERNAME`）。 */
export function currentPrincipal(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const user = env.USERNAME ?? env.USER;
	if (user === undefined || user.trim() === "") return undefined;
	const domain = env.USERDOMAIN;
	return domain !== undefined && domain.trim() !== "" ? `${domain}\\${user}` : user;
}

/** 想手动收紧时该跑的那条命令（`/T` 会连带子树，`/C` 遇错继续）。 */
export function tightenCommand(root: string, principal: string | undefined): string {
	const who = principal ?? "<当前用户>";
	return `icacls "${root}" /inheritance:r /grant:r "${who}:(OI)(CI)F" /T /C /Q`;
}

/** 明显"开放给所有人"的主体名（出现在 ACL 里就不算已收紧）。 */
const BROAD_PRINCIPALS: readonly string[] = [
	"Everyone",
	"BUILTIN\\Users",
	"NT AUTHORITY\\Authenticated Users",
	"Authenticated Users",
];

/**
 * 体检数据根（**只读**）。判定：
 *  ① 读不到 ACL（非 Windows / 非 NTFS / 无权限）→ `tight:false` + 说清原因；
 *  ② ACL 里有**继承条目** `(I)` → `tight:false`（授权随父目录浮动，不受本目录控制）；
 *  ③ ACL 里有 **Everyone / BUILTIN\Users / Authenticated Users** → `tight:false`；
 *  ④ 其余 → `tight:true`（只对当前用户与系统账户开放）。
 */
export function auditDataRootAcl(root: string, runner: AclRunner = defaultRunner): AclAudit {
	const principal = currentPrincipal();
	const hint = tightenCommand(root, principal);
	if (process.platform !== "win32") {
		return {
			tight: false,
			reason: "该体检只有 Windows 实现（icacls）；本平台不假装已收紧",
			hint: "",
		};
	}
	if (!existsSync(root)) {
		return { tight: false, reason: `数据根不存在，无法体检：${root}`, hint };
	}
	try {
		if (!statSync(root).isDirectory()) {
			return { tight: false, reason: `数据根不是目录，无法体检：${root}`, hint };
		}
	} catch (error) {
		return { tight: false, reason: `无法读取数据根属性：${String(error)}`, hint };
	}
	const read = runner([root]);
	if (read.failed || read.status !== 0) {
		const detail = (read.stderr.trim() || read.stdout.trim() || "icacls 执行失败").split("\n")[0];
		return { tight: false, reason: `读不到 ACL（无权限 / 非 NTFS？）：${detail}`, hint };
	}
	const output = read.stdout;
	if (output.includes("(I)")) {
		const sample = output
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.includes("(I)"));
		return {
			tight: false,
			reason: `存在**继承**条目 (I)，授权随父目录浮动${sample === undefined ? "" : `：${sample}`}`,
			hint,
		};
	}
	const broad = BROAD_PRINCIPALS.filter((name) => output.includes(name));
	if (broad.length > 0) {
		return { tight: false, reason: `ACL 里仍有面向他人/所有人的授权：${broad.join(", ")}`, hint };
	}
	return {
		tight: true,
		reason: `数据根未发现继承项与他人授权${principal === undefined ? "" : `（当前用户 ${principal}）`}`,
		hint,
	};
}
