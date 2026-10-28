// 三端（主进程 / preload / 渲染层）共享的类型定义，与 docs/DataModel.md 保持一致。

export type ArchiveType = 'zip' | '7z' | 'rar'

export interface FileEntry {
  /** 唯一 ID：普通文件为绝对路径；压缩包条目为 `容器路径!/包内路径` */
  path: string
  name: string
  /** 字节数；压缩包条目为元信息中的未压缩大小 */
  size: number
  /** 扩展名（含 `.`），无扩展名为空字符串 */
  class: string
  /** 毫秒时间戳，取不到为 0 */
  mtime: number
  /** 压缩包条目的容器绝对路径；普通文件为 null */
  containerPath: string | null
  /** 压缩包内的条目路径（工具返回的原样分隔符）；普通文件为 null */
  entryPath: string | null
  archiveType: ArchiveType | null
  /** 压缩包条目自元信息免费获得的 crc32；普通文件为 null */
  crc32: number | null
  /** 文件前 1MB 的 md5，按需填充 */
  headmd5: string | null
  /** 全量 md5，按需填充 */
  fullmd5: string | null
}

export interface ScanSettings {
  targets: string[]
  /** true 时 L0 分组仅按大小，否则按 文件名+大小 */
  ignoreName: boolean
  excludeHidden: boolean
  excludeSystem: boolean
  excludeJunction: boolean
  /** 跳过 node_modules 目录（整棵子树，依赖目录通常无查重价值且体量巨大） */
  excludeNodeModules: boolean
  /** 字节阈值，含边界；null 表示不限制 */
  minSize: number | null
  maxSize: number | null
  /** 扩展名（不含点），先黑后白 */
  extBlacklist: string[]
  extWhitelist: string[]
  /** 是否把 zip/7z/rar 内的条目纳入比对（压缩包文件本身始终参与） */
  scanArchives: boolean
  archiveTypes: ArchiveType[]
  /** 是否允许使用本机 Everything 加速枚举（不可用时自动回退 fs walk） */
  useEverything: boolean
}

export type ScanPhase = 'listing' | 'hashing' | 'finalizing'

export interface ScanProgress {
  sessionId: string
  phase: ScanPhase
  filesFound: number
  filesProcessed: number
  bytesHashed: number
  currentPath: string
  percent: number
  /** 累计遇到的权限不足（EACCES/EPERM）条数，>0 时 UI 提示可提权重扫 */
  denied: number
  /** 各扫描目标的独立进度（枚举期 total 渐增，哈希期按条目计） */
  targets: Array<{ path: string; percent: number }>
  /** 体积树版本：变更时递增，前端据此失效缓存并按需重取 */
  treeRev: number
}

export interface ScanSummary {
  sessionId: string
  canceled: boolean
  filesFound: number
  dupeGroups: number
  wastedBytes: number
  durationMs: number
  /** 读取失败等非致命错误条数 */
  errors: number
  /** 其中权限不足的条数 */
  denied: number
  /** 体积树版本终值 */
  treeRev: number
}

/** 体积树中挂在目录节点下的真实文件（压缩包内条目不挂，走合成目录） */
export interface TreeNodeFile {
  path: string
  name: string
  size: number
  /** 该文件作为重复副本的浪费字节（每组保留最早修改的一份）；非重复为 0 */
  dupWasted: number
}

export type TreeSortKey = 'name' | 'size' | 'dup'

/** 体积树目录行（按需查询返回；元数据让前端无需二次请求即可画展开箭头与聚合占位） */
export interface TreeDirRowData {
  path: string
  name: string
  /** 该目录（含子孙）聚合的文件字节数 */
  size: number
  /** 该目录（含子孙）中重复副本占用的字节数 */
  dupWasted: number
  /** 直属子目录数 */
  childDirs: number
  /** 直属文件数（不含子目录内的） */
  fileCount: number
  /** 直属文件字节和 */
  fileBytes: number
}

/** 全局统计（去重后的并集口径：嵌套目标的重叠部分只计一次） */
export interface TreeStats {
  totalSize: number
  totalDup: number
  dirCount: number
}

export interface TreeChildrenReply {
  rev: number
  dirs: TreeDirRowData[]
  /** 直属文件聚合（[n 个文件]）；目录无子目录时不返回（前端逐文件展开） */
  agg: { count: number; size: number; dupWasted: number } | null
  stats: TreeStats
}

export interface TreeFileRowData {
  path: string
  name: string
  size: number
  dupWasted: number
}

export interface TreeFilesReply {
  rev: number
  total: number
  rows: TreeFileRowData[]
}

export interface DupeGroup {
  key: string
  size: number
  entries: FileEntry[]
}

export interface CleanAction {
  keepPaths: string[]
  removePaths: string[]
}

export interface CleanReport {
  ok: number
  failed: Array<{ path: string; reason: string }>
  freedBytes: number
}

export interface AppSettings {
  /** 上次的目标列表 */
  targets: string[]
  /** 上次的扫描表单草稿 */
  scanDraft: ScanSettings
  /** 提权重启后自动续扫的一次性标记 */
  resumeScan?: boolean
}

/** 本机能力检测结果（app:capabilities），仅存在性探测 */
export interface AppCapabilities {
  rar: {
    /** 随应用分发的 unrar 路径（RAR 内容读取默认能力）；null 为缺失 */
    bundledExtract: string | null
    /** 本机安装的 RAR 压缩工具（WinRAR/rar）路径；null 为未检测到 */
    compress: string | null
  }
}

/** 渲染层通过 preload 可用的 API，定义见 docs/IPC.md */
export interface DupeSeekApi {
  selectTargets(kind: 'dir' | 'file' | 'both'): Promise<string[] | null>
  reveal(path: string): Promise<void>
  pathForFile(file: File): string
  /** 目标列表同步：新增目标增量扫描，移除目标纯内存清理 */
  scanSync(settings: ScanSettings): Promise<ScanSummary>
  /** 清空会话状态后整体重扫 */
  scanRescan(settings: ScanSettings): Promise<ScanSummary>
  scanStop(sessionId: string): void
  cleanRun(action: CleanAction): Promise<CleanReport>
  /** 请求 UAC 提权并以管理员身份重启（保存现场后自动续扫）；返回是否成功拉起 */
  elevate(): Promise<boolean>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** 本机能力检测（RAR 读取/压缩工具就位情况） */
  capabilities(): Promise<AppCapabilities>
  /** 批量取文件/目录的系统图标（dataURL，主进程带缓存） */
  fileIcons(paths: string[]): Promise<Record<string, string>>
  /** 体积树根级行（每个已同步目标一行） */
  treeRoots(sortKey: TreeSortKey, desc: boolean): Promise<TreeChildrenReply>
  /** 体积树某目录的子级行；目录不存在返回 null */
  treeChildren(dir: string, sortKey: TreeSortKey, desc: boolean): Promise<TreeChildrenReply | null>
  /** 体积树某目录的直属文件（分页） */
  treeFiles(
    dir: string,
    sortKey: TreeSortKey,
    desc: boolean,
    offset: number,
    limit: number
  ): Promise<TreeFilesReply | null>

  onScanProgress(cb: (p: ScanProgress) => void): () => void
  onScanGroup(cb: (p: { sessionId: string; groups: DupeGroup[] }) => void): () => void
  onScanDone(cb: (s: ScanSummary) => void): () => void
  onScanError(cb: (p: { sessionId: string; message: string }) => void): () => void
}
