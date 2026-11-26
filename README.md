# DupeSeek

DupeSeek 是一个面向 Windows / Linux 的重复文件查找与管理工具，使用 Electron + Vue 3 + TypeScript 开发。

## 功能

- **多目标扫描**：添加多个目录或单个文件作为目标（系统对话框或拖拽），目标列表自动持久化。
- **快速查重**：优先用本机 Everything 索引枚举（不可用自动回退常规遍历）；按「文件名+大小 → crc32 → 前 1MB md5 → 全量 md5」阶梯判定重复，尽量少读盘。
- **压缩包内查重**：zip / 7z / rar 内的文件参与比对（可关闭），RAR 使用随应用分发的原生 unrar。
- **空间分析**：目录体积树（排序、列宽调整、虚拟滚动、系统图标），行右键可对单个位置应用清理范围、刷新该分支、查看分支统计（体积/数量 + 大小分布直方图）。
- **清理规则**：重复组列表、扩展名/体积/路径筛选、保留规则选择器、「勾选 = 待清理」+ 范围规则；删除进回收站。
- **体验**：亮/暗主题（跟随系统）、Win11 Mica 与自绘标题栏、无菜单栏、虚拟滚动大列表。

## 查重策略

```
L0 文件名+大小分桶（可改为仅按大小）
L1 crc32 门控（仅纯压缩包条目桶，元信息免费获得）
L2 headMD5（前 1MB，不同即独立）
L3 fullMD5（相同即重复）
```

空文件免哈希成组；junction/符号链接子树默认排除（防假重复组与删除后失效）；嵌套目标按路径全局去重；硬链接按独立文件处理（已知统计偏高，见文档）。

## 开发

```sh
npm install
npm run dev        # 开发模式（electron-vite）
npm run test       # vitest 引擎回归（依赖 Windows 路径语义）
npm run typecheck  # 主进程 + 渲染层类型检查
npm run lint
npm run build      # 类型检查 + 打包构建
npm run build:win  # Windows zip 产物
```

Node 22+、npm；无 pnpm/yarn 锁文件，请勿引入。

## 平台支持

- Windows：完整功能（Everything 加速、UAC 提权重扫、reparse 处理）。
- Linux：功能对齐，无 Everything 通道（回退遍历）、不做提权、RAR 与 Windows 对齐。
- macOS：不出包、未真机验证（详见 docs/KnownIssues.md）。

## 文档

设计文档在 `docs/`：整体架构 `DupeSeek.md`、IPC `IPC.md`、数据模型 `DataModel.md`、状态管理 `Store.md`、各视图 `Scan.md` / `DupeList.md` / `Cleanup.md` / `TreeSize.md` / `TargetList.md` / `Settings.md` / `UI.md` / `Tabs.md`，平台差异 `KnownIssues.md`，持久化 `Database.md`。

## 已知限制

- 清理目前只有「删除进回收站」；硬链接、合并移动为后续迭代。
- 设置保存为 `settings.json`，**没有** SQLite；扫描结果不落库（会话内）。
- 「更新该分支」的组收敛、刷新期目标同步等缺口记录在 `docs/Cleanup.md`「已知缺口」。
