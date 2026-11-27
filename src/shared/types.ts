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
  /** 排除的目录名（逗号分隔；任意层级同名目录按空目录呈现），默认 node_modules */
  excludeDirNames: string
  /** 排除的目录路径（逗号分隔的绝对路径；该目录整棵子树按空目录呈现） */
  excludeDirPaths: string
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

/** 清理范围规则：只选择该目录路径下的文件（含子目录）；见 docs/Cleanup.md */
export interface ScopeUnderPathRule {
  kind: 'underPath'
  /** 目录绝对路径；勾选集 = 该路径下的全部普通文件（压缩包内条目永不入选） */
  path: string
}

export type ScopeRule = ScopeUnderPathRule

/** 分支统计数据（tree:stats），口径见 docs/Cleanup.md */
export interface BranchStats {
  totalSize: number
  fileCount: number
  dirCount: number
  avgSize: number
  /** 1D k-means 大小分布：center 为组内大小均值（字节），按 center 升序 */
  histogram: Array<{ center: number; count: number }>
}

/** 分支刷新报告（scan:refresh-branch） */
export interface RefreshBranchReport {
  added: number
  removed: number
  updated: number
  treeRev: number
}

/**
 * 目录关系图节点（graph:relations）：一个展示单元，即目标根或某一深度内的目录。
 * Phase 1 展示单元 = 目录；后续可扩展为「块」（见 docs/Relations.md）。
 */
export interface GraphNode {
  /** 路径（目录绝对路径，与体积树同一口径） */
  id: string
  name: string
  /** 父单元路径；目标根为空字符串 */
  parentId: string
  /** 相对目标根的层级（目标根为 0） */
  depth: number
  /** 该目录（含子孙）聚合字节数 */
  bytes: number
  /** 该目录（含子孙）中重复副本占用的字节数（体积树口径） */
  reclaim: number
  /** 是否有子单元（关系图当前不提供下钻，仅给后续扩展保留） */
  hasChildren: boolean
}

/** 目录关系图边：两个展示单元之间共享的重复内容（无向、无时间语义） */
export interface GraphEdge {
  source: string
  target: string
  /** 共享重复内容字节：Σ min(两侧副本数) × 内容类大小 */
  sharedBytes: number
  /** 共享重复内容类包含的文件数：Σ min(两侧副本数) */
  sharedFiles: number
}

/** 目录关系图回包（graph:relations） */
export interface GraphRelationsReply {
  /** 体积树版本号：数据变更时前端据此失效缓存 */
  rev: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 因单组位置数过多（噪声大组）而跳过的内容类组数 */
  truncatedGroups: number
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
  /** 运行平台（process.platform） */
  platform: string
  /** Win11 Mica 材质是否已启用（标题栏/页面底透明染色用） */
  mica: boolean
  selectTargets(kind: 'dir' | 'file' | 'both'): Promise<string[] | null>
  reveal(path: string): Promise<void>
  pathForFile(file: File): string
  /** 主题切换时同步 Win11 标题栏按钮配色 */
  setOverlayTheme(dark: boolean): Promise<void>
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
  /** 分支统计数据（右键菜单「统计数据」）；路径不在树中返回 null */
  treeStats(path: string): Promise<BranchStats | null>
  /** 目录关系图：按展示深度聚合目标根/目录之间的共享重复内容 */
  graphRelations(maxDepth: number, minSharedBytes: number): Promise<GraphRelationsReply>
  /** 打开路径：目录交给系统打开；文件定位到所在文件夹 */
  openPath(path: string, kind: 'dir' | 'file'): Promise<void>
  /** 单独重遍历某子树并与会话比对（不改变目标列表）；按当前扫描参数执行 */
  refreshBranch(settings: ScanSettings, path: string): Promise<RefreshBranchReport>

  onScanProgress(cb: (p: ScanProgress) => void): () => void
  /** 体积树版本广播（移除目标等不伴随 progress 的变更） */
  onTreeRev(cb: (p: { rev: number }) => void): () => void
  onScanGroup(cb: (p: { sessionId: string; groups: DupeGroup[] }) => void): () => void
  onScanDone(cb: (s: ScanSummary) => void): () => void
  onScanError(cb: (p: { sessionId: string; message: string }) => void): () => void
}
