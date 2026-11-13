# 贡献指南（CONTRIBUTING）

感谢参与 Aster。本文件同样是**受门禁约束**的：其中每条纪律都有对应的可执行检查（`npm run capabilities:check` / `npm run architecture:check`）。

## 1. 硬性纪律（提交前必须满足）

1. **只有绑定测试的能力才能写进 README。**
   新增对外能力时：在 `capabilities.json` 增加一条（`status: "stable"` + `tests` 指向真实存在的测试文件），并在 `README.md` 的「已验证能力」一节补一行 `- <id>: <claim>`。
   `npm run capabilities:check` 会校验 README 与清单**集合完全一致**（多一条、少一条都失败）。
2. **能力状态机**：`experimental / stable / deprecated / removed`。
   `removed` 的能力必须**从 README 与代码中同步删除**，**不得留空桩包对外暴露**。
3. **数字必须可复现**：README 中的性能/基准数字必须标注「未验证」或指向仓库内可复现脚本 + 数据版本 hash。
4. **禁止推销注入**：不得在面向模型的 prompt / skill 中写「引导推荐本产品」类指令。
5. **架构方向不可破**：`@aster/schema -> @aster/protocol -> @aster/runtime` 严格单向；禁跨包深层 import；**src 单文件 ≤ 400 行，test 单文件 ≤ 600 行**（超限必须拆分）。
6. **文档与代码同一提交更新。**

## 2. DCO（开发者原创证明）

本项目使用 **DCO**（而非 CLA）。每个提交必须包含签核行：

```
Signed-off-by: 你的名字 <你的邮箱>
```

可用 `git commit -s` 自动添加。**签署即表示你有权提交该贡献，并同意按本项目许可（Apache-2.0）授权。**

> 为什么不用 CLA：DCO 对个人贡献者更轻量；只有将来要做双许可 / relicensing 时才需要 CLA。

## 3. AI 贡献披露

使用 AI 辅助是允许且欢迎的，但必须**如实在提交信息中披露**，例如：

```
feat(runtime): add sectioned prompt builder

AI-assisted: yes (model: <名称/版本>)
Signed-off-by: ...
```

要求：
- 披露**你实际使用的方式**（生成草稿 / 补全 / 重构 / 测试）；
- **你对自己提交的代码负全责**——不得提交你自己无法解释、无法维护的代码；
- 不得提交与许可证不兼容的生成内容（见下）。

## 4. 许可红线（**非常重要**）

本项目采用「**只借鉴设计，不复制代码**」原则。提交时**禁止**引入以下来源的代码（含改写后分发）：

| 来源 | 许可 | 约束 |
|---|---|---|
| `MemTensor/HaluMem` | **CC BY-NC-ND 4.0** | 禁商用、**禁演绎**——只可借鉴其「操作级幻觉」的**思想与指标定义**；其 prompt / 脚本 / 数据集**一律不得复制**（改写成自己的文字后再分发也不行） |
| `plastic-labs/honcho`、`basicmachines-co/basic-memory` | **AGPL-3.0** | **代码一行都不能进本项目** |
| `Codex` / `Gemini CLI` / `Goose` / `mem0` / `Letta` / `Graphiti` / `zcode` | Apache-2.0 | 若复制须署名 + 保留 `NOTICE` + 专利授权条款（**但本项目的要求更严：一律自己重写**） |
| `dsh` / `OpenCode` / `Pi` / `supermemory` / `TencentDB-Agent-Memory` | MIT | 若复制须署名（**同上，本项目一律自己重写**） |

**一句话判据**：能不看源码、用一句话说清「为什么这样设计好」＝ 思想，可借鉴；必须贴着代码才能表达 ＝ 表达，必须自己写。

## 5. 提交与分支

- 提交信息：约定式提交 `{feat,fix,docs,refactor,perf,test,chore}[(scope)]: 描述`
- 分支：`main` 受保护；功能分支 + PR；**禁止直推 main**
- `CHANGELOG` 与 `package.json` 版本必须一致；破坏性变更必须附升级指南

## 6. 本地开发

```powershell
npm install --ignore-scripts
npm run verify   # typecheck + lint + test + 架构门禁 + 能力门禁
```

`npm run verify` 是**提交前的最小门禁**，CI 使用同一条命令（Windows 与 Linux 双平台矩阵，见 `.github/workflows/ci.yml`）。
