/**
 * 测试临时目录 helper。
 *
 * 默认走系统临时目录；若设置了 `ASTER_TEST_TMP`（本机固定指向 D 盘，
 * 用于「绝不写 C 盘」的本地约束）则优先使用它。**不含任何写死的绝对路径**，
 * 保证将来开源时在任意机器上（含 CI）仍可正常运行。
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 解析测试临时根目录（优先 ASTER_TEST_TMP，其次系统临时目录）。 */
export function testTmpRoot(): string {
	const fromEnv = process.env.ASTER_TEST_TMP;
	const root = fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : tmpdir();
	mkdirSync(root, { recursive: true });
	return root;
}

/** 在测试临时根下创建一个唯一目录。 */
export function makeTempDir(prefix: string): string {
	return mkdtempSync(join(testTmpRoot(), prefix));
}
