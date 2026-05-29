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

项目有迭代，以上简述可能已过期，请以 docs 目录内的实际文档为准。

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
