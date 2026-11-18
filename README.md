# blc-plugin-template · 大懒猫创作平台插件模板

**简体中文** | [English](README.en.md)

一个**开箱即跑**的插件起点工程：后台命令、浏览器视图、页面状态保存、构建配置、测试与发布工作流都配好，clone 下来改几个名字就能开始写自己的插件，不用从空目录猜清单格式。

仓库：<https://github.com/biglazycat-writer/blc-plugin-template>

| 项目 | 值 |
| --- | --- |
| 插件 API | `biglazycat.apiVersion = 1` |
| 运行环境 | Node `>=22.23.3 <23.0.0`（宿主提供，安装包不内嵌 Node） |
| 后台 | TypeScript → `dist/main.js` |
| 页面 | TypeScript + Vite → `dist/ui/index.html`（原生 DOM，可换 React/Vue） |
| 测试 | `node:test`，mock `PluginContext`，不需要启动宿主 |
| SDK | 锁定精确版本，见 `package.json` |
| 示例内容 | 3 个命令、1 个视图、2 个菜单入口、6 个平台声明 |

## 从这里开始

### 方式一：GitHub 模板仓库（推荐）

本仓库已开启 GitHub **Template repository**。在仓库页点 **Use this template → Create a new repository**，生成的新仓库不带模板的提交历史；也可以命令行创建：

```bash
gh repo create my-plugin --template biglazycat-writer/blc-plugin-template --private --clone
cd my-plugin
```

### 方式二：clone 后换成自己的仓库

```bash
git clone https://github.com/biglazycat-writer/blc-plugin-template.git my-plugin
cd my-plugin
git remote remove origin          # 或直接 set-url 指向你自己的仓库
git remote add origin https://github.com/<你的账号>/my-plugin.git
npm install
```

### 方式三：只要一个本地工程

下载 ZIP 解压到任意目录，或用宿主的 MCP `plugin_project_create` 生成空工程后，把本模板的 `src/`、`package.json`、`package-lock.json` 等复制过去。

## 必改清单

改完运行 `npm run build && npm test` 确认通过：

| # | 位置 | 模板里的值 | 改成 |
| --- | --- | --- | --- |
| 1 | `package.json` → `name` | `blc-plugin-template` | 你的包名，例如 `blc-plugin-weather` |
| 2 | `package.json` → `description` / `version` | 模板说明 / `0.1.0` | 你的描述与版本 |
| 3 | `biglazycat.displayName` / `description` | 插件模板 · Hello World | 插件在宿主里显示的名称与说明 |
| 4 | `biglazycat.contributes.commands[].id` | `template.*` | 换成你的前缀，例如 `weather.*` |
| 5 | `src/main.ts` 的 `ctx.commands.register(...)` | 同上三个 ID | **必须与清单逐字一致**，否则宿主启用时会拒绝 |
| 6 | `biglazycat.contributes.views` / `menus` | `main`、`template.open` | 你的视图 ID/标题与菜单命令引用 |
| 7 | `README.md` 标题与仓库链接 | 本文件 | 你自己的文档 |

其他约定：

- `aiCallable` / `externalEffect` 如实标注；只有真正写外部系统的命令才设 `externalEffect: true`；
- 新增命令时**同时**改清单和 `src/main.ts`；所有命令都在激活期注册；
- 页面入口 `entry` 指向构建产物 `dist/ui/index.html`，不要改成源码路径；
- `scripts/package.mjs` 与 `.github/workflows/release.yml` **不需要改**：包名、版本、产物文件名都从 `package.json` 读取，改完 `name` / `version` 即可直接复用。

## 开发命令

```bash
npm ci                # 从锁文件安装依赖（SDK 为锁定精确版本）
npm run typecheck     # UI 与后台两份 tsconfig 严格类型检查
npm run build         # tsc 编译后台到 dist/main.js，Vite 打包页面到 dist/ui/
npm test              # node:test，依赖 dist/main.js，先 build
npm run package       # 生成插件包 dist-package/<name>-<version>.tgz 与 SHA-256
```

`dist/` 与 `node_modules/` 不进版本库；`package-lock.json` 必须提交。宿主的平台准备流程用 `npm ci` 安装，首次安装需能访问 npm registry。

## 打包与安装

`npm run package` 按 `package.json` 的 `files` 字段组装 `package/` 目录、打包、校验结构并生成 SHA-256，产物在 `dist-package/`。**请直接用这个脚本**：桌面端安装插件包时只剥离 `package/` 前缀并读取解压根目录的 `package.json`，自己用 zip/tar 打包很容易踩「找不到 package.json」的坑。

桌面端安装：插件中心 → 安装插件 → 插件包，选择 `.tgz`，**勾选「准备依赖、类型检查并构建」**（包内不含 `node_modules`）。

发布 Release：改 `package.json` 的 `version`（可选补 `CHANGELOG.md` 段落，Release notes 自动取用），推送 `v*` 标签，工作流自动构建、测试、打包并创建 Release。标签必须等于 `v` + 版本；只想验证构建时在 Actions 页面手动运行 Release 工作流、`tag` 留空。

## 模板演示了什么

**后台（`src/main.ts`）**：激活期注册命令、返回停用清理函数；`invocation.signal` 协作取消、`progress()` 报告进度；`ctx.views.open()` 打开视图并传上下文。

**页面（`src/ui/main.ts`）**：`connect()` 连接宿主，`context()` 取回会话与恢复状态；`commands.invoke()` 返回宿主任务，用 `waitForTask` 限时等待；`setState` / `onSave` 处理状态保存——不要把大文件或机密放进 state。页面用原生 DOM 构建，换 React/Vue 只改 `src/ui` 与 `vite.config.mjs`。

**测试（`tests/plugin.test.mjs`）**：mock 宿主上下文，校验清单命令与注册一致、返回值/进度/取消、视图参数自洽。不联网、不启动宿主。新增命令时同步补一条测试。

## 安装到宿主（开发模式）

外部 AI / MCP 开发的完整流程见帮助中心「插件开发」。要点：宿主「系统设置」配置 Node/npm 并启用 MCP 插件工具；`plugin_install`（development:true）后修改源码会自动类型检查、构建并刷新页面；构建失败看 `plugin_diagnostics`。页面只能在宿主内打开——直接用浏览器打开 `dist/ui/index.html` 会报 `API_MISMATCH`。

## 继续开发

完整签名见 npm 包 [blc-plugin-sdk](https://www.npmjs.com/package/blc-plugin-sdk) 的 `index.d.ts` 与 [SDK 仓库 README](https://github.com/biglazycat-writer/blc-plugin-sdk#readme)：

- `ctx.credentials` 存取密钥（Windows 为 DPAPI），**绝不**写入配置或日志；
- `readDocument` 读取 Markdown 固定快照（声明 `minimumApiRevision: 1` 后可用）；`ctx.workspace` 与 `ctx.images` 读工作区资源与图片；
- `ctx.services` / `ctx.events` / `contributes.schedules`：服务、事件与定时任务。

设计功能时记住几条硬限制：单次命令结果 **< 1 MiB**、页面状态最多 64 KiB，大内容必须自己分段传输（可参考官方 `blc-plugin-publish` 插件）；取消、退出与超时可能留下 `uncertain` 的外部结果，不要自动重试有副作用的操作；原生模块需匹配系统、架构与 Node ABI。

## 排错

| 现象 | 检查 |
| --- | --- |
| 启用时提示命令不一致 | 清单 `contributes.commands[].id` 与 `src/main.ts` 注册 ID 逐字比对 |
| `Cannot find module '../dist/main.js'` | 测试前先 `npm run build` |
| `API_MISMATCH` | 页面必须在宿主插件视图内打开，不能用普通浏览器 |
| 构建失败 | 看 `npm run typecheck` 输出与宿主 `plugin_diagnostics` |
| `npm ci` 报引擎不匹配 | 宿主要求 `engines.node` 指定的 Node `>=22.23.3 <23.0.0` |
| `npm install` 找不到 `blc-plugin-sdk` | 检查 npm registry 可达性和依赖声明 |
| 页面刷新后状态丢失 | 确认调用了 `setState`，且 `onSave` 里写回了状态 |

## 授权

SDK 包 [blc-plugin-sdk](https://github.com/biglazycat-writer/blc-plugin-sdk) 为 MIT。本模板的示例代码可自由复制、修改并用于你自己的插件项目，无需署名；仓库整体的开源授权由维护者决定。
