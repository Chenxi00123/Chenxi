# 第三方软件声明（Third-Party Notices）

本仓库自身以 **Apache-2.0** 发布（见 `LICENSE`）。分发的构建产物里还包含下列第三方代码，
其版权与许可声明如下。**分发 `bin/chenxi.mjs`、桌面便携目录或 `Chenxi-Setup.exe` 时，本文件必须随附。**

---

## 1. zod

用途：运行时依赖（schema 校验），被 esbuild 内联进 `bin/chenxi.mjs` 与桌面 `main.mjs`。
许可：MIT

```
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

来源：https://github.com/colinhacks/zod

---

## 2. Electron

用途：桌面版运行时（**开发依赖，但随便携目录 / 安装包实际分发**）。
许可：MIT

```
Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

来源：https://github.com/electron/electron

---

## 3. Chromium（Electron 内嵌）

Electron 运行时内含 Chromium。其完整许可文本随 Electron 发行版提供，便携目录与安装包中均包含
`LICENSES.chromium.html`（由 `node_modules/electron/dist` 原样复制）。分发时**不要删除该文件**。

Electron 自身的 MIT 许可原文在便携根被保留为 `LICENSES.electron.txt`（避免与本项目的 `LICENSE` 同名覆盖）；
其文本同时抄录于本文件第 2 节。

---

## 4. 仅用于构建、不随产物分发的依赖

以下依赖只在**构建 / 测试期**使用，不进入 `bin/chenxi.mjs`、桌面 app payload 或安装包：
TypeScript（Apache-2.0）、esbuild（MIT）、Biome（MIT OR Apache-2.0）、Vitest（MIT）、tsx（MIT）、
`@types/node`（MIT）。它们各自的许可文本位于对应 npm 包内，不入库。
