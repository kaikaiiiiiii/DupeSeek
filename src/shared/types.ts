// 三端（主进程 / preload / 渲染层）共享的类型定义，与 docs/DataModel.md 保持一致。
// 首个基础版：仅普通文件比对；压缩包、Everything、TreeSize 为后续迭代。

export interface FileEntry {
  /** 唯一 ID，即绝对路径 */
  path: string
  name: string
  /** 字节数 */
  size: number
  /** 扩展名（含 `.`），无扩展名为空字符串 */
  class: string
  /** 毫秒时间戳，取不到为 0 */
  mtime: number
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
  /** 字节阈值，含边界；null 表示不限制 */
  minSize: number | null
  maxSize: number | null
  /** 扩展名（不含点），先黑后白 */
  extBlacklist: string[]
  extWhitelist: string[]
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

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
  class: string
}

export interface FavoriteItem {
  label: string
  path: string
  builtin: boolean
}

export interface AppSettings {
  /** 上次的目标列表 */
  targets: string[]
  /** 用户收藏目录（预置项由主进程给出，不在此持久化） */
  favorites: FavoriteItem[]
  /** 上次的扫描表单草稿 */
  scanDraft: ScanSettings
}

/** 渲染层通过 preload 可用的 API，定义见 docs/IPC.md */
export interface DupeSeekApi {
  selectTargets(kind: 'dir' | 'file' | 'both'): Promise<string[] | null>
  listDir(path: string): Promise<DirEntry[]>
  places(): Promise<{ favorites: FavoriteItem[]; drives: FavoriteItem[] }>
  reveal(path: string): Promise<void>
  pathForFile(file: File): string
  scanStart(settings: ScanSettings): Promise<string>
  scanStop(sessionId: string): void
  cleanRun(action: CleanAction): Promise<CleanReport>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  onScanProgress(cb: (p: ScanProgress) => void): () => void
  onScanGroup(cb: (p: { sessionId: string; groups: DupeGroup[] }) => void): () => void
  onScanDone(cb: (s: ScanSummary) => void): () => void
  onScanError(cb: (p: { sessionId: string; message: string }) => void): () => void
}
