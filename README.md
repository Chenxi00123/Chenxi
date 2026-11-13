# Aster

> 一个 **Windows-only、可审计、功能实用、持续优化** 的本地 agent harness（不追求"最小"）。
> **v1.0.0 交付可安装的日用版**：事件溯源会话（**JSONL 事实源 + SQLite 派生索引**）+ 4 原语工具（**bash / pwsh 双 shell**）+ **默认双模式（plan / build）** + 元数据驱动权限 + **可交互审批（`y`/`a`/`n`）** + **分层本地配置** + **MCP stdio 工具加载** + **记忆注入缝（`before_turn`）** + **子代理（独立会话 `task` 工具，支持 `fork` / `background`）** + **版本化会话交换格式（`--export` / `--import`）** + **版本化记忆交换格式（`--export-memory` / `--import-memory`，ADR-030）** + **差分渲染 TUI（`--tui`）** + **client/server（`--serve` 事件流与回放 / `--attach` 只读镜像 / `POST /api/sessions/:id/prompt` 远端写）** + **环境自检（`--doctor`）** + **keyless 录制回放（--record / --replay，experimental）** + waterfall 扩展缝。

**本文件受 CI 门禁约束**：下面「已验证能力」一节里每一条都绑定仓库内的测试文件（`capabilities.json` + `tools/check-capabilities.mjs`）。**没有 CI 断言的能力不得写进本文件**。

---

## 1. 环境前提

| 项 | 要求 |
|---|---|
| Node.js | `>= 22.19`（本机实测 v22.23.2）。ESM。 |
| SQLite | 使用 Node 内置 `node:sqlite`（实验性），**无需原生编译依赖** |
| 平台 | **首发支持 Windows**（`bash` 工具自动走 pwsh 后端）；类 Unix 走 bash |
| 模型端点 | 任选一个 OpenAI 兼容端点（见下） |

## 2. 快速开始

```powershell
# 安装依赖（直接外部依赖钉死精确版本，禁止生命周期脚本）
npm install --ignore-scripts

# 类型检查 / 测试 / 静态检查 / 门禁
npm run verify
```

配置模型端点（**只经环境变量传入；key 不写入会话日志、不打印**）：

| 环境变量 | 含义 | 示例 |
|---|---|---|
| `ASTER_BASE_URL` | OpenAI 兼容 endpoint | `https://api.deepseek.com/v1` |
| `ASTER_API_KEY` | API key（**不会落盘、不会被打印**） | `sk-...` |
| `ASTER_MODEL` | 模型 id | `deepseek-chat` |
| `ASTER_HOME` | 数据目录（会话 JSONL 与索引），默认 `~/.aster` | `d:\aster-home` |

**不需要密钥也能跑（keyless 演示）**：

```powershell
# 脚本化「读文件 -> 总结」的完整闭环
npm run cli -- --home .\.aster --demo-read package.json

# 现场复现 plan/build 的权限差异：plan 拒写，/mode build 后通过
npm run cli -- --home .\.aster --demo-write demo-out.txt

# 纯流式回放（桩 provider）
npm run cli -- --home .\.aster --stub "hello from stub"

# 扩展缝：加载中间件即可注入超时、或短路内置行为（**主循环一行不改**）
npm run cli -- --home .\.aster --mode build --demo-bash "Start-Sleep -Seconds 5" --ext-timeout 400
npm run cli -- --home .\.aster --mode build --demo-bash "Write-Output hi" --ext-short-circuit bash
```

> 提示：默认启动模式是 **plan**（写类工具一律 `deny`）。演示 `bash` 相关能力时请加 `--mode build`，或在会话内用 `/mode build` 切换。

会话维护与**可移植**（ADR-019）：

```powershell
npm run cli -- --home .\.aster --list
npm run cli -- --home .\.aster --resume <sessionId>    # 也可用 --resume latest 续上最近一次
npm run cli -- --home .\.aster --rebuild-index   # 由 JSONL 全量重建派生索引
npm run cli -- --home .\.aster --doctor          # 环境自检（关键项全通过 exit 0，否则 exit 1）
npm run cli -- --home .\.aster --acp             # ACP agent 侧最小通道（stdin/stdout JSON-RPC；experimental，ADR-036）
npm run cli -- --home .\.aster --mcp-prompts <server>    # 列出该 MCP 服务端的提示词（不进 REPL）
npm run cli -- --home .\.aster --mcp-resources <server>  # 列出该 MCP 服务端的资源（不进 REPL）

npm run cli -- --home .\.aster --export latest --out session.aster.json   # 版本化交换文档（无损）
npm run cli -- --home .\.aster --export <id> --format claude-code --out s.jsonl
npm run cli -- --home .\.aster --import session.aster.json                # 导入＝新建会话，打印新 sessionId
npm run cli -- --home .\.aster --import s.jsonl --format claude-code
```

`--format` 取 `aster`（缺省）/ `claude-code` / `zcode`；`--export` 必须给 `--out`，两者都**不进 REPL**。

**记忆**交换（ADR-030，兑现主张 4 的**记忆侧**）：

```powershell
# 把配置的记忆层（经 MCP 外挂，只读）导出为版本化文档；缺省作用域 = 最近更新的已记录会话
npm run cli -- --home .\.aster --export-memory --out memory.aster.json
npm run cli -- --home .\.aster --export-memory --out memory.aster.json --memory-session <sessionId>

# 校验一份记忆交换文档，并可选地规范化重写成 canonical 形式（未声明键剥掉）
npm run cli -- --home .\.aster --import-memory memory.aster.json
npm run cli -- --home .\.aster --import-memory received.json --out normalized.json
```

`--export-memory` 必须给 `--out`，未配置 `memory.{server,searchTool}` 时**快速失败**并打印已查过的配置文件路径。
⚠️ **`--import-memory` 不写记忆层**：`MemoryAdapter.add` 按 ADR-016 **显式推迟** ⇒ 本命令只做
**校验 + 规范化（可选 `--out` 落盘）**，并每次打印这句话（不许让人以为"导进去了"）；
记忆层写入路径**绝不**在这里被顺手打开。两者都**不进 REPL**。

### 差分渲染 TUI（可选，ADR-020）

```powershell
npm run cli -- --home .\.aster --tui            # 全屏差分渲染前端（深色极简配色）
npm run cli -- --home .\.aster --tui --no-color # 关闭上色（等价于设置 NO_COLOR=1）
```

`--tui` 只在 **stdout 与 stdin 都是 TTY** 时生效；否则打印一行提示并**回落**朴素 REPL（不假装能画）。
界面：状态条（`aster` · 模式 · **回合内指示（仅回合进行中）** · cwd · 模型 · 会话 id）／细分隔线／**下对齐**的会话视图／输入行。

> ⚠️ **本版本交付 TUI 的"机制面 + 结构化驱动 + 基础交互 + 多行编辑 + 富文本 / 回合内指示"**：用户 2026-10-15 首次真机验收判定「**只是雏形，距离完整版还差得远**」。
> 已交付 = 差分重绘 / 同步输出 / 合帧 / 全角列宽 / alt screen 还原 / 深色极简配色 / **会话事实改由结构化事件驱动（ADR-023，M10b-1）** / **Tab 补全 + 鼠标（ADR-024，M10b-2）** / **多行编辑器 + 括号粘贴（ADR-025，M10b-3）** / **富文本正文 + 工具结果折叠 + 回合内指示（ADR-026，M10b-4）** / **resize・IME 前提・审批交互的实测项**。
> **未交付** = **配色打磨轮次（需用户真机参与，排在最后）**。见方案包 `06` 的 **M10b 子批清单**。
> 用户那次「差得远」的判定**并未被本批推翻**：观感仍需用户肉眼验收（以下都是可自动断言的结构 / 行为性质，不是"好看"的证明）。

按键：`Enter` 提交整份草稿、`Ctrl+J` / `Alt+Enter` **草稿内换行**（粘贴多行自动按草稿）、`Tab` 补全（命令 / 参数 / 路径）、
`↑`/`↓` 草稿内移动（到边界翻历史）、`PageUp`/`PageDown` 滚动、**滚轮滚动**、**左键点输入区定位插入点**、
**左键点工具结果行**切换这一条的展开、**`Ctrl+O`** 全部展开 / 收起工具结果、
`Ctrl+C` 中止当前回合（第二次退出）、`Ctrl+D` 退出、`Ctrl+U` 清空整份草稿。
鼠标只上报**点击与滚轮**（**不跟踪拖拽** ⇒ 终端原生选中复制不受影响；个别终端需按住 `Shift` 拖动）。
渲染是**行级差分**的（只重画变化区段，不闪），并被**同步输出**包裹；
流式输出**合帧**渲染（窗口 16ms，**可复现**：`tui/screen.ts` 的 `MIN_RENDER_INTERVAL_MS`），输入回显立即刷新。
工具结果**默认折叠**成一行（`← tool_result: read ok · 5 行 · 折叠`）；展开只改**视图**，**不写入会话文件**。
回合进行中状态条显示 `◐ 1.3s (local)`——秒数**来自本机时钟**（`(local)` 就是这个意思），不是事件里的字段。

### keyless 录制回放（**experimental**，ADR-037）

```powershell
# 录制一次真实会话（需要可用的模型端点）
npm run cli -- --home .\.aster --record .\.aster\cassettes\demo.jsonl
# 完全离线回放：不需要 API key、不访问网络
npm run cli -- --home .\.aster --replay .\.aster\cassettes\demo.jsonl
```

cassette = **版本化 JSONL**（首行 header，之后每条 LLM 往返一行：请求快照 + 流式事件 + complete/error）。
回放按「**派生消息 + 工具描述 + 模型**」的完整请求哈希**严格匹配**；未命中 / 队列耗尽一律 **fail-closed**，绝不伪造模型输出。
`--record` 与 `--replay` 互斥；`--replay` 也不与 `--stub` / `--demo-*` 组合；`--record` **拒绝覆盖**已存在的文件。
⚠️ **边界**：回放要求**相同的 cwd / mode / 工具配置**（这些都在请求哈希里）；cassette **不含任何密钥**。
录制源目前只在**本地 OpenAI-compatible fixture** 上验证过，**尚未录制真实厂商会话** ⇒ 标 `experimental`，不进「已验证能力」清单。

### 桌面版（**experimental**，ADR-029，M13a 只读窗口 → M13b 可交互会话）

```powershell
.\bin\aster-desktop.cmd            # 打开 Aster 桌面窗口（数据根 = 仓库内 .aster；零 PATH 改动）
.\bin\aster-desktop.cmd --self-check   # 端到端自检：在真窗口里真的发一条 prompt 并断言「列表/卡片/CSP/数据根不在 C 盘」后退出
```

> **先装 Electron 二进制**（仓库按供应链纪律设了 `ignore-scripts=true`，所以这一步是**显式**的；
> 若本机 npm 的 `.ps1` 被策略禁用，把 `npm install` 换成 `node "<npm-cli.js 的完整路径>" install` 即可）：
> ```powershell
> npm install
> $env:ELECTRON_CACHE="D:\electron-cache"; $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> node node_modules/electron/install.js
> ```
> （`ELECTRON_MIRROR` 走国内镜像；缓存与二进制都落在 **D 盘** ⇒ 不碰 C 盘。CI/离线环境请先备好二进制。）

**它能做什么（M13d）**：① 列出**同一个数据根**里的会话（CLI 跑的也能看到）、点开一条会话看它的**已记录事件**（结构化卡片，不是终端文本）；
①' **续跑旧会话**（M13d-1）：列表里每条会话带「恢复」按钮——与 CLI 的 `--resume <sessionId>` **同一份语义**，恢复后继续发的 prompt 落进**同一条 JSONL**（同一 sessionId、seq 接着往下排）；
② **发 prompt**（输入框 `Enter` 发送、`Shift+Enter` 换行）——会话在 **main 进程内**跑 `runSessionRepl`（与 CLI/TUI **同一份实现**），
写入**仍只经 persist 单一写入路径**；③ **审批弹窗**（越界操作现场征询 `y`=允许一次 / `a`=本次会话始终允许 / `n`=拒绝，语义与 CLI **完全一致**，
判定照旧落 `permission/decision`）；④ **模式切换**（`plan`/`build`，走既有 `/mode` 路径 ⇒ `mode/changed` 事件）；⑤ **中断当前回合**按钮（合成 SIGINT）；
⑥ **工具结果卡片**（M13d-2）：工具返回的**对象/数组**按 JSON 缩进、字符串按行显示（不再出现 `[object Object]`），**多行的默认折叠**、**点卡头展开 / 收起**（折叠只是视图状态，**不写进会话文件**）；
⑦ **规则 / 策略**（M13d-3）：点「规则/策略」按钮看**本会话已沉淀的 `always` 规则**与**生效的「模式 → 权限」**表（等价于 CLI 的 `/approvals` 与 `/policy`，文本用的是同一个 formatter）。
⑧ **深 / 浅双主题 + 工具栏**（M20）：默认跟随系统（`prefers-color-scheme`），标题栏右侧按钮可显式切换并记住偏好（存 localStorage `aster.theme`，**只是视图状态、不进会话文件**）；
`plan`/`build` 模式做成分段按钮（点击仍走既有 `/mode` 路径，选中态**只由事件**驱动）；另做了相对时间、输入框自动增高、回合内「中断」按钮可用性、**滚动吸底**（往上翻历史时不被新事件拽回底部）。
⑨ **模型接入设置 + 毛玻璃**（M21）：标题栏 ⚙ 打开设置弹层，填 **Base URL / API Key / 模型**；**密钥只用 Windows DPAPI 加密落盘**
（`<数据根>\desktop\aster-settings.json`，只有当前 Windows 用户能解），**界面永远拿不到密钥**（`settings:get` 只回 `hasKey`）；
「测试连接」会真的发一次最小 `POST /chat/completions`；「保存并重启」后生效（provider 只在装配期解析）。面板 / 顶栏 / 输入区 / 工具卡
都做了**毛玻璃**（半透明 + `backdrop-filter` + 背景光晕，深/浅两套），弹层带遮罩模糊与入场动画。
**「窗口关闭 ≠ 中断回合」**：关窗只给会话输入流 EOF，**等当前回合跑完**再落 `session/end`；要中止回合请按**中断**按钮。
⑩ **日用三件**（M22）：**Markdown**（助手正文的代码块 / 行内代码 / 标题 / 列表 / 引用，零依赖纯 DOM，链接不可点击）；
**会话搜索**（标题 / 内容预览 / id，纯视图过滤）与**重命名**（落 `<数据根>\desktop\session-titles.json`，
**桌面标题不是会话事实、绝不进 JSONL**）；**安装器**——`install.cmd` / `uninstall.cmd`（目标以 `C:` 开头一律拒绝）
与 `--iexpress` 打出的单文件 `Aster-Setup.exe`（本机实测 126 MB、安装后 80 个文件）。

**便携形态（M13c）**：`npm run desktop-portable` 会在**仓库外**摆出 `..\dist-desktop\aster-desktop\`——
**双击**里面的 `aster-desktop.exe` 即可运行（**零安装、不改 PATH、不 `setx`**）；默认数据根 = **便携根**（`<便携根>\.aster`），
所以只要把这个目录放在 D 盘，数据就落在 D 盘（也可以用 `ASTER_HOME` 指到别处）。

**安装形态（M22）**：`node tools/build-desktop-installer.mjs` 会在便携根生成 `install.cmd` / `uninstall.cmd`；
加 `--iexpress` 会再用 Windows 自带的 IExpress 打出**单文件** `..\dist-desktop\Aster-Setup.exe`（双击即装）。
默认装到 `D:\Aster`，可用 `ASTER_INSTALL_DIR` 改；**目标以 `C:` 开头一律拒绝（exit 2）**。
唯一例外：桌面 / 开始菜单的 `Aster.lnk` 只能写在系统位置（Windows 的做法），应用数据仍然全在安装盘。
安装器**没有代码签名**，首次运行会被 SmartScreen 拦一下（选"更多信息 → 仍要运行"）。
它**不是单文件 exe**，而是"**解压即跑**"的目录（这正是 portable 的定义）；体积以 Electron 运行时为主（**实测未压缩**：`aster-desktop.exe` 约 247 MB，**整个目录约 369 MB / 79 个文件**）。
自检：`<便携根>\aster-desktop.exe --self-check`（在真窗口里发一条 prompt、续跑同一会话、回放可折叠工具卡、点开规则面板、
切换主题与模式、打开模型设置弹层并断言三字段后退出）。

**它还**不能**做什么**：模型设置目前是**单端点 / 单模型**（没有多端点切换、没有从 `/models` 拉列表）；
Markdown 不支持表格 / 嵌套列表 / 代码高亮；安装器无签名、无自动更新；
**观感与日用能力已按 M20–M22 定稿，但仍需你本机逐轮验收后才可能转 `stable`**——因此桌面版**一律标 `experimental`**，不进本文件的「已验证能力」清单。
（实装部分是**新 `@aster/desktop` 包 = 第 20 个内核模块**；架构门禁已把它纳入依赖方向：`desktop → runtime/schema`，且**禁止反向**。）
**边界（写死，ADR-029）**：GUI **不替代** `--tui`，也**不替代** `--serve`（同一份事件、三种外观）；renderer **拿不到 Node**（`sandbox:true` + `contextIsolation:true`），
只能经 `preload.cjs` 的窄接口取数据；页面由**同进程 loopback** 托管且 CSP 为 `default-src 'none'` + `connect-src 'none'`（**连一次网络请求都发不出去**）；
**「绝不碰 C 盘」是硬闸**：启动时把 Electron 的 `userData`/`cache`/`sessionData`/`logs` 全改道到 `<数据根>\desktop` 并**校验**，任何一项越界就 **exit 2 拒绝启动**（M21 起在 `app.whenReady` **之前**落实——Chromium 启动时就会读 `userData` 下的 `Local State`，晚了会让 `safeStorage` 拿到另一把钥匙）。

### ACP 通道（**experimental**，ADR-036）

```powershell
npm run cli -- --home .\.aster --acp    # stdin/stdout 按行分隔的 JSON-RPC 2.0，供编辑器 / 脚本驱动
```

支持 `initialize` / `session/new` / `session/prompt` / `session/cancel`（通知），服务端只发 `session/update`
（`agent_message_chunk` / `tool_call` / `tool_call_update`）。**stdout 只有协议消息**（config / MCP / memory 横幅全部走 stderr）。

- 更新**全部来自已记录事件**：`assistant/message` 作**一整块**文本发出（**不做 token 级流式**）、`tool/call` / `tool/result` 映射成工具状态；不另开文本通道。
- 能力如实声明：`loadSession:false`、`promptCapabilities.{image,audio,embeddedContext}=false`；只取 `type:"text"` 的块。
- **无审批通道 ⇒ `ask` fail-closed deny**（与 `--serve` 同一条结构性理由）；同一会话并发 prompt 回 `-32000 busy`。
- `session/cancel` 只 abort 该会话；stdin EOF ⇒ 逐会话落 `session/end{reason:"exit"}`、释放资源、exit 0。

> ⚠️ **未与真实 ACP 客户端（Zed）对测** ⇒ 一律 `experimental`，**不进**「已验证能力」清单。
> 不做 fs / terminal / `session/request_permission` / `session/load`，也忽略客户端传来的 `mcpServers`（不动态加载服务器）。

### client/server：SSE 事件流与远端写（M11a/M11b，ADR-021 / ADR-022）

```powershell
# 一边跑会话、一边让别的终端/程序看（只读：事件流 + 回放）
npm run cli -- --home .\.aster --serve --port 8787
# 另一个终端（curl 就是客户端）：
curl -N http://127.0.0.1:8787/api/event          # SSE：hello 帧 + 逐条事件
curl    http://127.0.0.1:8787/api/sessions      # 会话列表（直接扫 JSONL）
curl    http://127.0.0.1:8787/api/sessions/<id> # 回放：meta + events + 投影

# 只读镜像：把远端正在跑的会话镜像到本地终端（全屏差分渲染；非 TTY 逐行打印）
npm run cli -- --attach http://127.0.0.1:8787

# 远端写路径：给一个**已记录**的会话追加一个回合（服务端无审批通道 → ask 一律 deny）
curl -X POST http://127.0.0.1:8787/api/sessions/<id>/prompt `
     -H "content-type: application/json" -d '{\"prompt\": \"look at package.json\"}'
```

默认**只绑 `127.0.0.1`**（未鉴权，绝不默认对外）；要外部访问必须显式 `--host`，CLI 会打印未鉴权警告。
事件流**不做断点续传**（`hello` 帧里 `resume: "replay-only"` 明说），断线要续就**整段回放**。
远端写路径有三道**结构性**围栏：① **只在本机回环绑定时提供**（否则该路由一律 `501`）——
未鉴权的远端写路径不允许存在；② **本进程正在驱动的会话一律 `409 session_live`**（一个会话一个写入者）；
③ 请求体边界校验（非 JSON / 空 prompt / 超 64 KiB 一律可读 4xx）。
远端 prompt 会**真的执行工具**（`build` 模式下 workspace 内写放行，越界写因**无审批通道**被 fail-closed 拒绝）；
**无鉴权 + 回环 = 本机信任域**，这是显式取舍，不假装安全。

### 安装为本地启动器（**零系统改动、不改 PATH**）

```powershell
# 打成单文件 ESM bundle（产物 bin\aster.mjs，已在 .gitignore 中忽略）
npm run bundle

# bin\aster.cmd 为纯 cmd 启动器（已入库）：默认数据目录 = <仓库>\.aster，
# 若已设置环境变量 ASTER_HOME 则以其为准。
.\bin\aster.cmd --doctor
.\bin\aster.cmd --resume latest
```

> 若 PowerShell 执行策略受限，可直接调用 `node .\bin\aster.mjs <args>`，效果相同。

### 本地配置（可选，ADR-014）

优先级 **CLI 参数 > 环境变量 > 配置文件 > 内置默认**。配置文件为 JSON，自动发现两处（**逐键合并**，近者胜）：

| 位置 | 用途 |
|---|---|
| `<home>/config.json` | 用户级 |
| `<cwd>/aster.config.json` | 项目级（覆盖用户级同名键） |

`--config <file>`（CLI）或 `ASTER_CONFIG=<file>` 可显式指定**唯一**配置文件，并**跳过**自动发现。v1 字段面（**严格**：未知键直接报错并指出键名）：

```json
{
  "mode": "plan",
  "model": "deepseek-chat",
  "permissions": {
    "plan": [
      { "tool": "*", "readOnly": true, "decision": "allow", "reason": "plan: 只读放行" },
      { "tool": "*", "decision": "deny", "reason": "plan: 写操作一律拒绝" }
    ],
    "build": [
      { "tool": "*", "scope": "outside", "decision": "ask", "reason": "越界写需审批" }
    ]
  },
  "mcp": {
    "servers": [ { "name": "memory", "command": "node", "args": ["./servers/memory.js"] } ]
  },
  "memory": {
    "server": "memory",
    "searchTool": "search_memory",
    "limit": 5,
    "write": { "enabled": false, "addTool": "add_memory", "invalidateTool": "invalidate_memory" }
  },
  "subagents": { "enabled": false, "maxDepth": 2 },
  "context": { "compaction": { "enabled": false, "maxChars": 120000, "keepTurns": 2 } }
}
```

`permissions.<模式>` 会**整段替换**该模式的默认规则（未提供的模式保持内置默认）；覆盖必须**显式写出**，`guard` 仍只能否决。启动时会打印实际读入的配置文件路径，会话内用 `/policy` 查看生效规则，`--doctor` 报告配置状态。

**长会话上下文压缩（M23，experimental、默认关）**：`context.compaction.enabled` 必须显式写 `true` 才生效（不配置时行为与之前**逐字节相同**）。
触发条件是「所有消息正文的字符总数 > `maxChars`（缺省 120000）」，压缩**按整回合**进行、保留最近 `keepTurns`（缺省 2）个回合——
边界只落在 `turn/start` 之前，所以绝不会切断 `assistant(toolCalls)` 与 `tool/result` 的配对。每次压缩落一条
`context/compacted{fromSeq,toSeq,removedMessages,removedChars,keepTurns,strategy:"truncate",summary}` 事实，
`deriveMessages` 按 `seq` 跳过该区间、并在压缩事件的位置插入一段**确定性摘要**（**不调用模型**）——
因此投影幂等、resume 后一致，且「模型可见 ⟺ 已记录」这条不变量仍然成立。
⚠️ 当前只做**确定性截断**（没有语义摘要），被压掉的早期细节**不可恢复**；工具调用极其密集的**单个**回合不会被拆开压缩。

`mcp.servers` 声明的 MCP 服务器会在启动时**桥接**：其工具注册为 `mcp__<name>__<tool>`（与 4 原语天然隔离），一律按 `sideEffectScope=host` 参与权限判定（`plan` 下被拒、`build` 下需审批）。**服务器起不来只打印原因、不阻塞启动**；加载期不 spawn。

**两种传输声明（ADR-035，二选一、严格互斥）**：stdio = `{ "name": "…", "command": "…", "args": [...], "env": {...} }`；Streamable HTTP = `{ "name": "…", "url": "https://…", "headers": {...} }`（`url` 必须 `http(s)`）。两者经**同一个** `connectMcpServer` 分派、桥接成**同一批**工具；混写键 / 非 http(s) URL 在**加载期**快速失败。HTTP 侧支持 `application/json` 与 `text/event-stream` 两种响应、复用 `Mcp-Session-Id`、通知照常 `POST`。⚠️ HTTP 传输只与**仓内 fixture** 对测，**未与真实远端 MCP 服务对测**。

**prompts / resources 只读查看**：`--mcp-prompts <server>` / `--mcp-resources <server>` 打印服务端声明的提示词 / 资源后退出（**不进 REPL**）。两者都**先检查** `initialize` 返回的 `capabilities`——没声明就明确说"不支持"并列出已声明能力。**刻意不做**：把 prompt / resource 自动拼进 system 或上下文（需要选择策略与注入配额，属产品决策）⇒ 模型目前**看不到**它们。

`memory` 声明长期记忆**经 MCP 外挂**（ADR-010/016）：每回合开始前用 `searchTool` **跨会话**检索（`session: "*"`）相关记忆，结果**先落 `memory/injected` 事件**、再由投影挂到该回合用户消息前缀上（`<memory source="…">…</memory>`）；**只注入最新一次**，不堆积。检索失败只提示、不中断对话。作用域三键为 `user`（`ASTER_USER` / `USER` / `USERNAME`，缺省 `local`）、`agent`（`aster`）、`session`（当前会话 id）。⚠️ `--no-tools` 会连 MCP 桥接一起关掉 ⇒ 记忆（检索与写入）随之不可用。

**记忆写入（experimental，默认关闭，ADR-033/034）**：`memory.write.enabled: true` + `addTool` 后，每回合结束按**规则抽取**用户**显式标记**后的一句话（`记住…` / `以后都…` / `remember that…`），过**四道确定性闸门**（长度 / 密钥样式 / 注入样式 / 每轮 3 条 + 归一化去重）再写入；**每个候选都落 `memory/written` 事件**（added / skipped_duplicate / rejected / failed + 原因）。
**它很不"聪明"**：不摘要、不归纳、不推断、不做代词消解 —— 价值是"**不会写坏**"，不是"写得多"。显式取代（`不要再 vim，改成 neovim`）会先写新事实、再失效旧记录（需配 `invalidateTool`）、**重检索验证**并如实记 `verification`（`ok` / `old_still_visible`；验证跑不了就留空）——**绝不谎报成功**。`addTool` / `invalidateTool` / `session:"*"` 都是**我们对记忆服务器提的契约**，本机只有夹具 ⇒ **未与真实 mem0 / Graphiti 对测**，故**不进**「已验证能力」清单。

`subagents` 开启后注册 **`task`** 工具（ADR-017 / ADR-018）：模型可派发一个在**独立会话**里运行、上下文与父隔离的子代理，只拿回它的**最终文本**（`summary`）——看不到它的工具轨迹。`kind:"fork"` 让子代理**先导入你当前的上下文**（父会话当时的投影被**逐条记录**进子会话，即「导入即记录」，投影时再展开）；`background:true`（与 `kind` 正交）则**立刻返回**一个 `status:"running"` 句柄，子代理跑完后把结果以 **`subagent/result`** 事件落回**父会话**，你在**后续步骤**会收到一条 `<subagent-result …>` 通知（**每条只送达一次**，模型一旦产生新的 assistant 消息即视为已确认，不再重复）。子代理**无法请求审批**（`ask` 在它内部一律 fail-closed deny），因此越界之类的动作要在**父会话**里做。`maxDepth` 用「工具不存在」来防递归；**默认关闭**。父会话只留 `tool/call` + `tool/result`；子会话是独立 JSONL，父子关系在其 `session/start.parentSessionId` 里（`--list` 暂不显示父子关系，原因见 ADR-017）。退出时会**等待**未完成的 `background` 子代理收尾，结果不丢。

## 3. 已验证能力（每条绑定测试）

<!-- 本节的 `- <id>: <claim>` 行必须与 capabilities.json 的 stable 集合完全一致（CI 校验） -->

- session.event-sourced-log: 会话是 append-only 事件日志，模型历史由 `deriveMessages` 投影得出（幂等、确定性）
- persist.jsonl-source-rebuildable-index: JSONL 是唯一事实源；SQLite 是可由 JSONL 全量重建的派生索引；支持 `resume` 与 `rebuild-index`
- events.waterfall-and-effect: 事件总线提供 waterfall 中间件（不调 `next()` 即短路）与「注册即 effect」（卸载自动回滚）
- llm.openai-compatible-streaming: 单一 openai-compatible 流式后端（SSE 分片解析、usage 映射、finish_reason 映射、tool_calls 聚合）
- llm.api-key-not-leaked: API key 绝不写入会话日志、绝不打印；错误信息经脱敏
- tools.output-schema-enforced: 工具必须声明 output schema，注册期即校验；执行期强制校验，不符即拒绝并回灌可读错误
- tools.execute-pipeline: 工具执行流水线 `resolveInput -> input 校验 -> beforeToolCall -> tools/execute waterfall -> execute -> output 校验 -> afterToolCall`
- tools.primitive-set: 默认工具集只有 4 个原语 `read / bash / edit / write`（bash 覆盖搜索）；启用 `subagents` 后额外注册 `task`（默认关闭，故默认仍是**恰好 4 个**）
- shell.bash-pwsh-dual: `bash` 工具经 shell provider 抽象选后端：类 Unix 用 bash，Windows 用 pwsh（接口一致）
- shell.unix-ism-hints: Windows/pwsh 下检测到 Unix 惯用法（`ls`/`rg`/`cat` 等）时给出可读替代提示而非硬失败
- loop.turn-loop-with-tools: 回合制主循环 `turn = 0..N step`（采样 -> 工具 -> 回灌 -> 再采样），主循环不写死策略
- loop.truncation-batch-failure: `stopReason=length` 时该批 tool call 全部判失败、不执行并重发
- loop.readonly-parallel-write-serial: 同一批工具调用中只读工具并发、写类工具串行，事件回灌顺序确定
- permission.metadata-source-of-truth: 权限判定唯一事实源是工具元数据，不依赖代码语义
- permission.monotonic-guard: guard 只能否决、不能放行（列表次序无法把 deny 翻成 allow）
- permission.fail-closed: `ask` 在无审批通道时 fail-closed 转为 `deny`
- modes.plan-build-default: 默认双模式，`plan` 为默认启动模式且写操作一律 `deny`；`build` 允许 workspace 内写、workspace 外 `ask`；切换经 `mode/changed` 事件
- context.sectioned-prompt: 系统提示词分节拼装（稳定段/动态段分离），且每次请求对账当前模式约束
- extensions.tools-execute-seam: 加载中间件即可在 `tools/execute` 上注入超时、或短路内置行为，且**不改主循环**
- cli.repl-streaming: 最小 REPL，流式打印 + 工具调用轨迹 + `/history` + `/mode` + `/approvals` + `/policy` + `/exit`
- cli.tool-approval-interactive: `ask` 请求现场征询用户：`y`=仅此次放行 / `a`=本会话内始终放行（沉淀为同工具同作用域的审批规则）/ `n`=拒绝；无法识别一律 fail-closed 拒绝
- cli.resume-latest: `--resume latest` 直接续上最近更新的会话（同一 sessionId，且退出前历史在恢复后可见）
- cli.sigint-graceful-abort: `Ctrl+C` 一次中止当前回合（落 `turn/end{error}`）或把当前审批判为拒绝；二次退出并落 `session/end{interrupted}`
- cli.doctor-self-check: `--doctor` 自检 Node 版本 / shell provider / `node:sqlite` / `ASTER_HOME` 可写 / 端点变量 set-unset / UTF-8 / 会话与索引状态；关键项全通过 exit 0，否则 exit 1；**绝不打印密钥值**
- tools.read-output-cap: `read` 输出按 UTF-8 字节上限（65536）截断并置 `truncated` 与 `truncatedReason`（`window`/`bytes`）
- config.layered-json-file: 本地配置为分层 JSON（`<home>/config.json` -> `<cwd>/aster.config.json`，**逐键合并**且近者胜）；`--config`（CLI）或 `ASTER_CONFIG` 可显式指定并**跳过**自动发现；未知键 / 非法值 / 非法 JSON 一律快速失败且错误可读（含键名或键路径）；读取时**容忍首个 UTF-8 BOM**（Windows 记事本 / PowerShell 会写）
- config.precedence-cli-env-file-default: 配置优先级 **CLI 参数 > 环境变量 > 配置文件 > 内置默认**：`--mode` > `ASTER_MODE` > 配置 `mode` > 内置 `plan`；配置 `model` 仅在 `ASTER_MODEL` 未设置时兜底，**绝不覆盖**
- config.mode-permission-override: 配置文件可按模式**整段替换**「模式 -> 权限」规则（未提供的模式回退内置默认），且覆盖必须**显式写出**规则；`guard` 仍只能否决，`plan` 的安全默认不被隐式破坏；`/policy` 与 `--doctor` 让生效规则与配置来源**可见**
- mcp.stdio-client: **自写零依赖** MCP stdio 客户端（JSON-RPC 2.0 按行分隔）：`initialize` / `tools/list` / `tools/call` / `close`；请求 id 单调递增，超时与子进程退出都会清理待决请求，`close` 幂等，**不引入 `@modelcontextprotocol/sdk`**
- mcp.tool-bridge: MCP 工具以 `mcp__<server>__<tool>` **命名空间**注册（重名即注册失败）；`input` 原样透传服务端 JSON Schema（按已声明子集校验），`output` 声明并强制校验 `CallToolResult` **内容信封**（调和 ADR-005）
- mcp.permission-integration: MCP 工具一律 `sideEffectScope=host`：`plan` 下被拒、`build` 下走 `ask` + 审批流；`readOnly`/`destructive` 取服务端注解且**缺失按保守值**；判定落 `permission/decision` 事件
- config.mcp-servers: 配置文件 `mcp.servers` 声明 MCP stdio 服务器（`name` 规则校验、未知键报错、服务器**重名 fail-fast**）；`mcp` 为**整段替换**合并；加载期**不 spawn**，桥接失败只提示不阻塞启动
- memory.injection-seam: 记忆注入缝（`before_turn`）：检索结果**先落 `memory/injected` 事件**，再由投影成模型可见前缀；适配器报错或形状不符一律 **fail-open**（不落事件、不阻塞对话）；条数与单条长度上限生效
- memory.single-injection-projection: `deriveMessages` **只投影最后一条** `memory/injected`，且仅当它**晚于**最后一条 `user/message`；作为该条消息的 `content` 前缀（更早回合不被回溯修改、注入不堆积），幂等与确定性保持
- memory.mcp-adapter: 记忆适配器**经 MCP 外挂**复用已桥接连接：检索工具入参为 `{query,limit,user,agent,session}`，`content[0].text` 按 JSON **宽容解析**（信封或裸数组；坏 JSON / 缺 `content` 丢弃、缺 `id` 兜底）；**可选字段**（`createdAt` / `validAt` / `invalidAt` / `provenance`，ADR-030）服务端**给了就原样携带**、**没给就不带**（绝不臆造时间）、**形状不符的字段只丢自己**（不连累整条记录）；**写入 / 失效工具可选**（ADR-033/034：配了 `addTool` 才可写、配了 `invalidateTool` 才有 `invalidate`；服务端 `isError` 或没有可用记录 ⇒ **如实失败**；都没配时 `add` 仍**显式拒绝**，不是静默空操作）
- config.memory-server-binding: 配置 `memory.{server,searchTool,limit,write}`；`server` **必须**指向已声明的 `mcp.servers` 之名，否则 **fail-fast** 并提示已声明清单；`write.enabled: true` 时 `write.addTool` **必填**（否则 fail-fast，避免"开了写入却永远写不进去"）；服务器未桥接成功时明确报告并**禁用记忆**（fail-open）
- subagent.isolated-session: 子代理 = **独立会话**（独立 JSONL）：父会话只留该次派发的 `tool/call` 与 `tool/result`，父模型只看到 `summary`（**隔离是结构性的**，不靠投影过滤）；父子关系落子会话 `session/start.parentSessionId`
- subagent.depth-limit-no-recursion: 靠「**工具不存在**」结构性防递归：`depth+1 >= maxDepth` 时子会话**不再注册** `task`（行为可证：子代理内调 `task` 得 `unknown_tool`）
- subagent.permission-and-mode: `task` 元数据 `readOnly=false / destructive=false / sideEffectScope=workspace` -> `plan` 下被拒（**拒绝发生在执行前**，不产生子会话）、`build` 下允许；模式与父会话 id 均取**当次调用**（`context.mode` / `context.sessionId`）；子代理内**无审批通道**，`ask` 一律 fail-closed deny
- config.subagents-optin: 配置 `subagents.{enabled,maxDepth}`（`enabled` 必填、未知键与越界值报错、整段替换合并）；**默认关闭**以保持默认工具集恰好 4 原语；无模型端点或 `--no-tools` 时**只提示不注册**
- subagent.fork-context-import: 子代理 `kind=fork` 按「**导入即记录**」实现：子会话先落 `subagent/context-imported`（载荷 = **派发那一刻**父会话的投影，逐条记录在案，派发后再改父日志**不回溯**），投影展开**幂等**且等于「父历史 + prompt」；缺父会话访问权（`sessionLog`）时**快速失败**且**不产生**子会话，绝不静默降级成 `fresh`
- subagent.background-result-delivery: 子代理 `background=true`（与 `kind` **正交**）：`task` 只等建好子会话即返回 `status=running` 句柄；子代理结束后把 `subagent/result` 落**父会话**（复用父句柄 ⇒ seq 单调、JSONL 与派生索引一致，`resume` 重放可证）；父侧投影**只送达「晚于最后一条 `assistant/message`」**的结果（以 user 角色插入 `<subagent-result …>`，**每条只送达一次**、不堆积、幂等确定）；退出前 `drain()` 等待未完成者收尾，父句柄不可写时**静默丢弃**且绝不抛未处理异常
- portable.exchange-format-v1: 会话交换文档 `aster-session-exchange` 自带 `formatVersion`（`EXCHANGE_FORMAT_VERSION`，与 `SESSION_FORMAT_VERSION` **解耦**，补上 `zcodeSessionFileSchema` **完全没有版本字段**的缺口）；**Aster 往返语义无损**（除 `sessionId` 外事件序列逐字段深等、投影逐条深等、`created_at` 亦保留）；更高版本 / v0 / 错 `format` / 坏 JSON / 篡改会进模型历史的载荷一律**快速失败**且原因可读
- portable.vendor-adapters: 厂商适配器为 **best-effort** 且**未与真实 Claude Code / ZCode 二进制对测**（只按逆向证据形状实现 + 仓内 fixture 回归）：Claude Code 原生 JSONL 导入按已观察形状清洗（丢 `tool_result` / IDE 噪音 / `synthetic` 占位 / `sidechain` / `isMeta`，连续 assistant 记录**聚合成一轮**）、导出**只写证据里被读取的字段**（不臆造 `uuid`/`parentUuid`）；ZCode 会话文件按 `zcodeSessionFileSchema` 读写且 `mode` 只在 `plan`/`build` 时采纳、不造 `fileChanges`/`turnCheckpoints`；工具轨迹/审批/模式切换等**有损项显式**且 CLI 必打印
- cli.session-export-import: `aster --export <sessionId|latest> [--format aster|claude-code|zcode] --out <file>` 与 `aster --import <file> [--format …]`：两者都**不进 REPL**、打印结果并退出；导入＝按事件**重建**新会话（走 `persist` 的单一写入路径）并打印新 `sessionId` 供 `--resume`；`--export` 缺 `--out` 快速失败；`--format` 取值域严格校验
- memory.exchange-format-v1: 记忆交换文档 `aster-memory-exchange` 自带 `formatVersion`（`MEMORY_EXCHANGE_FORMAT_VERSION`，与 `SESSION_FORMAT_VERSION` / `EXCHANGE_FORMAT_VERSION` **各自独立演进**，补上外部记忆层导出形状普遍**无版本字段**的缺口）；`records` **复用** `MemoryRecord`（不另立形状）、`scope` 三键**必填**（ADR-010 的隔离前提）、`provenance` 只带 hash 元数据；Aster 往返**逐字段深等**（**缺席与显式 `null` 是两种事实**）；更高版本 / v0 / 错 `format` / 坏 JSON / 坏记录（含**逐条路径**）一律**快速失败**且原因可读；解析即**规范化**（未声明键剥掉 ⇒ 外部塞进来的身份键**进不了**下游）
- cli.memory-export-import: `aster --export-memory --out <file> [--memory-session <id>]`：经 MCP 外挂**只读**读取配置的记忆层（`getSessionMemories`，缺省作用域 = 最近更新的已记录会话）导出为 `aster-memory-exchange` 文档（形状不符的记录**丢弃**、未声明键**剥掉** ⇒ 导出**永远产出合法文档**；适配器报错**如实抛出**）；`aster --import-memory <file> [--out <file>]`：校验并**规范化重写**（= 主张 4 的「迁移」落点）；两者都**不进 REPL**、都必须打印「**未写入任何记忆层**：write path 按 ADR-016 显式推迟」；未配置记忆层 / 缺 `--out` 快速失败且原因可读
- sandbox.windows-job: **Windows-only** 的**内核强制**围栏（ADR-031）：Job Object 的 `KILL_ON_JOB_CLOSE`（作业句柄一关 ⇒ 内核击杀**整棵树**，含包装进程被杀 / 超时 / 中止，孙·曾孙**不可能**变孤儿）+ `ACTIVE_PROCESS` 上限（超限进程**入不了作业**）+ `UILIMIT_*`（剪贴板读写 / 外窗句柄 / 全局原子 / 系统参数 / 显示设置；**刻意不含** DESKTOP / EXITWINDOWS）；载体是**内盒 PowerShell 5.1 + `Add-Type` P/Invoke**（**零新依赖**，编译产物按源码 sha 指纹缓存到数据根）；命令文本经 base64 环境变量 + `-EncodedCommand` 交给内层 ⇒ **一字不改**；**拿不到围栏就拒绝执行**（exitCode 126，内层不跑）；非 Windows 传该值**报错**（不静默退回）。⚠️ **它不是文件 / 网络隔离**——`label` 与文档同时写清「内核强制」与「不是文件 / 网络隔离」
- shell.utf8-output: 子进程输出**统一 UTF-8**（ADR-032）：每条命令前注入 `[Console]::OutputEncoding = UTF8`（连带把控制台输出代码页设为 **65001** ⇒ **原生命令**（git / npm / python / cmd）的输出也变 UTF-8）+ `$OutputEncoding = UTF8`，命令经 `-EncodedCommand`（UTF-16LE base64）传入 ⇒ 中文 stdout / stderr **不再按 OS OEM 代码页（本机 936）写字节**（此前 Node 按 UTF-8 解码即 `����`）；ASCII 输出与**退出码语义不变**（有回归）；`windows-job` 包装路径与直接 spawn 路径**共用同一份脚本文本**（前言只写一处）
- mcp.prompts-resources: MCP **prompts / resources 只读面**（ADR-035）：零依赖客户端支持 `prompts/list` / `prompts/get` / `resources/list` / `resources/read`，桥接对象原样透传；CLI `--mcp-prompts <server>` / `--mcp-resources <server>` **不进 REPL**、打印后退出；**先检查** `initialize` 返回的 `capabilities`，未声明就明确说"不支持"并列出已声明能力（不硬调后报 JSON-RPC error）；列表解析宽容（缺 `description` / `name` / `mimeType` 不算错，形状不对只丢自己）。**刻意不做**：把 prompt / resource 自动拼进 system 或上下文 ⇒ 模型目前**看不到**它们
- mcp.http-transport: MCP **Streamable HTTP 传输**（ADR-035）：零新依赖（Node 22 内置 `fetch`）——`POST` JSON-RPC，响应支持 `application/json`（单条）与 `text/event-stream`（逐事件按 `id` 取目标响应）；记住 `initialize` 的 `Mcp-Session-Id` 并在后续请求复用；通知（无 `id`）同样 `POST`；超时经 `AbortSignal`；配置 `mcp.servers[]` 为 **stdio / HTTP 严格 union**（`{name,command,args?,env?}` 或 `{name,url,headers?}`，`url` 必须 `http(s)`，两边键互斥，混写 / 非法值加载期快速失败）。stdio 与 HTTP 经同一 `connectMcpServer` 分派并桥接成同一批 `mcp__<server>__<tool>`。⚠️ **边界**：HTTP 传输只与**仓内 fixture HTTP 服务**对测，**未与真实远端 MCP 服务对测**；`close()` 只置 closed、不发 `DELETE` 终止会话
- tui.diff-renderer: 行级差分重绘（ADR-020）：两帧相同则**一个字节都不写**；只重绘 `firstChanged..lastChanged` 区段（未变化行的文本不会被重画）；新增行向下续写、删除行清尾并把光标收回末行；宽度变化走**全量重绘**；每一帧都被**同步输出** `ESC[?2026h…ESC[?2026l` 包裹，避免撕裂
- tui.display-width: 按终端**显示列**（而非字符串长度）计算：ANSI 不占列、东亚全角与 emoji 占 2 列、组合字符占 0 列；截断不会把一个宽字符切一半；硬换行按列宽切分且每行自闭合（中文/emoji 不会错位）
- tui.frontend-shell: TUI 是 `runSessionRepl` 的**前端壳**（输入适配器＝按行投递的 `Readable`、输出适配器＝`Output`），命令/记忆缝/审批/SIGINT/`session/end` **一处实现两处外观**；alt screen 进入与离开都写在 `finally` 并额外注册 `exit` 兜底、raw mode 成对开关、收尾前把**最后一帧画完**；非 TTY **明确提示并回落**朴素 REPL；Ctrl+C **合成 SIGINT** 以复用既有语义；流式渲染**合帧**（窗口 16ms，**可复现**：`tui/screen.ts` 的 `MIN_RENDER_INTERVAL_MS`）而输入回显立即 `flush`；深色极简语义配色且 `NO_COLOR` / `--no-color` 全关
- tui.structured-event-driven: TUI 会话视图由**结构化事件**驱动（ADR-023）：`runTuiSession` 把 `onEvent` 接进新 `tui/transcript.ts` 的行模型，按 `describeEvent` **直接映射**成屏幕行，同时给 `runSessionRepl` 传 `trace:false` —— **已有事件**的文本轨迹（`+ user/message#N` / `→ tool_call` / `← tool_result` / `~ memory: injected` / `/mode` 的 `mode: A -> B`）**不再重复打印**；状态条 `mode` 来自 `mode/changed` **事件**、会话 id 来自 `onSessionReady`，**不再回读横幅与提示行**（旧的两条正则删除，且修掉状态条 mode **滞后到下一次按键**才刷新的缺陷）；`format.ts` 退回「只配色、不决定语义」（删掉 5 条会话事实前缀规则）；**回车不再回显**（`user/message` 是事实，由事件渲染，避免同一句出现两遍）；`describeEvent`/`describeFrame` 的 `DescribeOptions`（`assistantContent` / `turnEnd`）是**前端差异**（TUI 不吃 assistant 正文与 `turn/end`，`--attach` 两者都渲染）；`turn/start` 是**记账**事件，**显式**不产生可见行（未知类型仍回退 `[event]`）
- tui.multiline-editor: **多行编辑器**（ADR-025，新 `tui/editor.ts` **纯几何**）：输入区按草稿行数占 **1..8 行**（**窗口跟随光标**、超过则上滚），首行 `› ` 前缀、续行**同宽缩进**；换行用 `Ctrl+J` / `Alt+Enter`，以及终端**若已开启** CSI-u / modifyOtherKeys 时发来的 `Shift+Enter`（**我们不发** modifyOtherKeys / kitty 协议，故 `Shift+Enter` **不假装到处可用**），`Enter` 仍是**提交整份草稿**；**括号粘贴** `?2004h` 让 `ESC[200~…ESC[201~` 整段作为**一个** `paste` 事件（**跨分片**也安全）⇒ **粘贴多行不误发**；多行草稿以 `NEWLINE_ESCAPE=U+0000` 编码后交给 readline，再由 REPL 解码回换行 ⇒ **只落一条** `user/message`（且 `describeEvent` 按**多行**渲染，保住"一行 = 一个屏幕行"）；`↑`/`↓` 先在草稿内按字符偏移移动、到边界才翻历史，`Home`/`End` 是**行首/行尾**，`Ctrl+U` **清空整份草稿**；点击按行列落在**字符边界**上（宽字符内部归到**左边界**）；**不做软换行**（超宽行按列截断，显式声明）
- tui.caret-row-render: **光标可停在非末行**（ADR-025）：`compose` 仍**恰好 `rows` 行**（视图 = `rows − 状态头 − 输入行数`），`caretPosition` 与 `compose` **共用同一套窗口算法**（`maxInputRows`）故"画在哪"与"光标停在哪"永远一致；`renderFrame` 新增 `caretRow` / `previousCaretRow` —— 先把光标从上一帧落点归位到末行（差分前提）再画，画完**上移到光标行**；**单行输入时行为与 M10 逐字节相同**（`m10` 回归钉住）；并修掉一个真实缺陷：帧文本**不含**光标位置，行内左右移动 / `Home` / `End` 会让差分为 `none` ⇒ **一个字节都不写、光标看不见动** —— 新增 `renderCaretMove`，帧不变而光标变了就只发一段光标定位序列（`createScreen` 在 `none` 分支补发）
- tui.tab-completion: Tab 补全为**纯函数**（ADR-024，新 `tui/completion.ts`）：命令（`/mo` → `/mode `，带参数的命令**补完名后补一个空格**）／命令参数（`/mode p` → `plan`，候选引用 `AGENT_MODES`）／**路径**（只补最后一个"看起来像路径"的词；大小写不敏感前缀匹配，目录补分隔符，列举键去掉尾分隔符且由调用方注入）；三条纪律：**补不动就一动不动**（无匹配 / 列举失败 / 无 `listDir` 一律原样返回、**绝不抛**）、**不打扰正常输入**（普通中文/英文词 Tab 无反应）、**多候选只补公共前缀并把候选列出来**（不替用户猜也不静默改文本）；命令表 `REPL_COMMANDS` 与命令实现**同处 `repl.ts`**（防漂移），由 TUI **注入**
- tui.mouse-interaction: TUI 鼠标只上报**点击与滚轮**，**不破坏原生选中**（ADR-024）：启用 `?1000h` + `?1006h` 而**刻意不启用** `?1002/?1003`（拖拽跟踪会让终端不再做原生选中复制）；滚轮改 `scrollOffset`（3 行/格），左键点在**输入行**按列定位插入点（`index = 列 - 1 - PROMPT_WIDTH` 并按字符数 clamp），点其它区域不处理；SGR 鼠标序列（`ESC[<b;x;yM|m`）**整条解析**，未完成前缀留在缓冲等下一片、**绝不当垃圾字符吞掉**；进入 alt screen 时开启、`restore()` 里**先关再离开**（成对还原）
- serve.event-feed-backpressure: 事件扇出为**单全局订阅 + 每连接有界队列**（容量 4096，取自 OpenCode 已观察取值）：队列满**只断该连接**并以 `subscriber_overflow` 错误帧收尾（`retryable=true`，可重连后整段回放），**其余连接完全不受影响**；`publish` **绝不等待消费者**（无人在读也能同步连发）；一条事件序列化失败是**格式级 bug**，以**同一个**错误收尾**全部**订阅者而非只影响一个
- serve.sse-readonly-endpoints: 零依赖 `node:http` 的三条**只读**路由：`GET /api/event` 先下发 `hello` 帧（`protocolVersion` + `resume=replay-only`，明示**不做断点续传**）再逐条转发已记录事件（会话所追加的每条事实都经**同一出口**：`/mode`、回合事件、`session/end`；`session/start` 由建会话时写入、早于该出口故**不进流**）；`GET /api/sessions` 直接扫 JSONL（**没有派生索引也能工作**）；`GET /api/sessions/:id` 回放 `meta` + `events` + `deriveMessages` 投影，且**调用前后事实源逐字节相同**（服务端**不新增写入路径**）；404 / 405 均回可读错误帧
- serve.localhost-only-default: SSE 服务端**默认只绑 `127.0.0.1`**（未鉴权，绝不默认暴露到网络）；对外暴露必须显式 `--host`，且 CLI 会打印**未鉴权警告**；`--port` 严格校验（0-65535 整数，`0` 表示由系统分配）；端口/连接在 CLI 退出时收尾（不留监听中的端口与在途连接）
- serve.attach-mirror: `--attach <url>` 只读镜像客户端（ADR-022）：连 `GET <url>/api/event`（SSE）把远端会话镜像到本地终端，客户端**不做任何写入**；帧→行由 `tui/events.ts` 的**结构化映射**给出（按 `SessionEvent.type` 直接映射，未知事件类型回退 `[event] <type>`，绝不静默丢弃）；`hello` 帧显示协议版本与 `resume=replay-only`；断线（含 `subscriber_overflow`）一律提示重连并**整段回放** `GET <url>/api/sessions/<id>`；TTY 用全屏差分渲染（进出 alt screen 严格还原），**非 TTY 退化为逐行打印**；SSE 客户端为纯解码（跨分片 / CRLF / 多行 data 容错，坏 JSON 在客户端本地合成为可读 `bad_frame` 错误帧）
- serve.remote-prompt-write: `POST /api/sessions/:id/prompt` 远端写路径（ADR-022）：**只经 `persist` 的单一写入路径**（`store.resume` + `handle.append`，seq 连续且可 `resume` 重放，**不新增写入者**）；落 `user/message` 后用**与 REPL 共用**的 `cli/session-loop.ts` 跑一个回合（模式 / cwd 取自**会话自身**，不由客户端指定）；服务端**没有审批通道**，`ask` 一律 **fail-closed deny**（越界写被拒且**文件未生成**，判定经 trace 出口落 `permission/decision`）；结构性围栏：未注入 driver 一律 **501**（CLI 只在**回环**绑定时注入），本进程正在驱动的会话一律 **409 `session_live`**（一个会话一个写入者），请求体边界校验（`invalid_json` / `invalid_prompt` / `payload_too_large`），同一会话的并发 prompt **串行化**
- tui.rich-text: **流式正文的极简 markdown**（ADR-026，新 `tui/rich-text.ts` **纯函数**）：标题（`#{1,6}` + 空格 → 加粗 + accent）、无序列表（`-` / `*` / `+` → `• `）、有序列表（`1. ` → 保留序号）、**围栏代码**（等宽框：开 `┌─ <lang|code>`、正文行前置 `│ `、闭 `└─`；围栏状态由行模型持有）、行内代码（成对反引号 → tool 色）；只作用于**文本通道的已收全行**（未收全的半行**按原样**显示），**未命中任何构造的行回落 `formatLine`**（横幅 / 命令输出照旧上色；**事件通道 `describeEvent` 一字未改**）；它**只影响呈现、不产生事实**，围栏状态**不进 JSONL**；显式**不做**：表格 / 引用块 / 嵌套列表 / 软换行
- tui.tool-result-fold: **工具结果折叠**（ADR-026，**视图状态**而非事实）：折叠态 `← tool_result: <tool> <ok|err> · <耗时> · N 行 · 折叠`（`N` = 被隐藏的输出行数，由 `toolResultHiddenLines` **单一给出** ⇒ **没藏内容就不加标记**），展开态追加逐行 `│ …`（载荷为字符串按行、否则 JSON 缩进）；`DescribeOptions.collapse` **缺省 false** ⇒ 保持一行摘要的既有行为（`--attach` 不吃折叠）；交互 = **左键点该行**切换这一条（屏幕行 → 转录行用 `screen.transcriptIndexAt`，与 `compose` **共用同一套窗口算法**；转录行 → 事件 `seq` 用 `transcript.eventSeqAt`）+ **`Ctrl+O`** 全部展开 / 收起（**不用裸字母键**：输入框优先）；折叠状态**只在 `transcript` 内存里、不入 JSONL**（测试断言 JSONL 中无 `expanded` / `fenced` 字段）
- tui.turn-indicator: **回合内指示**（ADR-026，新 `tui/spinner.ts`）：**忙碌态是结构化判据**（`turn/start` 之后未见 `turn/end` / `session/end`，**不嗅探文本**）；**耗时来自本机时钟**、状态条明写 `(local)`（**不是**事件里的字段）；spinner 帧 = `frames[floor(elapsed/120) % n]`（**确定函数**，不引随机）；节拍**只在忙碌时存在**（`turn/end` 即停 ⇒ **空闲不空转**；**可复现**：`m10b4b` 断言收尾后 200ms 内不再写字节）；只显示在状态条（紧跟模式，**窄终端**下 cwd / 模型名先被截也不会把它截掉），**不新增屏幕区域**；token 用量**未落事件故不显示、绝不估算**（不引 `chars/4`）
- tui.resize-redraw: **resize 实测**（ADR-026）：`resize` 事件 → `syncState` + 立即 `flush`；列宽变化走 `planDiff` 的 **full 分支**（清屏 + 回原点整帧重绘），状态条与输入行按新尺寸重画（假 tty 可断言：Δ 输出含 `ESC[2J` + `ESC[H`）
- tui.ime-caret-placement: **中文 IME 候选框定位的前提**（ADR-026，写清「我们做什么 / 不做什么」）：**硬件光标保持可见**（进入时发 `?25h`，**绝不隐藏**）、光标**列按显示列算**（前缀 2 列 + 东亚全角 2 列）、`caretPosition` 与 `compose` **共用同一套窗口算法** ⇒ 候选框跟着正确行列；显式**不做** preedit / 内联 IME 渲染（需读 OS 输入法状态，超出范围）
- tui.approval-interaction: **审批流在 TUI 里的完整交互**（ADR-026）：提问（`renderApprovalPrompt` 的**多行**文本）走文本通道**按多行**渲染；提问期间**输入行照常可用**（同一条 stdin，`Enter` 推一行即答案）；判定语义与 M6 **完全一致**（`y` / `a` / `n`、`always` 沉淀为会话内规则、解析失败 fail-closed），判定经 trace 出口落 `permission/decision`（假 tty 实测：`build` 下越界写 → 现场提问 → 作答 `a` → 放行且文件**真的写出**）

- memory.l1-quality-gate: **L1 记忆质量判官**（ADR-028）：`memory/quality.ts` **纯函数、离线、无 LLM、零外部依赖**，四条可证伪断言 —— ① **抽取完备性**（抽取集 **⊇** golden；归一化 = 折叠空白 + 大小写不敏感 + 去掉两个 CJK 字符之间的空白）／② **检索 top-k 命中**／③ **Memory Boundary**（**未被提及**的 query **必须返回空**，编造即 `fabricated`）／④ **更新原子性**（新事实生效 **且** 旧记忆失效）；**只做词法比对**（语义等价属 L2，显式声明不做）；golden 集 **vendored 进仓**（`test/fixtures/memory-l1/`，**自造、不含真实用户数据**）且 **sha256 pin**（数据漂移当场变红）；反例测试证明判官**真的会因缺项 / 编造 / 矛盾而变红**；**L2（采样 LLM）/ L3（全量）与自动抽取显式未做**

## 4. 明确未实现（**不含空桩包**，按路线图生长）

- **v0.2** — 真沙箱（审批 × 沙箱正交 + 失败升级重试）：**M12a 交付 `best-effort`（`experimental`）**（进程树击杀 + 环境收敛 + 数据根权限体检），**M15 追加 `windows-job`（ADR-031，Windows-only）**——用 Job Object 拿到**内核强制**的资源 / 进程 / UI 围栏（**Windows 路径上它不再是 best-effort**）；但它**仍不是文件 / 网络隔离**（本机实测：非管理员下 token filtering `NOT_SUPPORTED`、AppContainer 需提权且写 C 盘、Windows Sandbox 在 Home 版不存在）⇒ 边界见 §3 末尾的说明，`windows-job` 只把**已实测**的那几条写进「已验证能力」清单
- **v0.3** — MCP（**Stdio 工具加载已交付**；**prompts / resources 只读查看已交付**；**Streamable HTTP 传输已交付**——ADR-035，HTTP 侧只与仓内 fixture 对测）、长期记忆经 MCP 外挂（**检索注入已交付**；**L1 质量门禁已交付**；**规则版写入路径已交付（experimental、默认关闭，ADR-033/034）**；**语义版抽取 / L2 采样 / L3 全量仍未做**）
- **keyless 录制回放** — **M19 已交付（experimental，ADR-037）**：--record / --replay + 版本化 JSONL cassette + 严格请求哈希匹配 + fail-closed 不匹配；剩余：录制真实厂商会话的样本、把 cassette 固化为 CI 离线回归。
- **ACP** — agent 侧最小通道 **已交付（`experimental`，ADR-036）**：`--acp` + `initialize` / `session/new` / `session/prompt` / `session/cancel`，更新只来自已记录事件；**未与真实 ACP 客户端（Zed）对测** ⇒ 不进「已验证能力」清单；剩余：token 级流式、`session/request_permission`、fs / terminal、`session/load`
- **v0.4** — 显式版本化的会话交换格式（**主张 4 的会话侧已交付**：ADR-019）+ **记忆交换格式已交付**（ADR-030，`aster-memory-exchange` + `--export-memory` / `--import-memory`；**只搬运、不写记忆层**）；剩余：厂商侧记忆适配器（**未与真实 mem0 / Graphiti 对测**）
- **v0.5** — 差分渲染 TUI：**机制面已交付**（ADR-020）+ **结构化驱动已交付**（ADR-023，M10b-1）+ **基础交互已交付**（Tab 补全 / 鼠标，ADR-024，M10b-2）+ **多行编辑器已交付**（ADR-025，M10b-3）+ **富文本 / 折叠 / 回合内指示 / resize・IME 前提・审批实测已交付**（ADR-026，M10b-4）；**完整版仍未收口**（用户 2026-10-15 首次实测判定「只是雏形」，该判定**未被本批推翻**）——剩余项 **M10b-5 配色打磨轮次：用户 2026-10-16 决定「先要完整版、之后再本地核验」，故**显式推迟**（不标完成）**
- **v1.0** — client/server + SSE（**两端已交付**：ADR-021 只读事件流与回放、ADR-022 `--attach` 只读镜像 + 远端写路径）、HaluMem 式记忆质量门禁（**L1 已交付**，ADR-028；**L2 采样 / L3 全量需真实端点，未做**）

**`best-effort` 沙箱（`experimental`，ADR-027）——怎么开、以及它**不是**什么**：

```powershell
.\bin\aster.cmd --sandbox best-effort        # 默认是 off；未知取值会直接报错，不会静默退回
```

开启后：① 工具被**超时/中止**时杀**整棵进程树**（Windows `taskkill /T /F`），再补一刀 `child.kill()`；② 子进程环境**收敛到白名单**（**密钥类变量不外传**）、显式打标 `ASTER_SANDBOX=best-effort`，`cwd` 越出工作区即**可读拒绝**（不执行）；
③ 启动横幅打印**数据根权限体检**结论，未收紧时附一条**可复制执行**的 `icacls` 命令（**我们不动手改 ACL**——实测 `icacls /inheritance:r` 会把调用者自己锁在门外，故显式交给用户执行）。
**它**不是**隔离**：不限制工具能写哪里（那仍由 `plan`/`build` 的 `allow/deny/ask` 管）、不做受限令牌/seatbelt/bwrap、不做网络隔离 ⇒ 因此**不进「已验证能力」清单**，一律标 `experimental`。

**`windows-job` 沙箱（ADR-031，**Windows-only**）——用 Job Object 拿**内核强制**的围栏**：

```powershell
.\bin\aster.cmd --sandbox windows-job     # 默认仍是 off；非 Windows 传这个值会**直接报错**（不静默退回）
```

开启后（**这些性质已由真进程测试钉住**）：① 作业句柄一关（含**包装进程被杀 / 超时 / 中止**）⇒ **内核击杀整棵树**，孙·曾孙进程**不可能**变孤儿（实测：中止后 `ping` 归零）；② **进程数上限**（默认 64，含内层 pwsh 自己）——超限进程**入不了作业**；③ **UI 限制**（剪贴板读写 / 外窗句柄 / 全局原子 / 系统参数 / 显示设置；**刻意不含** DESKTOP / EXITWINDOWS）；④ **拿不到围栏就拒绝执行**（`exitCode 126`，内层命令**不跑**，绝不"没围栏也跑"）。
实现细节（写出来免得后人重踩）：载体是**内盒 PowerShell 5.1 + `Add-Type` 的 P/Invoke**（**零新依赖**；编译产物按源码 sha 指纹缓存到 `<数据根>\sandbox\`），命令文本经 **base64 环境变量 + `-EncodedCommand`** 交给内层 ⇒ **一字不改**、零 argv 转义风险；代价是**每次 `bash` 工具调用多一跳包装进程**（本机时钟口径、**可复现**：用 `Measure-Command` 量 `powershell -NoProfile -Command "exit 0"` ≈ 161ms，DLL 缓存命中 ≈ 13ms vs 现编 ≈ 140ms）。
**它仍不是文件 / 网络隔离**——不限制能读写哪些路径、也不禁网（实测证据：非管理员下 `SetInformationJobObject(SecurityLimitInformation)` 返回 `NOT_SUPPORTED`；AppContainer 需提权且要写 C 盘用户目录；Windows Sandbox 在 Home 版不存在）⇒ **别按"真沙箱"理解**。

> **当前版本（v1.0.0）仍只宣称主张 2**（「内核聚焦 + 扩展缝完整 + 内置 fail-closed 权限 + **优化优先**」）。
> **平台范围 = Windows-only**（2026-11-03 定位修订：不再承诺 Linux / macOS；Unix `bash` 分支仅作既有实现保留，不纳入支持矩阵）。
> 主张 1 / 3 / 5 **尚未兑现**；主张 4 **两侧已兑现**（会话侧 ADR-019 + 记忆侧 ADR-030），但它仍留在本节的路线图里（厂商侧未对测）——这是本项目的**能力声明纪律**。

## 5. 架构（3 包 / 20 模块 / 6 不变量 / 3 缝）

```
@aster/schema   ──▶  @aster/protocol  ──▶  @aster/runtime  ──▶  @aster/desktop
（纯类型/契约）        （线协议形状）         （19 个内核模块 + CLI + 扩展缝）   （Electron 桌面壳，experimental）
```

- **20 个内核模块**：`events / session / llm / permission / tools / shell / context / config / mcp / memory / subagent / portable / tui / serve / sandbox / loop / persist / cli / extensions / desktop`
- **6 条核心不变量**：① 模型可见 ⟺ 已记录；② 注册即 effect；③ 单调 guard 只能否决；④ 工具必须声明 output schema；⑤ 持久化宁可快速失败；⑥ **单一事实源、派生可重建**
- **3 条扩展缝**：`events` waterfall 中间件（已交付）／`extensions` 加载器（已交付最小入口）／记忆注入缝（**已交付 `before_turn`**；`after_turn` 等待带质量门禁的抽取器）

依赖方向由 [`architecture-policy.json`](./architecture-policy.json) + [`tools/architecture-check.mjs`](./tools/architecture-check.mjs) 在 CI 强制（禁环 / 禁深层跨包 import / 禁越界相对导入 / 行数上限：**src ≤ 400 行，test ≤ 600 行**）。

## 6. 纪律

1. **宣传与实现一致**：本文件每条能力绑定测试；`removed` 能力必须从文档同步删除；不留空桩包。
2. **凡性能/基准数字必须可复现**（pin 数据版本 + 公开脚本），否则必须标注「未验证」。本文件当前**不含任何未标注的性能声明**。
3. **禁止在面向模型的 prompt 中植入推销/引导推荐指令**（CI 扫描）。
4. **许可红线**：本项目**只借鉴设计，不复制代码**。被参考项目中 `mem0` / `Graphiti` / `Letta` / `Codex` / `Gemini CLI` / `Goose` / `zcode` 为 Apache-2.0，`dsh` / `OpenCode` / `Pi` / `supermemory` / `TencentDB-Agent-Memory` 为 MIT，`HaluMem` 为 **CC BY-NC-ND 4.0（禁商用禁演绎）**，`honcho` / `basic-memory` 为 **AGPL-3.0**——**后两者的代码一行都未进入本项目**。
5. **协作**：提交需 DCO 签核（`Signed-off-by`）与 **AI 贡献披露**，见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 7. 许可

计划采用 **Apache-2.0**（ADR-012）。`LICENSE` / `NOTICE` 将在开源阶段（Phase 2）随仓库一起落地；当前仓库为**本地开发态**，尚未对外发布。

## 8. 开发命令

```powershell
npm run typecheck           # tsc -b（每个包都有 tsconfig，构建期强制类型检查）
npm run lint                # Biome（lint + format 单点）
npm run test                # vitest run
npm run architecture:check  # 架构治理门禁
npm run capabilities:check  # 能力声明门禁（README ↔ 测试绑定）
npm run verify              # 以上全跑（CI 用同一条命令）
```
