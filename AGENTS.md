# Agents.md

本项目为 Electron + Vue 3 + TypeScript 开发的重复文件查找与管理工具。包含如下功能：

* 添加待扫描的目标目录，可以同时添加多个目录。
* 扫描指定目录及子目录下的所有文件、文件夹、压缩文档等，通过 md5 及 crc32 来判断重复文件。对于具体的任务，可以设置扫描前的筛选规则。
* 列出扫描后得到的重复文件列表，提供若干选择器功能帮助选定符合用户需要的重复文件，并提供多种清理方式。
* 在扫描获得文件数据的基础上，本工具还能提供一些扩展功能，例如 treesize 视图、文件类型饼图等。

## 架构

采用三层 Electron 架构：

src
├─ main/ — Node.js 后端。负责创建 BrowserWindow，注册用于原生对话框（select-directory）和文件系统操作（scan-dir）的 IPC 处理器。当前使用 fs.readdirSync（同步、阻塞式）。
├─ preload/ — 通过 contextBridge 暴露受控 API。当前暴露了 window.api.selectDirectory() 和 window.electron（来自 @electron-toolkit/preload）。
└─ renderer/src/ — 使用 Pinia 进行状态管理的 Vue 3 单页应用。
     ├─ Assets/ 项目资源，含图标等
     ├─ components/ 通用组件，例如 virtual-scroll
     ├─ feature/ 用于承载功能的组件，例如 Explore.vue
     └─ layouts/ 布局组件，通常没有实际显示。

## 设计文档

设计文档均包含在工程目录下的 ./docs/ 目录内，包含若干文档。

* DupeSeek.md — 整体架构与 UI 设计
* Explorer.md — 文件系统浏览器组件
* Scan.md — 重复文件扫描设置组件
* DupeList.md — 重复文件列表与管理组件
* TreeSize.md — 空间分析可视化组件
* Tabs.md — 标签页切换逻辑
* Settings.md — 全局应用设置组件
* DataModel.md — 共享类型定义
* IPC.md — 前后端 IPC 通信协议
* Store.md — Pinia 状态管理设计
* Database.md — SQLite 数据库设计
* KnownIssues.md — 平台与文件系统差异（已知问题：mac 未出包、Linux RAR 解压缺失、符号链接跳过等）

项目有迭代，以上简述可能已过期，请以 docs 目录内的实际文档为准。

## 视觉设计（Fluent 2）

界面视觉遵循 Fluent 2（Win11 设计语言），基准参考 files-community/Files 与 fluent2.microsoft.design。以下为设计法则，新界面与改动必须遵守：

* 字体栈：`'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei'`——不引入打包字体。
* 强调色：亮色 `#0067c0`，暗色 `#4cc2ff`（Win11 系统蓝系）；危险等语义色跟随 Fluent 语义。
* 主题：亮 / 暗双主题，默认跟随系统（`prefers-color-scheme`），设置页可手动切换。所有颜色必须走 main.css 的主题令牌（`:root` 与暗色作用域），组件内禁止硬编码明暗色值。
* 窗口：Win11 上启用 Mica 质感（`backgroundMaterial`）与 `titleBarOverlay` 自绘标题栏，Win10 自动回退系统标题栏——视觉改动必须验证降级形态。
* 图标：界面装饰图标用 Fluent UI System Icons（MIT）或等价线性图标，禁止用 emoji 充当功能图标；目录/文件内容图标仍走系统图标缓存（getFileIcon，large 源）与 desktop.ini 自定义图标。
* 列表：悬停 / 选中 / 聚焦三态齐备；加载用骨架屏（shimmer）而非纯文字提示。
* 圆角基准：容器 8px、行内元素 4px；信息提示用彩边 info-bar 样式（着色背景 + 图标 + 动作）。
* 暗色主题与 Mica 为既定方向、尚未实现——涉及视觉的改动应向该方向收敛，而不是引入偏离它的样式。

## 变更日志

根目录 CHANGELOG.md 是面向用户的变更记录，发布时其对应版本段落会被 release 工作流提取为 GitHub Release 正文。

* 每次主要功能变动、行为变更或用户可感知的修复，合入 dev 前必须同步追加到 CHANGELOG.md 顶部「未发布」段落（按 新增 / 变更 / 修复 分类）。
* 发布打 tag 前，把「未发布」段落改写为 `## <三段式版本号> — <日期>`，并在其上新建空的「未发布」段落。

## 开发协作流程

* 每次代码改动完成后，自动用新代码重启应用供用户即时检查：先结束正在运行的旧实例（Windows：按窗口标题 `DupeSeek` 定位 electron.exe 主进程再结束，不要按映像名整体误杀其它 Electron 应用），再后台启动 `npm run dev` 并确认窗口拉起。
* 合入 dev 前必须通过 `npm run test`（vitest，覆盖引擎纯逻辑；依赖 Windows 路径语义，CI 在 windows-latest 上执行）。修复 bug 时先在 tests/ 补一条能复现该 bug 的回归用例，再修代码。

## Never 规则
- Never 修改框架自动生成的目录
- Never 修改 build/ 产物
- Never 在组件内使用 any 类型
- Never 使用内联样式
- Never 在渲染路径中执行耗时操作
- Never 在列表渲染中省略 key
- Never 硬编码敏感信息
- Never 修改 lock 文件

## Build Command

```sh
npm run lint
npm run typecheck
npm run start
npm run dev
npm run build
```
