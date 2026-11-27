# Agents.md

本项目为 Electron + Vue 3 + TypeScript 开发的重复文件查找与管理工具。包含如下功能：

* 添加待扫描的目标目录或单个文件，可同时添加多个（系统对话框与拖拽）。
* 枚举目标下的文件（Everything 加速，不可用自动回退 fs walk），按「文件名+大小 → crc32（仅压缩包）→ headMD5 → fullMD5」阶梯判定重复；zip/7z/rar 内条目参与比对；扫描前可设置筛选规则（隐藏/系统/大小/扩展名/目录排除/junction 排除）。
* 列出重复组，提供筛选、保留规则选择器与按位置/勾选批量圈定待清理项；当前清理方式为删除进回收站（硬链接、合并移动为后续迭代）。
* 在扫描数据基础上提供扩展视图：空间分析体积树（排序、列宽调整、行右键操作、分支统计直方图）；目录关系视图（「关系气泡」力导向图 / 「关系捆绑」层次边捆绑，Phase 1 以目录为展示单元）。

## 架构

采用三层 Electron 架构：

src
├─ main/ — Node.js 后端。创建 BrowserWindow（Win11 Mica / 自绘标题栏）、注册 IPC；扫描引擎（scan/engine.ts：持久会话+增量）、枚举（Everything es.exe 与异步 fs walk）、压缩包（7za / node-unrar-js / 内置原生 unrar）、哈希 worker 池（固定 4 线程）、清理（删除进回收站）、设置（settings.json）、图标与能力检测。
├─ preload/ — 通过 contextBridge 暴露受控 API：window.api（DupeSeekApi：18 个 invoke + 1 个 send + 5 个事件订阅）与 window.electron（@electron-toolkit/preload）。
├─ renderer/src/ — Vue 3 + Pinia 单页应用，virtua 虚拟滚动；关系视图依赖 d3-force / d3-hierarchy / d3-shape（按需 import）。
│    ├─ assets/ 主题令牌（main.css 亮/暗）
│    ├─ components/ 页面级与通用组件（没有 feature/、layouts/ 目录）
│    ├─ stores/ Pinia：settings / target / scan / dupe / treesize / graph / icons / ui
│    └─ utils/ 格式化、主题、响应式拍平
└─ shared/ — 三端共享类型（types.ts）、默认扫描参数、错误判定。

另有 tests/（vitest 引擎回归）、tools/（基准与诊断脚本）、docs/（设计文档）。

## 设计文档

设计文档均包含在工程目录下的 ./docs/ 目录内，包含若干文档。

* DupeSeek.md — 整体架构、枚举/哈希/压缩包/UI 设计
* Scan.md — 扫描参数视图（ScanView.vue）
* DupeList.md — 清理规则视图（DupeList.vue）
* Cleanup.md — 清理范围规则与分支操作（右键菜单 / refreshBranch / 统计口径 / 已知缺口）
* TreeSize.md — 空间分析视图（体积树拉取协议）
* Relations.md — 目录关系视图（关系气泡 / 层次边捆绑，Phase 1 数据契约与已知限制）
* Tabs.md — 标签页切换逻辑
* Settings.md — 软件设置视图
* TargetList.md — 左侧目标列表
* UI.md — 整体界面布局、主题与视觉实现
* DataModel.md — 共享类型定义与分组阶梯
* IPC.md — 前后端 IPC 通信协议
* Store.md — Pinia 状态管理设计
* Database.md — 数据持久化（当前 settings.json；SQLite 为计划、未实现）
* KnownIssues.md — 平台与文件系统差异（mac 未出包、Linux 不提权、符号链接跳过、硬链接双计等）

项目有迭代，以上简述可能已过期，请以 docs 目录内的实际文档为准。

## 视觉设计（Fluent 2）

界面视觉遵循 Fluent 2（Win11 设计语言），基准参考 files-community/Files 与 fluent2.microsoft.design。以下为设计法则，新界面与改动必须遵守：

* 字体栈：`'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei'`——不引入打包字体。
* 强调色：亮色 `#0067c0`，暗色 `#4cc2ff`（Win11 系统蓝系）；危险等语义色跟随 Fluent 语义。
* 主题：亮 / 暗双主题，默认跟随系统（`prefers-color-scheme`），设置页可手动切换。所有颜色必须走 main.css 的主题令牌（`:root` 与暗色作用域），组件内禁止硬编码明暗色值。
* 窗口：Windows 全部启用 `titleBarStyle: hidden` + 透明 `titleBarOverlay` 自绘标题栏；Win11（build ≥ 22621）追加 Mica 质感（`backgroundMaterial`），Win10 无 Mica 但仍自绘标题栏——视觉改动必须验证「无 Mica」的降级形态。
* 图标：界面装饰图标用 Fluent UI System Icons（MIT）或等价线性图标，禁止用 emoji 充当功能图标；文件内容图标走系统图标服务 `getFileIcon`（large 源），目录优先 desktop.ini 自定义图标、否则内置文件夹图标（盘根取 `getFileIcon` 的盘符图标）。
* 列表：悬停 / 选中 / 聚焦三态齐备；加载用骨架屏（shimmer）而非纯文字提示。
* 圆角基准：容器 8px、行内元素 4px；信息提示用彩边 info-bar 样式（着色背景 + 图标 + 动作）。
* 样式参考库：`vendor/fluentui-web-components/`（组件 CSS 与结构）与 `vendor/fluentui-tokens/`（设计 token 值，亮/暗主题在 `vendor/fluentui-tokens/src/alias/`）是 Fluent UI Web Components v3 的源码快照，仅作阅读摘抄之用——禁止运行时 import，禁止修改；从其摘抄样式时在目标文件注释中注明出处（组件名 + token 名）。
* 暗色主题、Mica 与自绘标题栏已实现（2026-11 起）；后续视觉改动继续向 Fluent 2 收敛，不得引入偏离该方向的样式。

## 变更日志

根目录 CHANGELOG.md 是面向用户的变更记录，发布时其对应版本段落会被 release 工作流提取为 GitHub Release 正文。

* 每次主要功能变动、行为变更或用户可感知的修复，合入 dev 前必须同步追加到 CHANGELOG.md 顶部「未发布」段落（按 新增 / 变更 / 修复 分类）。
* 发布打 tag 前，把「未发布」段落改写为 `## <三段式版本号> — <日期>`，并在其上新建空的「未发布」段落。

## 开发协作流程

* 每次代码改动完成后，自动用新代码重启应用供用户即时检查：先结束正在运行的旧实例（Windows：按窗口标题 `DupeSeek` 定位 electron.exe 主进程再结束，不要按映像名整体误杀其它 Electron 应用），再后台启动 `npm run dev` 并确认窗口拉起。
* 合入 dev 前必须通过 `npm run test`（vitest，覆盖引擎纯逻辑；依赖 Windows 路径语义，CI 在 windows-latest 上执行）。修复 bug 时先在 tests/ 补一条能复现该 bug 的回归用例，再修代码。
* 代码的行为、类型、IPC 通道、组件结构发生变化时，必须同步更新 docs/ 对应文档与 AGENTS.md 的架构/文档索引；文档与代码不一致视为缺陷。

## Never 规则
- Never 修改 build/ 产物
- Never 在组件内使用 any 类型
- Never 在渲染路径中执行耗时操作
- Never 硬编码敏感信息

## Build Command

```sh
npm run lint
npm run typecheck
npm run start
npm run dev
npm run build
```
