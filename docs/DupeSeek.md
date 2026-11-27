# DupeSeek 设计文档

## 架构

- 标准 Electron + Vue 3 + TypeScript 三层架构：主进程做文件系统与计算，渲染层做界面，preload 经 contextBridge 暴露受控 API；类型统一在 `src/shared/`。前后端经 IPC 通信（协议见 [IPC.md](./IPC.md)），确保界面响应、同时能处理大量文件的扫描与识别。
- 识别阶梯（详见 [DataModel.md](./DataModel.md) §4）：**L0 文件名+大小分桶 → crc32 门控（仅压缩包条目）→ 前 1MB headMD5 → 全量 fullMD5**，在速度与准确性间折中；空文件免哈希直接成组。默认同名同大小才进后续比较（`ignoreName` 可改为仅按大小）。
- 前端使用虚拟列表（virtua VList，`VirtualScrollList.vue`）展示大列表；状态管理用 Pinia（见 [Store.md](./Store.md)），组件与布局解耦、一律通过 store 交换数据。
- 后端异步化：枚举走异步 fs walk 或 Everything；md5（head/full）与压缩包解压哈希运行在 worker_threads 线程池（`HashPool`，**固定 4 个 worker**）。4 是实测折中——SSD 海量小文件 8 路快 25–35%，但 HDD 大文件 8 路并发寻道反而比单流慢 16–21%。worker 崩溃自动重建，权限不足计数并入进度。
- 未来优化点——**介质感知 worker 调度**：网络盘/光盘等介质最优并发差异大，待成熟后按介质与大小分布动态调整（HDD 大文件 fullMD5 建议串行）。
- 设置持久化为 `settings.json`（userData 目录），**当前没有 SQLite**（见 [DataModel.md](./DataModel.md) §9、[Database.md](./Database.md)）。

## 文件枚举与平台差异

- 首选 **Everything**：检测 `resources/bin/es.exe`（随应用分发；另探测 Program Files 下的 Everything）并确认 Everything IPC 可达，用 `-path <目标> -export-json` 获取清单。**每目标 3 次查询**：`/a-d`（文件）、`/ad`（目录）、`/aL`（reparse 清单）；导出产物（可达数百 MB）的读盘与 `JSON.parse` 在 worker 线程执行，避免主进程卡死。未安装、未运行、目标未收录（如非 NTFS 卷）或查询失败时**逐目标**回退 fs walk，其余目标不受影响。es 属性开关实测矩阵（1.1.0.37）：每个开关只携带一个属性时语义正确（`/a-d`、`/ad`、`/aL`、`/a-L`、`/ad-L`），多属性塞进单个开关的组合形式损坏——因此 reparse 剔除统一用 `/aL` 清单做内存前缀比较，不逐目录 lstat。
- **为何必须剔除 junction 子树**：junction 让同一物理文件可经多条路径到达，若不剔除，链接路径与真实路径下的同一文件会各自入列、md5 相同，形成「文件与自己配对」的假重复组；对清理而言删除任一路径后其余路径立即失效。故 reparse 子树整体排除（`excludeJunction`，默认开）。Everything 通道连 reparse 文件（文件符号链接/云占位）一并跳过：前者避免穿越链接，后者避免触发云端下载。**已知**：fs walk 回退通道会静默跳过文件符号链接（到底层 dirent 既非 file 也非 dir），见 [KnownIssues.md](./KnownIssues.md) KI-4。
- **硬链接按独立文件处理**（与 junction 相反的设计约定）：硬链接不是 reparse point，两个枚举通道照常列出每个路径，引擎零特判——同 inode 的多路径各计一份体积（TreeSize 相应双计）、各算各的哈希，正常进入重复分组与清理。明确不利用「同 inode 即必然重复」的捷径，保持处理路径平凡。代价：重复读盘算哈希（量级通常可忽略）；「浪费空间」与清理释放量对硬链接组偏高（删除一个路径不释放数据）。
- **嵌套目标语义**：条目以路径为键全局唯一（Windows 大小写归一），目标降级为「扫描根 + 归属标记」。枚举注册即去重：被既有目标覆盖的路径直接跳过——后加被覆盖的子目标 0 新增 0 哈希秒完成；后加父目标只收增量，杜绝「自己配自己」的假重复与全盘 md5 风暴。移除目标时其条目向剩余覆盖者**重归属**（数据保留），无人覆盖才删除并从重复组剔除；删父不连坐删子。体积树中嵌套目标既作根行、又是父目标展开后的子行——同一份聚合数据多处引用，体积可加性在树内保持。
- **自动增量扫描**：目标列表变化（启动恢复、添加、删除）即自动同步——新增目标仅枚举并与现有条目比桶（现有条目哈希记忆化保留，不重复读盘；新增条目只在 L0 同桶时才触发哈希）；移除目标纯内存清理，零磁盘 I/O。正在扫描时发生的变化记挂起标记，本轮结束后自动补一轮增量同步。引擎为持久会话：条目清单与已确认组跨操作存活，组按 key 幂等回流。**「重新扫描」按钮**才会清空会话做全量重扫。
- 目录排除为双输入框：「排除的目录名」匹配任意层级同名目录（默认 `node_modules`）：「排除的目录路径」按绝对路径排除整棵子树。被排除目录以空节点呈现（可见、0 字节、不可展开、无文件），目标本身被排除时整个目标为空。

## 空间分析与体积树

- 体积树的权威数据在主进程（全局条集聚合 + dirs/childDirs/dirFiles 索引）；前端不持有全量树、不做计算，只发四类查询：`tree:roots` / `tree:children(dir)` / `tree:files(dir, offset, limit)` / `tree:stats(path)`，排序键与方向作为参数由后端执行。前端只缓存**曾展开过**的路径，GUI 侧内存从 O(全盘) 降为 O(曾展开)（折叠/重扫不释放缓存，见 [TreeSize.md](./TreeSize.md)「已知限制」）。
- `scan:progress` 不捎带树数据，只携带 `treeRev` 版本号；另有一条独立的 `scan:rev` 广播用于移除目标、分支刷新等不伴随 progress 的变更。前端按版本失效缓存、仅重取已展开路径，400ms 尾沿节流。
- 体积口径：文件体积沿祖先链累加到目标根；重复占用按「每组保留 mtime 最早的一份，其余副本体积计入各自目录链」归集。压缩包内容在树中呈现为 `容器路径::` 合成目录链，包内条目体积只累加到合成根、不进入真实目录（避免与压缩后包体积重复计账）；包内条目不可独立清理。
- 空间分析视图（[TreeSize.md](./TreeSize.md)）提供树形列表与行右键菜单（见 [Cleanup.md](./Cleanup.md)）；「统计数据」弹窗（`StatsPanel.vue`）给出分支体积/文件数/目录数/平均体积 + k-means 大小分布直方图，**没有**矩形树图或文件类型饼图（旧设计已废弃）。

## 压缩包处理

- 压缩包（zip/7z/rar）视为特殊目录：元信息（size/crc32）经 7za `-slt` 与 node-unrar-js（WASM）读取，条目以 `容器::包内路径` 建条；纯压缩包桶先做 crc32 门控，head/full 比较时解压并流式哈希——zip/7z 走 `7za x -so`；rar 走原生 `unrar`。
- **RAR 数据获取实测结论（重要）**：`unrar p -inul`（无条目过滤的全量流）在 UnRAR 7.30 beta 1 上会确定性跳过尾部条目（vosscript.normal.rar：9487 条仅输出 9433 条，两轮一致；`unrar t` 全过、逐条独立解压正常，排除包损坏）。因此 RAR 数据获取**只用 `unrar x` 批量解压到临时目录**（带完成标记跨操作复用），流式 `p` 方案已弃用（仅作解压失败条目的兜底）。三平台原生 unrar 已随应用内置（win 7.30b1 / linux 7.23 / mac 7.23+7.12，见 `resources/bin/unrar/README.md`），`unrarExe()` 按 platform/arch 解析；平台定案见 [KnownIssues.md](./KnownIssues.md)。
- 压缩包内容解析可在「软件设置」页关闭（关闭时压缩包视作普通文件，仅比对包文件本身）；压缩包文件本身始终参与比对。

## UI

- 窗口有最小尺寸限制（900×600，默认 1200×800），保证界面元素正常显示；无菜单栏。
- 主界面：左侧「目标列表」（TargetList，280px 开放式窗格），右侧为顶部标签页 + 对应功能界面（KeepAlive 保活）。标签页六个，见 [Tabs.md](./Tabs.md)：
  - 空间分析（TreeSizeView）——体积树 + 分支统计；
  - 关系气泡（RelationForceView）——目录关系力导向气泡图，Phase 1 探索性视图，见 [Relations.md](./Relations.md)；
  - 关系捆绑（RelationBundleView）——目录关系径向树 + 层次边捆绑，见 [Relations.md](./Relations.md)；
  - 扫描参数（ScanView）——扫描选项、进度、提权提示与汇总；
  - 清理规则（DupeList）——重复组、筛选、勾选待清理与删除；
  - 软件设置（SettingsView）——Everything / 压缩包解析开关、主题、RAR 能力检测。
- 目标的添加/删除不占用标签页：由左侧列表通过系统对话框、拖拽（系统拖放）与悬停操作完成。
- 视觉遵循 Fluent 2（亮/暗双主题、Win11 Mica、自绘标题栏、内联 Fluent 图标），规则见 [UI.md](./UI.md) 与 AGENTS.md「视觉设计」。

## 组件与功能设计

- 基于 Vue 单文件组件，`components/` 平铺页面级与通用组件，`stores/` 管状态，`utils/` 放格式化/主题等纯函数（没有 `feature/`、`layouts/` 目录）。
- 页面级组件：`TreeSizeView.vue`、`ScanView.vue`、`DupeList.vue`、`SettingsView.vue`；通用组件：`TargetList.vue`、`TreeList.vue`、`VirtualScrollList.vue`、`ContextMenu.vue`、`StatsPanel.vue`、`ConfirmDialog.vue`、`AppIcon.vue`、`TreeIcon.vue`。
- 布局与功能组件解耦，组件间只通过 Pinia 交换数据，经 contextBridge 与后端交互。

### 文档索引

- 功能组件：[Scan.md](./Scan.md)、[DupeList.md](./DupeList.md)、[TreeSize.md](./TreeSize.md)、[Cleanup.md](./Cleanup.md)、[Tabs.md](./Tabs.md)、[Settings.md](./Settings.md)、[TargetList.md](./TargetList.md)、[UI.md](./UI.md)。
- 技术设计：[DataModel.md](./DataModel.md)、[IPC.md](./IPC.md)、[Store.md](./Store.md)、[Database.md](./Database.md)、[KnownIssues.md](./KnownIssues.md)。

## 清理与扩展功能

- 清理入口在「清理规则」页：勾选即待清理，配合选择器/范围规则快速圈定；确认后删除进回收站。空间分析行右键可对单个位置应用清理范围，或单独刷新该子树（不改变目标列表）。规则与不变量见 [Cleanup.md](./Cleanup.md)。
- 当前**仅实现**「删除进回收站」；硬链接、合并移动为后续迭代（`DataModel.md` §6 已预留 `keepPaths`）。
- 设置持久化、RAR 能力检测、UAC 提权重扫等系统能力见 [Settings.md](./Settings.md)、[KnownIssues.md](./KnownIssues.md)。

## 数据结构与算法

见 [DataModel.md](./DataModel.md)（条目/组/树/范围规则等共享类型）与 [Cleanup.md](./Cleanup.md)（清理不变量与统计口径）。实现集中在 `src/main/scan/engine.ts`。
