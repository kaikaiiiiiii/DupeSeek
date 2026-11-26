# DataModel.md — 共享数据结构与计算逻辑

> v0.4（2026-11-26）。类型统一定义在 `src/shared/types.ts`（主进程 / preload / 渲染层三端共享），本文件与代码同步维护。标注「已知」的条目是当前实现的真实行为（含已知缺口），不要按旧草案实现。

## 1. 文件条目 FileEntry

普通文件与压缩包内条目统一使用同一结构，用 `containerPath` 是否为 null 区分来源：

| 字段          | 类型                           | 必须 | 说明                                                                    |
| :------------ | :----------------------------- | :--- | :---------------------------------------------------------------------- |
| path          | string                         | y    | 唯一 ID/去重键。普通文件为绝对路径；压缩包条目为 `容器路径::包内路径`    |
| name          | string                         | y    | 文件名（含扩展名），压缩包条目取包内路径末段                            |
| containerPath | string \| null                 | y    | 压缩包条目的容器绝对路径，普通文件为 null                               |
| entryPath     | string \| null                 | y    | 压缩包内的条目路径（工具返回的原样分隔符），普通文件为 null              |
| archiveType   | 'zip' \| '7z' \| 'rar' \| null | y    | 压缩包条目的容器类型                                                    |
| size          | number                         | y    | 字节数（压缩包条目取包元信息中的未压缩大小）                            |
| class         | string                         | y    | 扩展名（含 `.`），无扩展名为 `""`                                       |
| mtime         | number                         | y    | 毫秒时间戳（`lstat.mtimeMs` 向下取整）；压缩包条目取包内元信息，取不到 0 |
| crc32         | number \| null                 | n    | 压缩包条目自元信息免费获得；普通文件为 null                             |
| headmd5       | string \| null                 | n    | 文件前 1MB 的 md5，按需填充                                             |
| fullmd5       | string \| null                 | n    | 全量 md5，按需填充                                                      |

`path` 同时充当完整路径、显示名来源与去重键。哈希字段全部按需（懒）计算，避免无谓 I/O。

**路径口径（已知）**：Windows 上引擎内部键按小写归一（大小写不敏感），展示与写回使用原始大小写；目标路径经 `canonicalTarget()` 规范化（去尾分隔符、裸盘符 `D:` → `D:\`）。超过 260 字符的路径**没有** `\\?\` 前缀特殊处理，依赖 Node/Electron 的长路径能力。

## 2. 扫描设置 ScanSettings

| 字段            | 类型                      | 默认                | 说明                                                                 |
| :-------------- | :------------------------ | :------------------ | :------------------------------------------------------------------- |
| targets         | string[]                  | []                  | 绝对路径，可为目录或单个文件；允许为空（空 = 清空会话内全部目标）    |
| ignoreName      | boolean                   | false               | true 时 L0 仅按大小分组，否则按 文件名+大小                          |
| excludeHidden   | boolean                   | false               | 排除隐藏文件/**点前缀名**（`name.startsWith('.')`；不读 Windows 隐藏属性） |
| excludeSystem   | boolean                   | false               | 排除已知系统目录名：`$RECYCLE.BIN` / `System Volume Information` / `WindowsApps`（只作用于目录） |
| excludeJunction | boolean                   | true                | 跳过 junction / 符号链接等 reparse 子树（Everything 通道经 `/aL` 清单整树剔除，walk 通道 lstat 跳过） |
| excludeDirNames | string                    | `'node_modules'`    | 逗号分隔目录名；任意层级同名目录登记为空节点（可见、0 字节、不展开） |
| excludeDirPaths | string                    | `''`                | 逗号分隔绝对路径；该目录整棵子树登记为空节点                         |
| minSize         | number \| null            | null                | 字节阈值，含边界                                                     |
| maxSize         | number \| null            | null                | 字节阈值，含边界                                                     |
| extBlacklist    | string[]                  | []                  | 扩展名（不含点、小写），先黑后白                                    |
| extWhitelist    | string[]                  | []                  | 非空时仅保留命中项                                                   |
| scanArchives    | boolean                   | true                | 是否解析 zip/7z/rar 内的条目；压缩包文件本身始终参与比对             |
| archiveTypes    | ArchiveType[]             | ['zip','7z','rar']  | 预留字段：引擎当前固定三种，未读取该字段                            |
| useEverything   | boolean                   | true                | 是否允许用本机 Everything（es.exe）加速枚举；不可用逐目标回退 fs walk |

**目录排除的呈现语义**：被排除目录登记为「空节点」——在树中可见、0 字节、无文件、不可展开；目标本身被排除时整个目标为空。只有最顶层的排除目录登记为节点（嵌套同名/路径包含不重复登记）。

## 3. 会话与进度

```ts
type ScanPhase = 'listing' | 'hashing' | 'finalizing'

interface ScanProgress {
  sessionId: string
  phase: ScanPhase
  filesFound: number      // 已发现的候选条目数
  filesProcessed: number  // 已进入比对的条目数
  bytesHashed: number     // 已读取并哈希的字节数
  currentPath: string
  percent: number         // 0-100；= filesProcessed / filesFound（条目数口径）
  denied: number          // 累计权限不足（EACCES/EPERM）条数，>0 时 UI 提示提权
  targets: Array<{ path: string; percent: number }> // 各目标独立进度
  treeRev: number         // 体积树版本：变化即前端失效缓存、按需重取
}

interface ScanSummary {
  sessionId: string
  canceled: boolean
  filesFound: number      // 会话内条目总数
  dupeGroups: number
  wastedBytes: number
  durationMs: number
  errors: number          // 读取/解压失败等非致命错误条数
  denied: number          // 其中权限不足条数
  treeRev: number         // 体积树版本终值
}
```

体积树**不再**随 `ScanSummary` 下发（旧草案的 `tree: ScanTreeNode[]` 已废弃）：树数据在后端权威持有，渲染层按需拉取（见 §7）。

## 4. 分组与比较阶梯

所有条目（含压缩包条目）统一进入以下流程：

```
L0 候选分组：key = ignoreName ? `s:<size>` : `n:<name>#s:<size>`
L1 crc32 门控：仅当桶内全部为压缩包条目时启用，crc 互异的条目直接淘汰
L2 headMD5（前 1MB）：不同 → 独立文件；≤1MB 的文件 headMD5 复用为 fullMD5，免二次读盘
L3 fullMD5：不同 → 独立；相同 → 重复组（key = `md5:<digest>`）
```

规则细节：

1. **空文件**：size 为 0 的文件不进入哈希阶梯，按 `empty:<name>#<size>` 直接成组。
2. **压缩包条目**：与普通文件同表比较；压缩包条目对比时按需解压前 1MB / 全量流式哈希。纯压缩包桶先用元信息 crc32 初筛。包内条目不可清理，只参与查重与展示。
3. **junction / 符号链接**：默认整树排除（防「自己配自己」的假重复组与删除后路径失效）。Everything 通道用 `/aL` 一次取得 reparse 清单后内存前缀剔除；walk 通道在 `excludeJunction` 时 lstat 跳过目录符号链接。**已知**：walk 通道会静默跳过文件符号链接（dirent 既非 file 也非 dir），见 docs/KnownIssues.md KI-4。
4. **硬链接**：按独立文件处理（设计约定）——每个路径各计一份体积、各算哈希，正常参与分桶与清理；「浪费空间」统计因此对硬链接组偏高（删除一个路径不释放数据）。
5. **大小写**：L0 键与去重键使用精确文件名；Windows 去重键小写归一。跨目录同名但大小写不同属于不同文件，由哈希阶梯裁决（KI-5）。
6. **软链接/云占位文件**（Everything 通道）：`excludeJunction` 开启时一并跳过 reparse 文件（避免穿越链接或触发云端下载）。

## 5. 重复组 DupeGroup

```ts
interface DupeGroup {
  key: string        // `md5:<digest>` 或空文件 `empty:<name>#<size>`
  size: number       // 组内条目统一大小
  entries: FileEntry[] // 全部成员，length ≥ 2
}
// wastedBytes = size * (entries.length - 1)，由派生计算，不入库
```

组经 `scan:group` 增量推送（按 key 幂等：同 key 整组替换），DupeList 无需等待扫描结束即可浏览。

## 6. 清理动作

```ts
interface CleanAction {
  keepPaths: string[]   // 各组未被勾选的普通条目；当前主进程 clean.ts 未读取（为硬链接/合并移动预留）
  removePaths: string[] // 待删除副本（压缩包内条目不进入此清单）
}

interface CleanReport {
  ok: number
  failed: Array<{ path: string; reason: string }>
  freedBytes: number    // 按删除前 stat.size 累加（仅成功项）
}
```

- 当前实现**只有** delete：`shell.trashItem` 进回收站；压缩包内条目永不进入 `removePaths`。
- hardlink（同卷建硬链接）与 mergeMove（合并移动 + 恢复 log）为后续迭代，届时扩展 `CleanAction`。
- 清理确认弹窗与筛选在渲染层；主进程只执行 `removePaths`，不复核「范围外存活」不变量（该不变量由 `useDupeStore.planClean` 保证，见 docs/Cleanup.md §不变量）。

## 7. 体积树数据（拉取协议）

```ts
type TreeSortKey = 'name' | 'size' | 'dup'

interface TreeNodeFile { path: string; name: string; size: number; dupWasted: number }

interface TreeDirRowData {
  path: string
  name: string
  size: number       // 该目录（含子孙）聚合文件字节数
  dupWasted: number  // 该目录（含子孙）重复副本占用字节数
  childDirs: number  // 直属子目录数
  fileCount: number  // 直属文件数（不含子目录内）
  fileBytes: number  // 直属文件字节和
}

interface TreeStats { totalSize: number; totalDup: number; dirCount: number }

interface TreeChildrenReply {
  rev: number
  dirs: TreeDirRowData[]
  agg: { count: number; size: number; dupWasted: number } | null // 仅当目录同时有子目录与直属文件时返回
  stats: TreeStats
}

interface TreeFilesReply { rev: number; total: number; rows: TreeFileRowData[] }
```

- 根级行 = 每个已同步目标一行；某目录不存在时 `treeChildren` / `treeFiles` 返回 `null`（渲染层据此丢弃过期响应/回退重试）。
- 压缩包内容在体积树中呈现为 `容器路径::` 合成目录链，包内条目体积只累加到合成根，不进入真实目录（避免与压缩后包体积重复计账）；包内条目不可独立清理。
- `TreeStats.totalSize` 是渲染层条目并集口径（嵌套目标重叠部分只计一次）；注意条目集包含压缩包内条目，而容器文件本身也是一条，故该值**不等于磁盘占用**（压缩包较多时偏高）。`dirCount` 为后端 `dirs` 节点数（含合成目录与排除空节点）。

## 8. 范围规则、分支操作与统计数据（2026-11 新增）

```ts
interface ScopeUnderPathRule { kind: 'underPath'; path: string } // 勾选集 = 该路径下全部普通文件（含子目录）
type ScopeRule = ScopeUnderPathRule

interface BranchStats {
  totalSize: number   // 树节点聚合值（真实目录不含包内解压体积，见 docs/Cleanup.md）
  fileCount: number   // 递归真实文件 + 包内条目
  dirCount: number    // 子树内真实目录（不含所选目录自身与 `容器::` 合成节点）
  avgSize: number     // totalSize / fileCount
  histogram: Array<{ center: number; count: number }> // 1D k-means ≤10 组，按中心升序
}

interface RefreshBranchReport {
  added: number; removed: number; updated: number; treeRev: number
}
```

规则定义、应用与已知缺口见 docs/Cleanup.md；当前 `RefreshBranchReport` 的计数只在 IPC 层返回，渲染层尚未展示。

## 9. 应用设置与能力

```ts
interface AppSettings {
  targets: string[]        // 上次的目标列表
  scanDraft: ScanSettings  // 上次的扫描表单草稿
  resumeScan?: boolean     // 提权重启后自动续扫的一次性标记
}

interface AppCapabilities {
  rar: {
    bundledExtract: string | null // 随应用分发的 unrar 路径；null 为缺失
    compress: string | null       // 本机 WinRAR/rar 路径；仅检测展示
  }
}
```

**持久化（已知）**：以上设置保存在用户数据目录的 `settings.json`（JSON 文件），**没有** SQLite。启动时读取并迁移旧版 `scanDraft.excludeNodeModules` 开关；主题模式另存于渲染层 `localStorage['dupeseek-theme']`（不进入 settings.json）。

## 10. 虚拟路径分隔符

压缩包内条目的 `path` 为 `容器路径 + '::' + 条目路径`，只做前缀拼接，从不切分解析（Linux 合法文件名可含 `::`）。若未来需要还原两段，必须用 `lastIndexOf` 或记录边界，不能用 `split('::')`。

## 11. 决策点汇总（当前状态）

| 编号 | 问题                               | 结论                                                                 |
| :--- | :--------------------------------- | :------------------------------------------------------------------- |
| D1   | crc32 门控是否覆盖普通文件         | 否，仅纯压缩包条目桶（普通文件 crc32 需全量读盘，比 headMD5 慢）     |
| D2   | mtime/ctime/扩展名是否参与分组 key | 否；仅 `ignoreName` 一个开关影响 L0（默认名称+大小），日期只作展示   |
| D3   | delete 默认进回收站还是直接删除    | 已实现：`shell.trashItem` 进回收站                                   |
| D4   | 目标列表是否持久化                 | 已实现：随 `settings.json` 的 `targets` 保存                         |
| D5   | 压缩包条目 ID 的虚拟分隔符         | 已实现：`::`（`!` 在 Windows 文件名中合法有歧义）                    |
| D6   | SQLite 数据库                      | 未实现；当前全部持久化为 JSON（`settings.json`），扫描结果不落库     |
