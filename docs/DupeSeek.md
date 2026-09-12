# DupeSeek 设计文档

## 架构

* 标准的 electron + vue3 + typescript 架构，前端使用 vue3 进行界面开发，后端使用 electron 进行文件系统操作和重复文件识别。
* 前端和后端通过 IPC（进程间通信）进行数据交换，确保界面响应迅速，同时能够处理大量文件的扫描和识别任务。
* 综合使用 文件名 + 文件大小 + 前1MB md5 + 全文件 md5 + 全量 CRC32 进行重复文件识别，以实现速度和准确性的平衡。CRC32 用于快速比较压缩包内文件而无需解压，md5 用于更准确的重复文件识别。
* 前端使用 virtual list 技术来高效地展示大量文件信息，确保界面流畅。
* 前端使用 pinia 进行状态管理，确保应用状态的一致性和可维护性。
* 前端的 layout 组件和 UI 功能组件分离，确保代码的模块化和可复用性。
* 后端使用多线程或异步处理来加速文件扫描和哈希计算，避免界面卡顿。当前实现：md5（headMD5/fullMD5）计算运行在 worker_threads 线程池（`HashPool`，worker 数 `min(8, CPU核数-1)`，崩溃自动重建），设置持久化当前为 JSON 文件。
* 文件枚举优先走 Everything：检测 `resources/bin/es.exe`（随应用分发）并确认 Everything IPC 可达，用 `-path <目标> -export-json` 获取文件与目录清单；未安装、未运行、目标未收录（如非 NTFS 卷）或查询失败时，**逐目标**回退 fs.walk。junction/符号链接目录经引擎侧 lstat 识别并按子树剔除。es 属性开关实测矩阵（1.1.0.37，以 /aL 的 junction 清单为真值）：`/a-d`（纯文件）✓、`/ad`（全部目录，junction 交由引擎 lstat 剔除）✓、`/ad-L`（目录排除 reparse）✓、**`/a-d-L` ✗（L 排除在场时 D 排除失效，目录漏入）**——目录查询勿用 `/a-d-L`，否则 junction 子树过滤会因"看不到 junction 目录"而失效。
* 哈希 worker 数固定为 4（基准实测的折中：SSD 海量小文件 x8 比 x4 快 25-35%，但 HDD 大文件全量读 8 路并发寻道竞争反而比单流慢 16-21%，x4 居中）。基准脚本见工程根目录 bench-async.mjs / bench-sync.mjs。
* **未来优化点——介质感知 worker 调度**：存储介质除 HDD/SSD 外还可能是网络挂载盘、光盘等，各自最优并发差异很大。待软件成熟后引入介质探测（`Get-PhysicalDisk` MediaType / IO 花费采样），按介质与文件大小分布动态调整 worker 数与大文件全量读的并行度（HDD 大文件 fullMD5 建议串行）。
* 压缩包（zip/7z/rar）视为特殊目录：元信息（size/crc32）经 7za `-slt` 与 unrar（WASM）读取，条目以 `容器::包内路径` 建条；纯压缩包桶先做 crc32 门控，head/full 比较时解压到内存并流式哈希——rar 走原生 `resources/bin/UnRAR.exe`（`p -inul` 流式输出，注意包内路径需反斜杠），7za 走 `x -so`。体积树中压缩包显示为合成目录节点（包内体积按解压后大小计），包内副本不可独立清理。
* 后端使用 sqlite 数据库来存储扫描结果和用户设置，确保数据的持久化和下次的快速访问。

## UI

* 整个 electron 窗体有最小长宽限制，确保界面元素的正常显示。
* 主界面分为软件功能设置栏（Settings）， '操作目标列表 (TargetList)' 和右侧的 '多 tab 操作切换区'，右侧通过 tab 切换不同的操作和功能界面。Tab 在顶部，下方是对应的功能界面。
  * Tab1: '硬盘、目录与文件列表'，用于向 TargetList 添加操作目标。
  * Tab2: '重复文件扫描设置'，用于配置重复文件扫描的相关参数，并启动扫描过程。
  * Tab3: '重复文件列表'，用于显示扫描结果。
  * 更多 tab: 提供不同的附加功能，例如 'Treesize 可视化'，用于展示磁盘空间使用情况和重复文件分布。
* 窗体没有菜单栏，所有功能通过界面上的按钮和选项进行操作。

> 详细定义见 UI.md

## 组件与功能设计

* 基于 vue 的组件化设计，通过多个 sfc 的组合构成界面。
* 布局组件与功能组件应尽量解耦，组件间通过 pinia 统一管理和交换数据，并通过 contextBridge 和后端交互。

### 功能组件详细说明文档链接

- [Explorer.md](./Explorer.md)：用于浏览文件系统，选择要扫描的目录或文件。
- [Scan.md](./Scan.md)：用于配置重复文件扫描的相关参数，例如文件类型过滤器、是否包含隐藏文件等。
- [DupeList.md](./DupeList.md)：用于显示扫描结果中的重复文件列表，支持查看文件详细信息和进行重复文件处理操作。
- [TreeSize.md](./TreeSize.md)：用于展示磁盘空间使用情况和重复文件分布，帮助用户更直观地了解磁盘空间的使用情况。
- [Tabs.md](./Tabs.md)：用于实现不同功能界面的 tab 切换逻辑和界面设计。
- [Settings.md](./Settings.md)：用于配置应用的全局设置。

### 技术设计文档

- [DataModel.md](./DataModel.md)：共享类型定义与数据模型。
- [IPC.md](./IPC.md)：前后端 IPC 通信协议定义。
- [Store.md](./Store.md)：Pinia 状态管理设计。
- [Database.md](./Database.md)：SQLite 数据库表结构设计。

## 非界面功能设计



## 数据结构与算法设计