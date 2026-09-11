# DataModel.md — 共享数据结构与计算逻辑

> v0.1 草案（2026-09-12）。类型统一定义在 `src/shared/` 下（主进程 / preload / 渲染层三端共享），UI 组件库选型与本文件无关。
>
> 标注 ⚠️ 的是待拍板的决策点，请评审时重点看。

## 1. 文件条目 FileEntry

普通文件与压缩包内条目统一用同一结构表示，用 `containerPath` 是否为 null 区分来源：

| 字段 | 类型 | 必须 | 说明 |
| :--- | :--- | :--- | :--- |
| path | string | y | 唯一 ID。普通文件为绝对路径；压缩包条目为 `容器路径!/包内路径` |
| name | string | y | 文件名（含扩展名），压缩包条目取包内路径末段 |
| containerPath | string \| null | y | 压缩包条目为容器绝对路径，普通文件为 null |
| entryPath | string \| null | y | 压缩包内的条目路径（`/` 分隔），普通文件为 null |
| archiveType | 'zip' \| '7z' \| 'rar' \| null | y | 压缩包条目的容器类型 |
| size | number | y | 字节数（压缩包条目取包元信息中的未压缩大小） |
| class | string | y | 扩展名（含 `.`），无扩展名为 `""` |
| mtime | number | y | 毫秒时间戳；压缩包条目取包内元信息，取不到为 0 |
| crc32 | number \| null | n | 比较阶梯中按需填充 |
| headmd5 | string \| null | n | 文件前 1MB 的 md5，按需填充 |
| fullmd5 | string \| null | n | 全量 md5，按需填充 |

`path` 同时充当显示用的完整路径与去重键，不再单设 `fullpath` 字段。哈希字段全部按需（懒）计算，避免无谓 I/O。

## 2. 分组与比较阶梯

所有条目（含压缩包条目）统一进入以下流程：

```
L0 候选分组：按 key 分桶，key = ignoreName ? `${size}` : `${name}·${size}`
L1 crc32 门控（仅压缩包条目参与，见 ⚠️ D1）
L2 headMD5（前 1MB）：不同 → 判定为独立文件，终止
L3 fullMD5：不同 → 独立文件；相同 → 重复
```

规则细节：

1. **⚠️ D1 crc32 门控范围**。原需求为"比较目录下有压缩包时，size 相同的文件先比 crc32"。但普通文件的 crc32 必须全量读盘才能计算，反而比 headMD5（只读 1MB）更慢。**草案采纳的折中**：crc32 门控只作用于能从压缩包元信息免费获得 crc32 的条目，且只用于"同为压缩包条目"之间的初筛；压缩包条目与普通文件之间的比较仍走 headMD5（压缩包条目需解压前 1MB，代价可接受）。若你坚持普通文件也先算 crc32，阶梯改为 L1 对全组成员生效。
2. **压缩包条目参与同一张表**：`x.zip 里的 B.doc` 与 `D:\docs\A.doc` 在 L0 就可能落入同桶，跨类比较统一由 L2/L3 裁决，不区分来源。
3. **空文件特例**：size 为 0 的文件不进入哈希阶梯，同 L0 key 直接判定为重复。
4. **⚠️ D2 分组 key 是否纳入日期/扩展名**。旧 Scan.md 表单里有"相同修改日期 / 相同创建日期 / 相同扩展名"选项。若纳入 key 会把重复组切碎（比如同名同大小但 mtime 差 1 秒的副本将不再判重）。**草案建议**：这些项不参与 L0 key，仅作为 DupeList 的筛选条件与展示信息。若你确有"只清理同日期副本"的场景，再降级为可选开关。
5. **软链接 / junction**：默认跳过 junction 与目录符号链接（防循环）；文件符号链接默认跟随，可在设置中关闭。
6. **Windows 长路径**：超过 260 字符的路径以 `\\?\` 前缀访问。

## 3. 扫描设置 ScanSettings

| 字段 | 类型 | 默认 | 说明 |
| :--- | :--- | :--- | :--- |
| targets | string[] | [] | 绝对路径，可为目录或单个文件，允许 1..n 个 |
| ignoreName | boolean | false | true 时 L0 仅按 size 分组 |
| excludeHidden | boolean | false | 排除隐藏文件/目录 |
| excludeSystem | boolean | false | 排除系统文件 |
| excludeJunction | boolean | true | 跳过 junction / 目录符号链接 |
| minSize | number \| null | null | 字节阈值，含边界 |
| maxSize | number \| null | null | 字节阈值，含边界 |
| extBlacklist | string[] | [] | 如 `['exe','dll']`，先黑后白 |
| extWhitelist | string[] | [] | 非空时仅保留命中项 |
| scanArchives | boolean | true | 是否将 zip/7z/rar 内条目纳入比对 |
| archiveTypes | Array<'zip'\|'7z'\|'rar'> | ['zip','7z','rar'] | 首期固定三种 |
| useEverything | boolean | true | 检测到 Everything 时允许用其接口加速枚举（仅影响枚举速度，不改变比对逻辑） |

## 4. 扫描会话与进度

```ts
interface ScanProgress {
  sessionId: string
  phase: 'listing' | 'hashing' | 'archive' | 'finalizing'
  filesFound: number        // 已发现的候选条目数
  filesProcessed: number    // 已完成比对（含免哈希）的条目数
  bytesHashed: number       // 已读取并哈希的字节数
  currentPath: string       // 正在处理的路径
  percent: number           // 0-100 估算值（哈希阶段按字节权重，枚举阶段按条目数）
}

interface ScanSummary {
  sessionId: string
  canceled: boolean
  filesFound: number
  dupeGroups: number
  wastedBytes: number
  durationMs: number
}
```

## 5. 重复组 DupeGroup

```ts
interface DupeGroup {
  key: string          // 最终判定依据：fullmd5 或空文件 size 键
  size: number         // 组内条目统一大小
  entries: FileEntry[] // 全部成员，length ≥ 2
}
// wastedBytes = (entries.length - 1) * size，由 getter 派生，不入库
```

组通过 IPC 增量推送到渲染层（见 IPC.md `scan:group`），DupeList 无需等待扫描结束即可开始浏览。

## 6. 清理动作

```ts
type CleanActionType = 'delete' | 'hardlink' | 'mergeMove'

interface CleanAction {
  type: CleanActionType
  // 每个 DupeGroup 中保留条目的 path；其余成员为处理对象
  keepPaths: string[]
  removePaths: string[]
  options?: {
    mergeTargetDir?: string  // mergeMove 的目标目录
  }
}

interface CleanReport {
  ok: number
  failed: Array<{ path: string; reason: string }>
  freedBytes: number
  logPath: string | null   // mergeMove 生成的恢复 log 路径
}
```

- delete：删除所选副本（可配置进回收站或直接删除，⚠️ D3 默认建议回收站）。
- hardlink：删除副本并对保留件创建硬链接（仅同卷可用，跨卷条目报告失败）。
- mergeMove：把各组副本移动到目标目录、目标只保留一份，生成 `恢复 log`（JSON：原路径 → 归档路径）。

## 7. Explorer 与环境类型

```ts
interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number      // 目录恒为 0（不显示）
  mtime: number
  class: string     // 扩展名（含点），目录为 ""
}

interface FavoriteItem {
  label: string
  path: string
  builtin: boolean  // 预置（桌面/文档/下载/盘符…）不可删除；用户收藏为 false
}

interface EverythingStatus {
  installed: boolean
  version: string | null
  usable: boolean       // installed 且接口可用（HTTP 服务开启或 es.exe 可用）
  channel: 'http' | 'es' | 'sdk' | null
}
```

## 8. 决策点汇总

| 编号 | 问题 | 草案倾向 |
| :--- | :--- | :--- |
| D1 | crc32 门控是否覆盖普通文件 | 否，仅压缩包条目（理由见 §2.1） |
| D2 | mtime/ctime/扩展名是否参与分组 key | 否，降级为筛选条件（理由见 §2.4） |
| D3 | delete 默认进回收站还是直接删除 | 回收站（Electron `shell.trashItem`） |
| D4 | 目标列表（TargetList）是否持久化 | 是，随全局设置一起存 |
| D5 | 压缩包条目 ID 的 `容器!/条目` 约定 | 采纳，注意 Windows 路径中 `!` 合法 |
