import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  ArchiveType,
  BranchStats,
  DupeGroup,
  FileEntry,
  GraphNode,
  GraphRelationsReply,
  RefreshBranchReport,
  ScanProgress,
  ScanSettings,
  ScanSummary,
  TreeChildrenReply,
  TreeDirRowData,
  TreeFilesReply,
  TreeNodeFile,
  TreeSortKey,
  TreeStats
} from '../../shared/types'
import { isPermissionError } from '../../shared/errors'
import { createEverythingLister, type EverythingLister } from './everything'
import { getHashPool, HASH_WORKERS } from './hashPool'
import type { ArchiveEntryMeta } from './archives'
import {
  buildDirExclusions,
  extAllowed,
  extOf,
  isPathExcludedDir,
  SYSTEM_DIRS,
  walkTargets,
  type DirExclusions
} from './walk'

const HEAD_BYTES = 1024 * 1024
const GROUP_FLUSH_COUNT = 50
const GROUP_FLUSH_MS = 500
const PROGRESS_MS = 100
const ARCHIVE_LIST_CONCURRENCY = 4

type Broadcaster = (channel: string, payload: unknown) => void

function archiveTypeOf(cls: string): ArchiveType | null {
  switch (cls.toLowerCase()) {
    case '.zip':
      return 'zip'
    case '.7z':
      return '7z'
    case '.rar':
      return 'rar'
    default:
      return null
  }
}

/** 由压缩包元信息构建条目；命中过滤规则的返回 null */
function buildArchiveEntry(
  container: FileEntry,
  type: ArchiveType,
  meta: ArchiveEntryMeta,
  settings: ScanSettings
): FileEntry | null {
  const name = meta.entryPath.split(/[\\/]/).pop() ?? ''
  if (name === '') return null
  if (settings.excludeHidden && name.startsWith('.')) return null
  const cls = extOf(name)
  if (!extAllowed(cls, settings)) return null
  if (settings.minSize !== null && meta.size < settings.minSize) return null
  if (settings.maxSize !== null && meta.size > settings.maxSize) return null
  return {
    path: `${container.path}::${meta.entryPath}`,
    name,
    size: meta.size,
    class: cls,
    mtime: meta.mtimeMs,
    containerPath: container.path,
    entryPath: meta.entryPath,
    archiveType: type,
    crc32: meta.crc32,
    headmd5: null,
    fullmd5: null
  }
}

/** 目录聚合记录：体积/重复沿祖先链累加 */
interface DirAgg {
  parent: string
  name: string
  size: number
  dup: number
}

/** 有限并发的映射 */
async function pMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

type HashSlot = 'headmd5' | 'fullmd5'

/** 目标路径规范化：去尾部分隔符；裸盘符（D:）补全为根形式；剥空（本身就是盘根）保持原样 */
export function canonicalTarget(t: string): string {
  const stripped = t.replace(/[\\/]+$/, '')
  if (stripped === '') return t
  return /^[a-zA-Z]:$/.test(stripped) ? stripped + '\\' : stripped
}

/** 升序数组中第一个大于 x 的下标（二分；from 为搜索起点） */
function bisectRight(arr: number[], x: number, from: number): number {
  let lo = Math.max(0, from)
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 1D k-means（分位数种子 + Lloyd 迭代）：返回各组 { 中心, 成员数 }，按中心升序。
 * 空簇以全局分位重播种；k 收敛为 min(k, 不同值档数)；中心重合的组就地合并。
 * 有序数据 + 前缀和，一轮分配 O(k·log n)，几十万文件也在毫秒级。
 */
function kmeansBuckets(values: number[], k: number): Array<{ center: number; count: number }> {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const kk = Math.max(1, Math.min(k, new Set(sorted).size))
  const quantile = (c: number): number => sorted[Math.floor(((c + 0.5) / kk) * (sorted.length - 1))]
  const centers: number[] = []
  for (let c = 0; c < kk; c++) centers.push(quantile(c))
  const prefix = new Array<number>(sorted.length + 1)
  prefix[0] = 0
  for (let i = 0; i < sorted.length; i++) prefix[i + 1] = prefix[i] + sorted[i]

  for (let iter = 0; iter < 24; iter++) {
    const cnt = new Array<number>(kk).fill(0)
    const sum = new Array<number>(kk).fill(0)
    let start = 0
    for (let c = 0; c < kk; c++) {
      const end =
        c === kk - 1
          ? sorted.length
          : Math.max(start, bisectRight(sorted, (centers[c] + centers[c + 1]) / 2, start))
      cnt[c] = end - start
      sum[c] = prefix[end] - prefix[start]
      start = end
    }
    let moved = false
    for (let c = 0; c < kk; c++) {
      if (cnt[c] === 0) {
        centers[c] = quantile(c)
        moved = true
        continue
      }
      const mean = sum[c] / cnt[c]
      if (mean !== centers[c]) {
        centers[c] = mean
        moved = true
      }
    }
    if (!moved) break
  }

  const bounds: number[] = []
  for (let c = 0; c < kk - 1; c++) bounds.push((centers[c] + centers[c + 1]) / 2)
  const counts = new Map<number, number>()
  let start = 0
  for (let c = 0; c < kk; c++) {
    const end =
      c === kk - 1 ? sorted.length : Math.max(start, bisectRight(sorted, bounds[c], start))
    const n = end - start
    if (n > 0) counts.set(centers[c], (counts.get(centers[c]) ?? 0) + n)
    start = end
  }
  return [...counts.entries()]
    .map(([center, count]) => ({ center: Math.round(center), count }))
    .sort((a, b) => a.center - b.center)
}

/**
 * 有状态的增量扫描引擎。
 *
 * 持久会话状态（跨操作存活）：
 * - entries：全局条目存储，路径键唯一——嵌套目标（如 D:\ 与 D:\Coding 同时
 *   作为目标）覆盖同一文件时只存一份，杜绝"自己配自己"的假重复与 md5 风暴；
 *   哈希记忆化挂在条目对象上，已算过的 headMD5/fullMD5 不再重算、不重复读盘；
 * - owners：条目 → 归属目标（嵌套覆盖时归属先注册者；移除目标时向剩余
 *   覆盖者重归属，无人覆盖才删除）；
 * - coveredTargets：本轮会话已纳入同步的目标集合；
 * - knownGroups：已确认的重复组（key → 组，组内为全量成员）。
 *
 * 操作模型：
 * - syncTargets：目标列表同步。新增目标仅枚举+与现有条目比桶
 *   （只有 L0 同桶的新条目触发哈希）；移除目标纯内存清理，零磁盘 I/O；
 * - rescanAll：清空会话状态后整体重扫。
 *
 * 渲染层语义：scan:group 按 key 幂等（同 key 重复到达时整组替换）；
 * scan:done 携带全量汇总与重建的体积树。
 */
export class ScanEngine {
  private broadcaster: Broadcaster
  private sessionId = ''
  private canceled = false
  private running = false
  private errors = 0
  private phase: ScanProgress['phase'] = 'listing'
  private found = 0
  private processed = 0
  private bytesHashed = 0
  private lastProgressAt = 0
  private dirs = new Map<string, DirAgg>()
  private denied = 0
  private archiveTempRoots: string[] = []
  private foundPerTarget = new Map<string, number>()
  private processedPerTarget = new Map<string, number>()
  private progressTargets: string[] = []

  // —— 体积树（后端权威，前端按需查询）——
  /** 树版本：任何目录/文件数据变更时递增，前端据此失效缓存重取 */
  private treeRev = 0
  /** 目录 → 直属真实文件（压缩包内条目不挂，走合成目录链聚合） */
  private dirFiles = new Map<string, TreeNodeFile[]>()
  /** 父目录 → 子目录路径（惰性查询的子级索引） */
  private childDirs = new Map<string, string[]>()
  /** 文件级重复占用缓存（随 knownGroups 变化按版本失效） */
  private wastedCache: { rev: number; map: Map<string, number> } | null = null
  private statsCache: { rev: number; stats: TreeStats } | null = null
  /** 当前会话的目录排除集（由设置构建，syncTargets 时刷新） */
  private excl: DirExclusions = { names: new Set(), pathStops: [] }
  /** 排除目录的空节点（原始路径 → 发现它的目标），rebuildDirs 时重登记 */
  private excludedDirs = new Map<string, string>()

  // —— 持久会话状态 ——
  private entries = new Map<string, FileEntry>()
  private owners = new Map<string, string>()
  private coveredTargets = new Set<string>()
  /** coveredTargets 的 keyOf 归一集合：Windows 上大小写变体视为同一目标 */
  private coveredKeys = new Set<string>()
  private knownGroups = new Map<string, DupeGroup>()

  constructor(broadcaster: Broadcaster) {
    this.broadcaster = broadcaster
    this.cleanupStaleArchiveTemps()
  }

  isRunning(): boolean {
    return this.running
  }

  stop(): void {
    if (this.running) this.canceled = true
  }

  /** 清理上次应用运行遗留的解压临时目录 */
  private cleanupStaleArchiveTemps(): void {
    const tmp = os.tmpdir()
    try {
      for (const name of fs.readdirSync(tmp)) {
        if (name.startsWith('dupeseek-rar-')) {
          fs.rmSync(path.join(tmp, name), { recursive: true, force: true })
        }
      }
    } catch {
      // 清理失败不阻断
    }
  }

  /** 目标列表同步：新增目标增量扫描，移除目标纯内存清理；空目标列表 = 清空全部 */
  async syncTargets(settings: ScanSettings): Promise<ScanSummary> {
    if (this.running) throw new Error('已有扫描任务在进行中')
    // 目标规范化在后端统一做：尾斜杠/裸盘符变体不产生第二份会话
    const canon: ScanSettings = { ...settings, targets: settings.targets.map(canonicalTarget) }
    this.excl = buildDirExclusions(canon)

    const requested = new Set(canon.targets.map((t) => this.keyOf(t)))
    const addList = canon.targets.filter((t) => !this.coveredKeys.has(this.keyOf(t)))
    const removeList = [...this.coveredTargets].filter((t) => !requested.has(this.keyOf(t)))

    this.running = true
    this.canceled = false
    this.errors = 0
    this.found = 0
    this.processed = 0
    this.bytesHashed = 0
    this.denied = 0
    getHashPool().resetDenied()
    this.sessionId = randomUUID()
    this.progressTargets = addList
    for (const t of addList) {
      this.coveredTargets.add(t)
      this.coveredKeys.add(this.keyOf(t))
    }
    const sessionId = this.sessionId
    const startedAt = Date.now()

    try {
      // 移除是指令：立即应答（根集合摘除 + 版本广播），重活入队后台分批回收
      for (const t of removeList) this.scheduleRemoval(t)
      // 清理与后续扫描串行化（清理分批让出，等待短暂）
      while (this.cleaningUp) await new Promise<void>((resolve) => setImmediate(resolve))

      // 新增：枚举 → 触碰桶比较（只有 L0 同桶的新条目触发哈希）
      if (addList.length > 0) {
        // 先登记新目标根目录：es.exe 全量导出完成前（可能数十秒）新根行
        // 即以空树形态出现并随枚举实时生长，而不是一直停在加载态
        for (const t of addList) {
          this.recordDir(t)
          this.treeRev++
        }
        const lister = canon.useEverything ? await createEverythingLister() : null
        console.info(
          `[scan] 枚举通道（${addList.length} 个新增目标）：${lister ? 'Everything (es.exe)' : settings.useEverything ? 'fs walk（Everything 不可用）' : 'fs walk（已在设置中禁用 Everything）'}`
        )
        await this.enumerateAdds(addList, canon, lister)

        if (!this.canceled) {
          this.phase = 'hashing'
          this.processed = 0
          await this.hashTouched(canon, addList)
        }
      }

      // 汇总：体积树按当前全量条目重算，组数为会话累计值
      this.phase = 'finalizing'
      // 纯移除的同步不走全量重建——移除清理已增量反扣并精确剪枝
      if (addList.length > 0) this.rebuildDirs()
      let wastedBytes = 0
      for (const g of this.knownGroups.values()) {
        wastedBytes += g.size * (g.entries.length - 1)
      }
      const totalEntries = this.entries.size
      const summary: ScanSummary = {
        sessionId,
        canceled: this.canceled,
        filesFound: totalEntries,
        dupeGroups: this.knownGroups.size,
        wastedBytes,
        durationMs: Date.now() - startedAt,
        errors: this.errors,
        denied: this.denied + getHashPool().deniedCount,
        treeRev: this.treeRev
      }
      this.broadcaster('scan:done', summary)
      // 渲染层 invoke 路径直接消费 summary（事件路径可能被状态守卫拦截）
      return summary
    } finally {
      this.running = false
      this.canceled = false
    }
  }

  /** 整体重扫：清空会话状态后按当前目标全量扫描 */
  async rescanAll(settings: ScanSettings): Promise<ScanSummary> {
    if (this.running) throw new Error('已有扫描任务在进行中')
    // 等待在途移除清理收尾（分批让出，短暂），避免与新全量数据互踩
    while (this.cleaningUp) await new Promise<void>((r) => setImmediate(r))
    this.removalTasks = []
    this.entries.clear()
    this.owners.clear()
    this.coveredTargets.clear()
    this.coveredKeys.clear()
    this.excludedDirs.clear()
    this.knownGroups.clear()
    this.foundPerTarget.clear()
    this.processedPerTarget.clear()
    return this.syncTargets(settings)
  }

  /**
   * 分支刷新（空间分析右键「更新该分支」）：用户可能在应用外手工增删了文件，
   * 需要对单个子树重扫——不改变目标列表，只把该前缀的会话条目对齐磁盘现状。
   * 按传入的当前扫描参数执行（可能与整盘当时的口径不同，docs/Cleanup.md）。
   */
  async refreshBranch(settings: ScanSettings, branchRaw: string): Promise<RefreshBranchReport> {
    if (this.running) throw new Error('已有扫描任务在进行中')
    const branch = canonicalTarget(branchRaw)
    const stop = this.stopOf(branch)
    // 分支必须落在某个已同步目标之内；取最深覆盖者作为新增条目的归属
    let owner: string | null = null
    for (const t of this.coveredTargets) {
      const lt = this.stopOf(t)
      if (
        (stop === lt || stop.startsWith(lt + '\\')) &&
        (owner === null || lt.length > this.stopOf(owner).length)
      ) {
        owner = t
      }
    }
    if (owner === null) throw new Error('该路径不在任何已扫描目标范围内')
    for (const dir of this.excludedDirs.keys()) {
      const ld = this.stopOf(dir)
      if (stop === ld || stop.startsWith(ld + '\\')) {
        throw new Error('该位置位于排除目录内（呈现为空节点，无可刷新内容）')
      }
    }
    // 在途移除清理分批让出，先等它收尾避免互踩
    while (this.cleaningUp) await new Promise<void>((resolve) => setImmediate(resolve))

    this.running = true
    this.canceled = false
    this.excl = buildDirExclusions(settings)
    this.phase = 'listing'
    this.progressTargets = [branch]
    this.foundPerTarget.set(branch, 0)
    this.processedPerTarget.set(branch, 0)
    const lastPath = { value: '' }
    try {
      // —— 枚举现状（es -path 天然支持子树；不可用回退 fs walk）——
      const added: FileEntry[] = []
      const seen: FileEntry[] = []
      const register = (e: FileEntry): boolean => {
        if (!this.registerEntry(e, owner as string)) return false
        added.push(e)
        this.found++
        return true
      }
      const registerSeen = (e: FileEntry): boolean => {
        seen.push(e)
        return register(e)
      }
      const ctx = {
        settings,
        excl: this.excl,
        onExcludedDir: (p: string): void => {
          this.registerExcludedDir(p, owner as string)
        },
        canceled: (): boolean => this.canceled,
        onEntry: (e: FileEntry): void => {
          if (!registerSeen(e)) return
          this.emitProgress(e.path)
          lastPath.value = e.path
        },
        onDir: (p: string): void => {
          lastPath.value = p
        },
        onError: (_p: string, err: unknown): void => {
          this.errors++
          if (isPermissionError(err)) this.denied++
        }
      }

      const lister = settings.useEverything ? await createEverythingLister() : null
      let handled = false
      if (lister) {
        try {
          handled = await this.listViaEverything(lister, branch, settings, registerSeen, lastPath)
        } catch (err) {
          console.warn(`[scan] 分支刷新枚举失败，回退 walk：${branch}`, err)
        }
      }
      if (!handled) await walkTargets([branch], ctx)
      if (settings.scanArchives) {
        await this.listArchiveEntries(settings, added, register, lastPath)
      }

      // —— diff：消失 / 变化 / 新增 ——
      const fresh = new Map<string, FileEntry>()
      for (const e of seen) fresh.set(this.keyOf(e.path), e)
      // 先求消失集（普通文件），包内条目跟随容器整链剔除
      const vanished = new Set<string>()
      for (const [key, e] of this.entries) {
        if (e.containerPath !== null) continue
        const lp = this.keyOf(e.path)
        if ((lp === stop || lp.startsWith(stop + '\\')) && !fresh.has(lp)) vanished.add(key)
      }
      const deletedKeys = new Set<string>()
      const touched: FileEntry[] = [...added]
      const changedContainers: FileEntry[] = []
      let removedCount = 0
      let updatedCount = 0
      for (const [key, e] of [...this.entries]) {
        if (e.containerPath !== null) {
          const ck = this.keyOf(e.containerPath)
          if ((ck === stop || ck.startsWith(stop + '\\')) && vanished.has(ck)) {
            this.entries.delete(key)
            this.owners.delete(key)
            deletedKeys.add(key)
          }
          continue
        }
        const lp = this.keyOf(e.path)
        if (lp !== stop && !lp.startsWith(stop + '\\')) continue
        const now = fresh.get(lp)
        if (now === undefined) {
          this.entries.delete(key)
          this.owners.delete(key)
          deletedKeys.add(key)
          removedCount++
          continue
        }
        if (now.size !== e.size || now.mtime !== e.mtime) {
          e.size = now.size
          e.mtime = now.mtime
          e.headmd5 = null
          e.fullmd5 = null
          touched.push(e)
          updatedCount++
          if (archiveTypeOf(e.class) !== null) changedContainers.push(e)
        }
        fresh.delete(lp)
      }
      if (deletedKeys.size > 0) this.purgeGroupsByPaths(deletedKeys)
      // 内容可能已变的容器：先剔除旧包内条目的组员资格再删条目重列
      // （新条目路径可能与旧条目相同，组剔除必须先行，否则重列后被误剔）
      if (settings.scanArchives && changedContainers.length > 0) {
        const staleInner = new Set<string>()
        for (const c of changedContainers) {
          const ck = this.keyOf(c.path)
          for (const [key, e] of this.entries) {
            if (e.containerPath === null || this.keyOf(e.containerPath) !== ck) continue
            staleInner.add(key)
          }
        }
        this.purgeGroupsByPaths(staleInner)
        for (const key of staleInner) {
          this.entries.delete(key)
          this.owners.delete(key)
        }
        await this.listArchiveEntries(settings, changedContainers, register, lastPath)
      }

      // —— 触碰桶重哈希 → 全量重算体积树（免增量残账）——
      if (!this.canceled && touched.length > 0) {
        this.phase = 'hashing'
        this.processed = 0
        this.bytesHashed = 0
        this.foundPerTarget.set(branch, seen.length + added.length)
        await this.hashTouched(settings, [], touched)
      }
      this.rebuildDirs()
      return {
        added: added.length,
        removed: removedCount,
        updated: updatedCount,
        treeRev: this.treeRev
      }
    } finally {
      this.running = false
      this.canceled = false
      this.broadcastRev()
    }
  }

  /** 条目主键：Windows 路径大小写不敏感按小写归一，其余平台原样 */
  private keyOf(p: string): string {
    return process.platform === 'win32' ? p.toLowerCase() : p
  }

  /** 目标根的比对口径：去尾部分隔符并归一。盘根（D:\）若不先去尾，
   *  前缀判断会要求双反斜杠开头，整棵子树都无法登记/累加 */
  private stopOf(target: string): string {
    return this.keyOf(target).replace(/[\\/]+$/, '')
  }

  /** 注册条目：路径已存在（被其它目标覆盖）返回 false——嵌套目标去重的唯一入口 */
  private registerEntry(e: FileEntry, target: string): boolean {
    const key = this.keyOf(e.path)
    if (this.entries.has(key)) return false
    this.entries.set(key, e)
    this.owners.set(key, target)
    this.addEntryToDirs(e, target)
    return true
  }

  /** 排除目录登记为空节点：沿祖先链补登记（无字节），并记录归属供重建/清理 */
  private registerExcludedDir(dir: string, target: string): void {
    if (this.excludedDirs.has(dir)) return
    this.excludedDirs.set(dir, target)
    const stop = this.stopOf(target)
    let p = dir
    for (;;) {
      const lp = this.keyOf(p)
      if (lp === stop || !lp.startsWith(stop + '\\')) break
      if (this.dirs.has(p)) break // 已登记，其祖先必已登记
      this.recordDir(p)
      this.treeRev++
      p = path.dirname(p)
    }
  }

  // —— 目标移除的异步清理：立即应答，后台分批回收（定期让出事件循环）——
  private removalTasks: string[] = []
  private cleaningUp = false

  private broadcastRev(): void {
    this.broadcaster('scan:rev', { rev: this.treeRev })
  }

  /** 立即生效：根集合摘除（根行即从查询结果消失），重活入队后台执行 */
  scheduleRemoval(target: string): void {
    this.coveredTargets.delete(target)
    this.coveredKeys.delete(this.keyOf(target))
    this.foundPerTarget.delete(target)
    this.processedPerTarget.delete(target)
    this.removalTasks.push(target)
    this.treeRev++
    this.broadcastRev()
    if (!this.cleaningUp) void this.runRemovalCleanup()
  }

  private async runRemovalCleanup(): Promise<void> {
    this.cleaningUp = true
    try {
      while (this.removalTasks.length > 0) {
        const target = this.removalTasks.shift() as string
        await this.cleanupRemoval(target)
      }
    } finally {
      this.cleaningUp = false
    }
    this.broadcastRev()
  }

  /** 等待在途移除清理完成（测试与串行化用） */
  async whenSettled(): Promise<void> {
    while (this.cleaningUp || this.removalTasks.length > 0) {
      await new Promise<void>((r) => setImmediate(r))
    }
  }

  /** 内部状态快照（测试与 tools/ 诊断用） */
  diag(): { entries: number; owners: number; dirs: number; excludedDirs: number } {
    return {
      entries: this.entries.size,
      owners: this.owners.size,
      dirs: this.dirs.size,
      excludedDirs: this.excludedDirs.size
    }
  }

  /** 内部状态查询（测试与 tools/ 诊断用；原始大小写路径） */
  diagEntry(path: string): FileEntry | undefined {
    return this.entries.get(this.keyOf(path))
  }

  diagDir(path: string): { size: number; dup: number } | undefined {
    const r = this.dirs.get(path)
    return r ? { size: r.size, dup: r.dup } : undefined
  }

  /** 内部状态查询（测试与 tools/ 诊断用）：已确认重复组及成员路径 */
  diagEntries(): string[] {
    return [...this.entries.keys()]
  }

  diagGroups(): Array<{ key: string; paths: string[]; wasted: number }> {
    return [...this.knownGroups.values()].map((g) => ({
      key: g.key,
      paths: g.entries.map((e) => e.path),
      wasted: g.size * (g.entries.length - 1)
    }))
  }

  /** 单个目标的后台清理：重归属（含体量补记）/删除（含体量反扣、文件行
   *  移除、空链剪枝）/组剔除，全部分批让出 */
  private async cleanupRemoval(target: string): Promise<void> {
    if (this.coveredTargets.has(target)) return // 移除后重新添加：现状即正确
    const remaining = [...this.coveredTargets]
    const wasted = this.wastedMap()
    const deleted = new Set<string>()
    const pruneSeeds = new Set<string>([target])
    let n = 0
    for (const [key, owner] of this.owners) {
      if (owner !== target) continue
      const e = this.entries.get(key)
      // 选最深覆盖者（路径最长者最具体）
      let best: string | null = null
      for (const t of remaining) {
        const lt = this.stopOf(t)
        if (
          (key === lt || key.startsWith(lt + '\\')) &&
          (best === null || lt.length > this.stopOf(best).length)
        ) {
          best = t
        }
      }
      if (best && e) {
        this.owners.set(key, best)
        this.extendBytes(e, target, best, wasted.get(e.path) ?? 0)
      } else {
        if (e) pruneSeeds.add(path.dirname(e.path))
        if (e) {
          this.subtractEntry(e, target, wasted.get(e.path) ?? 0)
          this.entries.delete(key)
          deleted.add(key)
          const parent = path.dirname(e.path)
          const arr = this.dirFiles.get(parent)
          if (arr) {
            const idx = arr.findIndex((f) => f.path === e.path)
            if (idx >= 0) arr.splice(idx, 1)
            if (arr.length === 0) this.dirFiles.delete(parent)
          }
        }
        this.owners.delete(key)
      }
      if (++n % 100000 === 0) await new Promise<void>((r) => setImmediate(r))
    }
    this.purgeGroupsByPaths(deleted)
    for (const [dir, owner] of [...this.excludedDirs]) {
      if (owner !== target) continue
      this.excludedDirs.delete(dir)
      pruneSeeds.add(dir)
    }
    this.pruneEmptyChains(pruneSeeds)
    this.treeRev++
  }

  /** 重归属的体量补记：注册时字节只累加到旧归属根，归属改浅后需把
   *  旧归属根之上的祖先链补齐（新归属更深时无需补——链上本就计过）。
   *  dup 同理（dupBytes 为该条目作为非保留副本的分摊） */
  private extendBytes(e: FileEntry, oldOwner: string, newOwner: string, dupBytes: number): void {
    const stopNew = this.stopOf(newOwner)
    const stopOld = this.stopOf(oldOwner)
    if (stopNew === stopOld || stopNew.startsWith(stopOld + '\\')) return
    let p = path.dirname(oldOwner)
    for (;;) {
      const rec = this.dirs.get(p)
      if (!rec) break
      rec.size += e.size
      rec.dup += dupBytes
      const lp = this.keyOf(p)
      if (lp === stopNew) break
      const parent = path.dirname(p)
      if (parent === p) break
      p = parent
    }
  }

  /** 删除条目的体量反扣（沿注册时的归属链）并移除文件行；dup 一并反扣 */
  private subtractEntry(e: FileEntry, oldOwner: string, dupBytes: number): void {
    const stop = this.stopOf(oldOwner)
    let p = path.dirname(e.path)
    for (;;) {
      const rec = this.dirs.get(p)
      if (!rec) break
      rec.size -= e.size
      if (rec.size < 0) rec.size = 0
      rec.dup -= dupBytes
      if (rec.dup < 0) rec.dup = 0
      const lp = this.keyOf(p)
      if (lp === stop) break
      const parent = path.dirname(p)
      if (parent === p) break
      p = parent
    }
  }

  /** 剪枝：删除条目所在链上已彻底为空（零体积、无子、无文件、非目标根）的目录 */
  private pruneEmptyChains(seeds: Set<string>): void {
    for (let p of seeds) {
      for (;;) {
        const rec = this.dirs.get(p)
        if (!rec) break
        const kids = this.childDirs.get(p)
        const files = this.dirFiles.get(p)
        if (
          rec.size > 0 ||
          rec.dup > 0 ||
          (kids !== undefined && kids.length > 0) ||
          (files !== undefined && files.length > 0) ||
          this.coveredTargets.has(p)
        ) {
          break
        }
        const parent = rec.parent
        this.dirs.delete(p)
        const arr = this.childDirs.get(parent)
        if (arr) {
          const idx = arr.indexOf(p)
          if (idx >= 0) arr.splice(idx, 1)
          if (arr.length === 0) this.childDirs.delete(parent)
        }
        this.dirFiles.delete(p)
        if (parent === p) break
        p = parent
      }
    }
  }

  /** 从组中剔除已删除的路径，不足 2 个成员的组解散 */
  private purgeGroupsByPaths(keys: Set<string>): void {
    if (keys.size === 0) return
    for (const [k, g] of this.knownGroups) {
      const kept = g.entries.filter((e) => !keys.has(this.keyOf(e.path)))
      if (kept.length === g.entries.length) continue
      if (kept.length >= 2) this.knownGroups.set(k, { ...g, entries: kept })
      else this.knownGroups.delete(k)
    }
  }

  /** 枚举新增目标（Everything 优先，逐目标回退 fs walk） */
  private async enumerateAdds(
    addList: string[],
    settings: ScanSettings,
    lister: EverythingLister | null
  ): Promise<void> {
    this.phase = 'listing'
    const lastPath = { value: '' }

    for (const target of addList) {
      if (this.canceled) break
      const added: FileEntry[] = []
      // 注册闭包：去重判定 + 会话计数（嵌套目标覆盖的路径在此被挡下）
      const register = (e: FileEntry): boolean => {
        if (!this.registerEntry(e, target)) return false
        added.push(e)
        this.found++
        return true
      }
      const ctx = {
        settings,
        excl: this.excl,
        onExcludedDir: (p: string): void => {
          this.registerExcludedDir(p, target)
        },
        canceled: (): boolean => this.canceled,
        onEntry: (e: FileEntry): void => {
          if (!register(e)) return
          this.emitProgress(e.path)
          lastPath.value = e.path
        },
        onDir: (p: string): void => {
          lastPath.value = p
        },
        onError: (_p: string, err: unknown): void => {
          this.errors++
          if (isPermissionError(err)) this.denied++
        }
      }

      // 目标根本身被排除：整棵子树视为不存在（根行已登记，空目录呈现）
      if (this.excl.names.has(path.basename(target)) || isPathExcludedDir(target, this.excl)) {
        this.foundPerTarget.set(target, 0)
        continue
      }
      let handled = false
      if (lister) {
        try {
          handled = await this.listViaEverything(lister, target, settings, register, lastPath)
        } catch (err) {
          console.warn(`[scan] Everything 枚举失败，回退 walk：${target}`, err)
        }
      }
      if (!handled) await walkTargets([target], ctx)

      // 压缩包条目枚举（容器来自本目标的条目）
      if (settings.scanArchives) {
        await this.listArchiveEntries(settings, added, register, lastPath)
      }

      this.foundPerTarget.set(target, added.length)
    }
  }

  /** 枚举扫描到的压缩包内条目；容器本身也是普通候选，条目按 `容器::包内路径` 建条 */
  private async listArchiveEntries(
    settings: ScanSettings,
    added: FileEntry[],
    register: (e: FileEntry) => boolean,
    lastPath: { value: string }
  ): Promise<void> {
    const pool = getHashPool()
    const containers = added.filter(
      (e) => e.containerPath === null && archiveTypeOf(e.class) !== null
    )
    await pMap(containers, ARCHIVE_LIST_CONCURRENCY, async (c) => {
      if (this.canceled) return
      const type = archiveTypeOf(c.class) as ArchiveType
      try {
        const metas = (await pool.archiveList(type, c.path)) as ArchiveEntryMeta[] | null
        if (metas === null) throw new Error('元信息读取失败')
        for (const m of metas) {
          const entry = buildArchiveEntry(c, type, m, settings)
          if (entry) {
            if (!register(entry)) continue
            lastPath.value = entry.path
          }
        }
      } catch {
        this.errors++
      }
    })
  }

  /**
   * 只比较「被新条目触碰」的 L0 桶：全量条目分桶后，取至少含一个新条目
   * 且成员 ≥ 2 的桶进入阶梯。现有条目哈希已记忆化，不重复读盘；
   * 产出的组为全量成员（含既有成员），渲染层按 key 幂等替换。
   * extraTouched：分支刷新等场景中需重比对的既有条目（哈希已被调用方清空）。
   */
  private async hashTouched(
    settings: ScanSettings,
    addList: string[],
    extraTouched: readonly FileEntry[] = []
  ): Promise<void> {
    const touched = new Set<string>()
    const addSet = new Set(addList)
    // 触碰桶 = 新增目标所拥有条目的 L0 键（嵌套覆盖的既有条目不重触发哈希）
    let sinceYield = 0
    for (const [key, e] of this.entries) {
      const owner = this.owners.get(key)
      if (owner !== undefined && addSet.has(owner)) touched.add(this.l0Key(e, settings))
      // 全盘目标的条目量达百万级，大循环定期让出事件循环保持窗口响应
      if (++sinceYield >= 200000) {
        sinceYield = 0
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    for (const e of extraTouched) touched.add(this.l0Key(e, settings))

    // 全量条目分桶，只保留被触碰的桶
    const buckets = new Map<string, FileEntry[]>()
    for (const e of this.entries.values()) {
      const key = this.l0Key(e, settings)
      if (!touched.has(key)) continue
      const b = buckets.get(key)
      if (b) b.push(e)
      else buckets.set(key, [e])
      if (++sinceYield >= 200000) {
        sinceYield = 0
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    this.found = 0
    for (const b of buckets.values()) this.found += b.length

    // RAR 整卷解压 pass（临时目录已存在则跳过，跨操作复用）
    const tempPaths = await this.extractRarCandidates(settings, buckets)

    let lastFlush = Date.now()
    const out: DupeGroup[] = []
    const flush = (): void => {
      if (out.length === 0) return
      this.broadcaster('scan:group', { sessionId: this.sessionId, groups: [...out] })
      out.length = 0
      lastFlush = Date.now()
    }

    for (const bucket of buckets.values()) {
      if (this.canceled) break
      this.processed += bucket.length
      for (const e of bucket) {
        const t = this.targetOf(e)
        if (t) this.processedPerTarget.set(t, (this.processedPerTarget.get(t) ?? 0) + 1)
      }

      if (bucket.length < 2) {
        this.emitProgress(bucket[0]?.path ?? '')
        continue
      }

      // 空文件内容必然相同，免哈希直接成组（key 稳定：名称+体积，不含成员数）
      if (bucket[0].size === 0) {
        const group: DupeGroup = {
          key: `empty:${bucket[0].name}#${bucket[0].size}`,
          size: 0,
          entries: bucket
        }
        this.knownGroups.set(group.key, group)
        this.attributeDupToDirs(group)
        out.push(group)
      } else {
        for (const group of await this.resolveBucket(bucket, tempPaths)) {
          this.knownGroups.set(group.key, group)
          this.attributeDupToDirs(group)
          out.push(group)
        }
      }
      this.emitProgress(bucket[0]?.path ?? '')
      if (out.length >= GROUP_FLUSH_COUNT || Date.now() - lastFlush >= GROUP_FLUSH_MS) flush()
    }
    flush()
  }

  /** 组确认后把重复占用计入渐进树（哈希期增量归集，与 rebuildDirs 第3步同语义）；
   *  递增树版本让前端在哈希阶段也能实时重取 dup 数据 */
  private attributeDupToDirs(group: DupeGroup): void {
    const kept = group.entries.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
    for (const e of group.entries) {
      if (e.path === kept.path) continue
      if (e.containerPath !== null && e.entryPath !== null) {
        this.addArchiveBytes(e.containerPath, e.entryPath, e.size, true)
      } else {
        const t = this.targetOf(e)
        this.addBytes(e.path, e.size, true, t ?? '')
      }
    }
    this.treeRev++
  }

  private l0Key(e: FileEntry, settings: ScanSettings): string {
    return settings.ignoreName ? `s:${e.size}` : `n:${e.name}#s:${e.size}`
  }

  /**
   * RAR 整卷解压 pass：多成员桶内的 rar 条目，按容器整卷解到临时目录
   * （跨操作复用：临时目录已存在则跳过）。固实卷逐条目解压需重复解压
   * 公共前缀（实测单条 2s × 数千条会拖死哈希阶段）。
   */
  private async extractRarCandidates(
    settings: ScanSettings,
    buckets: Map<string, FileEntry[]>
  ): Promise<Map<string, string>> {
    const tempPaths = new Map<string, string>()
    if (!settings.scanArchives) return tempPaths

    const pool = getHashPool()
    const containers = new Set<string>()
    for (const bucket of buckets.values()) {
      for (const e of bucket) {
        if (e.archiveType === 'rar' && e.containerPath !== null) containers.add(e.containerPath)
      }
    }
    if (containers.size === 0) return tempPaths

    // 整卷解压（一次 unrar x）比按候选分批快：分批的每批都要从头
    // 重新解压固实前缀（实测 18 批 42s vs 整卷 12-17s），且无清单编码问题
    for (const container of containers) {
      if (this.canceled) return tempPaths
      const tempRoot = path.join(
        os.tmpdir(),
        'dupeseek-rar-' +
          createHash('md5').update(container.toLowerCase()).digest('hex').slice(0, 12)
      )
      if (!this.archiveTempRoots.includes(tempRoot)) this.archiveTempRoots.push(tempRoot)
      const ok = await pool.rarExtract(container, tempRoot)
      if (!ok) continue
      // 该容器下所有参与比较的 rar 条目都映射到临时文件
      for (const e of this.entries.values()) {
        if (e.archiveType !== 'rar' || e.containerPath !== container || e.entryPath === null)
          continue
        const temp = path.join(tempRoot, e.entryPath)
        try {
          if (fs.statSync(temp).isFile()) tempPaths.set(e.path, temp)
        } catch {
          // 加密/损坏条目解不出，哈希阶段按独立文件跳过
        }
      }
    }
    return tempPaths
  }

  /** 用 Everything 枚举一个目录目标；返回 false 表示走不了该通道（如目标是文件） */
  private async listViaEverything(
    lister: EverythingLister,
    target: string,
    settings: ScanSettings,
    register: (e: FileEntry) => boolean,
    lastPath: { value: string }
  ): Promise<boolean> {
    const st = await fs.promises.lstat(target)
    if (!st.isDirectory()) return false

    const res = await lister.list(target)

    // reparse point 清单（/aL 一次查询）：junction/符号链接目录 + 云占位等。
    // 内存前缀比较替代逐目录 lstat——目录数量大时显著更快，且不产生磁盘 I/O。
    const reparseSet = new Set(res.reparse.map((p) => p.toLowerCase()))
    const isReparse = (p: string): boolean => reparseSet.has(p.toLowerCase())
    // excludeJunction=false 时 junction 子树照常纳入（与 walk 通道语义一致）
    const skipReparse = settings.excludeJunction

    // 目录级排除：被排除目录的整棵子树都要剔除（Everything 返回顺序不定，先收集前缀再统一过滤）
    // node_modules：Everything 返回全量数据，直接按目录名收集前缀后从数组剔除
    const excluded: string[] = []
    const dirOk: string[] = []
    // 设置中的路径排除：其子树文件/目录一律按前缀过滤
    for (const e of this.excl.pathStops) excluded.push(e)
    const nameHits: string[] = []
    const pathHits: string[] = []
    for (const dir of res.dirs) {
      const name = path.basename(dir)
      if (settings.excludeHidden && name.startsWith('.')) {
        excluded.push(dir)
        continue
      }
      if (settings.excludeSystem && SYSTEM_DIRS.has(name)) {
        excluded.push(dir)
        continue
      }
      if (this.excl.names.has(name) || isPathExcludedDir(dir, this.excl)) {
        // 排除命中：先收集，后取最顶层登记（es 返回顺序不定）
        if (this.excl.names.has(name)) nameHits.push(dir)
        else pathHits.push(dir)
        excluded.push(dir)
        continue
      }
      if (isReparse(dir) && skipReparse) {
        excluded.push(dir)
        continue
      }
      dirOk.push(dir)
    }
    // 路径命中里只登记最顶层（es 返回顺序不定，收集后统一计算）；
    // 名称命中若位于某路径排除之内则由该路径节点代表，不重复登记
    const inside = (p: string, ancestor: string): boolean => {
      const norm = (x: string): string =>
        (process.platform === 'win32' ? x.toLowerCase() : x).replace(/[\\/]+$/, '')
      const np = norm(p)
      const na = norm(ancestor)
      return np === na || np.startsWith(na + '\\')
    }
    // 名称命中先收敛（嵌套同名由顶层代表；位于路径排除之内的同样跳过）
    const nameTops = nameHits.filter(
      (d) => !nameHits.some((o) => o !== d && inside(d, o)) && !pathHits.some((o) => inside(d, o))
    )
    for (const d of nameTops) this.registerExcludedDir(d, target)
    // 路径命中收敛：不被名称命中或其它路径命中包含的最顶层
    const pathTops = pathHits.filter(
      (d) => !pathHits.some((o) => o !== d && inside(d, o)) && !nameTops.some((t) => inside(d, t))
    )
    for (const d of pathTops) this.registerExcludedDir(d, target)
    const isExcluded = (p: string): boolean => {
      const lower = p.toLowerCase()
      return excluded.some((d) => lower.startsWith(`${d.toLowerCase()}\\`))
    }

    let sinceYield = 0
    for (const f of res.files) {
      // 长任务占住主进程会让窗口失去响应（拖动/重绘全停）：定期让出事件循环
      if (++sinceYield >= 3000) {
        sinceYield = 0
        this.emitProgress(lastPath.value)
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (this.canceled) return true
      }
      // reparse 文件（文件符号链接/云占位文件）：读取前者会穿越链接、
      // 读取后者会触发云端下载，均不符合本地查重的定位
      if (isExcluded(f.filename) || (isReparse(f.filename) && skipReparse)) continue
      const name = path.basename(f.filename)
      if (settings.excludeHidden && name.startsWith('.')) continue
      const cls = extOf(name)
      if (!extAllowed(cls, settings)) continue
      if (settings.minSize !== null && f.size < settings.minSize) continue
      if (settings.maxSize !== null && f.size > settings.maxSize) continue
      const entry: FileEntry = {
        path: f.filename,
        name,
        size: f.size,
        class: cls,
        mtime: f.mtimeMs,
        containerPath: null,
        entryPath: null,
        archiveType: null,
        crc32: null,
        headmd5: null,
        fullmd5: null
      }
      if (!register(entry)) continue
      this.emitProgress(entry.path)
      lastPath.value = entry.path
    }
    return true
  }

  /** 增量登记一个条目的目录链与体积（渐进树用；与 rebuildDirs 语义一致） */
  private addEntryToDirs(e: FileEntry, target: string): void {
    const stop = this.stopOf(target)
    if (e.containerPath !== null && e.entryPath !== null) {
      const root = e.containerPath + '::'
      this.recordDirAt(root, path.dirname(e.containerPath), path.basename(e.containerPath))
      const segs = e.entryPath.split(/[\\/]/)
      let p = root
      for (let i = 0; i < segs.length - 1; i++) {
        const next = p + '/' + segs[i]
        this.recordDirAt(next, p, segs[i])
        p = next
      }
      this.addArchiveBytes(e.containerPath, e.entryPath, e.size, false)
    } else {
      this.recordDir(target)
      let p = path.dirname(e.path)
      for (;;) {
        const lp = p.toLowerCase()
        if (lp === stop || !lp.startsWith(stop + '\\')) break
        this.recordDir(p)
        const parent = path.dirname(p)
        if (parent === p) break
        p = parent
      }
      this.addBytes(e.path, e.size, false, target)
      // 直属文件索引增量维护 + 树版本递增（前端据此重取）
      const parent = path.dirname(e.path)
      const item: TreeNodeFile = { path: e.path, name: e.name, size: e.size, dupWasted: 0 }
      const arr = this.dirFiles.get(parent)
      if (arr) arr.push(item)
      else this.dirFiles.set(parent, [item])
      this.treeRev++
    }
  }

  private emitProgress(currentPath: string): void {
    const now = Date.now()
    if (now - this.lastProgressAt < PROGRESS_MS) return
    this.lastProgressAt = now
    const progress: ScanProgress = {
      sessionId: this.sessionId,
      phase: this.phase,
      filesFound: this.found,
      filesProcessed: this.processed,
      bytesHashed: this.bytesHashed,
      currentPath,
      percent: this.found > 0 ? Math.min(100, (this.processed / this.found) * 100) : 0,
      denied: this.denied + getHashPool().deniedCount,
      treeRev: this.treeRev,
      targets: this.progressTargets.map((t) => {
        const total = this.foundPerTarget.get(t) ?? 0
        const processed = this.processedPerTarget.get(t) ?? 0
        return { path: t, percent: total > 0 ? Math.min(100, (processed / total) * 100) : 0 }
      })
    }
    this.broadcaster('scan:progress', progress)
  }

  /** 条目归属的目标（注册时确定；移除目标时已向剩余覆盖者重归属） */
  private targetOf(entry: FileEntry): string | null {
    return this.owners.get(this.keyOf(entry.path)) ?? null
  }

  /**
   * 体积树重算：目录节点与聚合全部由当前条目集推导（无增量残账）。
   * 三步：登记节点 → 体积聚合 → 重复占用归集（每组保留最早修改的一份）。
   */
  private rebuildDirs(): void {
    this.dirs = new Map()
    this.dirFiles = new Map()
    this.childDirs = new Map()
    this.treeRev++

    // 1) 登记节点：目标根、真实祖先目录、压缩包合成目录链
    for (const target of this.coveredTargets) this.recordDir(target)
    for (const e of this.entries.values()) {
      if (e.containerPath !== null && e.entryPath !== null) {
        const root = e.containerPath + '::'
        this.recordDirAt(root, path.dirname(e.containerPath), path.basename(e.containerPath))
        const segs = e.entryPath.split(/[\\/]/)
        let p = root
        for (let i = 0; i < segs.length - 1; i++) {
          const next = p + '/' + segs[i]
          this.recordDirAt(next, p, segs[i])
          p = next
        }
      } else {
        const stop = this.stopOf(this.owners.get(this.keyOf(e.path)) ?? '')
        let p = path.dirname(e.path)
        for (;;) {
          const lp = p.toLowerCase()
          if (lp === stop || stop === '' || !lp.startsWith(stop + '\\')) break
          this.recordDir(p)
          const parent = path.dirname(p)
          if (parent === p) break
          p = parent
        }
      }
    }

    // 2) 体积聚合
    for (const e of this.entries.values()) {
      if (e.containerPath !== null && e.entryPath !== null) {
        this.addArchiveBytes(e.containerPath, e.entryPath, e.size, false)
      } else {
        this.addBytes(e.path, e.size, false, this.owners.get(this.keyOf(e.path)) ?? '')
      }
    }

    // 3) 重复占用归集
    for (const g of this.knownGroups.values()) {
      if (g.entries.length < 2) continue
      const kept = g.entries.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
      for (const e of g.entries) {
        if (e.path === kept.path) continue
        if (e.containerPath !== null && e.entryPath !== null) {
          this.addArchiveBytes(e.containerPath, e.entryPath, e.size, true)
        } else {
          const target = this.targetOf(e)
          this.addBytes(e.path, e.size, true, target ?? '')
        }
      }
    }

    // 4) 直属真实文件挂载（压缩包内条目不挂，其体积已走合成目录链）；
    //    文件级重复占用由查询接口按 wastedMap 现算，不在此缓存
    for (const e of this.entries.values()) {
      if (e.containerPath !== null) continue
      const item: TreeNodeFile = { path: e.path, name: e.name, size: e.size, dupWasted: 0 }
      const parent = path.dirname(e.path)
      const arr = this.dirFiles.get(parent)
      if (arr) arr.push(item)
      else this.dirFiles.set(parent, [item])
    }

    // 5) 排除目录的空节点重登记（不参与体量，仅占位呈现）
    for (const [dir, target] of this.excludedDirs) this.recordDirChain(dir, target)
  }

  /** 沿祖先链补登记目录节点（排除目录用；不累加字节） */
  private recordDirChain(dir: string, target: string): void {
    const stop = this.stopOf(target)
    let p = dir
    for (;;) {
      const lp = this.keyOf(p)
      if (lp === stop || !lp.startsWith(stop + '\\')) break
      if (this.dirs.has(p)) break // 已登记，其祖先必已登记
      this.recordDir(p)
      p = path.dirname(p)
    }
  }

  /** 显式指定父节点的登记（用于 `容器::包内路径` 这类合成目录，dirname 不适用） */
  private recordDirAt(p: string, parent: string, name: string): void {
    if (this.dirs.has(p)) return
    this.dirs.set(p, { parent, name, size: 0, dup: 0 })
    // 子级索引（盘根 dirname 即自身，跳过自指）
    if (parent !== p) {
      const arr = this.childDirs.get(parent)
      if (arr) arr.push(p)
      else this.childDirs.set(parent, [p])
    }
  }

  private recordDir(dir: string): void {
    this.recordDirAt(dir, path.dirname(dir), path.basename(dir) || dir)
  }

  /** 压缩包条目的体积沿包内合成目录链累加，止步于合成根（不进入真实目录，避免与压缩后的包体积重复计账） */
  private addArchiveBytes(
    containerPath: string,
    entryPath: string,
    bytes: number,
    dup: boolean
  ): void {
    const root = containerPath + '::'
    const segs = entryPath.split(/[\\/]/)
    let p = root
    for (let i = 0; i < segs.length - 1; i++) p = p + '/' + segs[i]
    for (;;) {
      const rec = this.dirs.get(p)
      if (!rec) break
      if (dup) rec.dup += bytes
      else rec.size += bytes
      if (p === root) break
      p = rec.parent
    }
  }

  /** 把字节数沿文件的祖先目录链累加到所属目标根为止 */
  private addBytes(filePath: string, bytes: number, dup: boolean, targetRoot: string): void {
    const stop = this.stopOf(targetRoot)
    let p = path.dirname(filePath)
    for (;;) {
      const rec = this.dirs.get(p)
      if (!rec) break
      if (dup) rec.dup += bytes
      else rec.size += bytes
      if (p.toLowerCase() === stop) break
      const parent = path.dirname(p)
      if (parent === p) break
      p = parent
    }
  }

  // —— 体积树按需查询（渲染层拉取协议；数据权威在后端，前端只缓存展示）——

  treeVersion(): number {
    return this.treeRev
  }

  /** 文件级重复占用：该文件在各重复组中作为非保留副本的体积之和（按版本缓存） */
  private wastedMap(): Map<string, number> {
    if (this.wastedCache && this.wastedCache.rev === this.treeRev) return this.wastedCache.map
    const map = new Map<string, number>()
    for (const g of this.knownGroups.values()) {
      if (g.entries.length < 2) continue
      const kept = g.entries.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
      for (const e of g.entries) {
        if (e.path === kept.path || e.containerPath !== null) continue
        map.set(e.path, (map.get(e.path) ?? 0) + e.size)
      }
    }
    this.wastedCache = { rev: this.treeRev, map }
    return map
  }

  private rowOf(p: string, files: TreeNodeFile[] | undefined): TreeDirRowData {
    const rec = this.dirs.get(p)
    return {
      path: p,
      name: rec?.name ?? p,
      size: rec?.size ?? 0,
      dupWasted: rec?.dup ?? 0,
      childDirs: this.childDirs.get(p)?.length ?? 0,
      fileCount: files?.length ?? 0,
      fileBytes: files?.reduce((s, f) => s + f.size, 0) ?? 0
    }
  }

  private stats(): TreeStats {
    // O(entries) 全量扫描，按版本缓存——枚举期每次查询都带统计时这里最热
    if (this.statsCache && this.statsCache.rev === this.treeRev) return this.statsCache.stats
    let totalSize = 0
    for (const e of this.entries.values()) totalSize += e.size
    let totalDup = 0
    for (const g of this.knownGroups.values()) {
      if (g.entries.length >= 2) totalDup += g.size * (g.entries.length - 1)
    }
    const stats = { totalSize, totalDup, dirCount: this.dirs.size }
    this.statsCache = { rev: this.treeRev, stats }
    return stats
  }

  private sortDirRows(rows: TreeDirRowData[], sortKey: TreeSortKey, desc: boolean): void {
    const dir = desc ? -1 : 1
    rows.sort((a, b) => {
      if (sortKey === 'name') {
        return dir * a.name.localeCompare(b.name, undefined, { numeric: true })
      }
      if (sortKey === 'dup') return dir * (a.dupWasted - b.dupWasted)
      return dir * (a.size - b.size)
    })
  }

  private fileRowsOf(
    dir: string,
    wasted: Map<string, number>
  ): Array<{ path: string; name: string; size: number; dupWasted: number }> {
    return (this.dirFiles.get(dir) ?? []).map((f) => ({
      path: f.path,
      name: f.name,
      size: f.size,
      dupWasted: wasted.get(f.path) ?? 0
    }))
  }

  /** 根级行：每个已纳入同步的目标一行（嵌套目标同一数据多处引用） */
  treeRoots(sortKey: TreeSortKey, desc: boolean): TreeChildrenReply {
    const rows = [...this.coveredTargets]
      .filter((t) => this.dirs.has(t))
      .map((t) => this.rowOf(t, this.dirFiles.get(t)))
    this.sortDirRows(rows, sortKey, desc)
    return { rev: this.treeRev, dirs: rows, agg: null, stats: this.stats() }
  }

  /** 某目录的子目录行 + 直属文件聚合行（无子目录的目录不返回聚合，前端逐文件展开） */
  treeChildren(dir: string, sortKey: TreeSortKey, desc: boolean): TreeChildrenReply | null {
    if (!this.dirs.has(dir)) return null
    const wasted = this.wastedMap()
    const rows = (this.childDirs.get(dir) ?? []).map((p) => this.rowOf(p, this.dirFiles.get(p)))
    this.sortDirRows(rows, sortKey, desc)
    const files = this.fileRowsOf(dir, wasted)
    const agg =
      rows.length > 0 && files.length > 0
        ? {
            count: files.length,
            size: files.reduce((s, f) => s + f.size, 0),
            dupWasted: files.reduce((s, f) => s + f.dupWasted, 0)
          }
        : null
    return { rev: this.treeRev, dirs: rows, agg, stats: this.stats() }
  }

  treeFiles(
    dir: string,
    sortKey: TreeSortKey,
    desc: boolean,
    offset: number,
    limit: number
  ): TreeFilesReply | null {
    if (!this.dirs.has(dir)) return null
    const rows = this.fileRowsOf(dir, this.wastedMap())
    const dirFlag = desc ? -1 : 1
    rows.sort((a, b) => {
      if (sortKey === 'name') {
        return dirFlag * a.name.localeCompare(b.name, undefined, { numeric: true })
      }
      if (sortKey === 'dup') return dirFlag * (a.dupWasted - b.dupWasted)
      return dirFlag * (a.size - b.size)
    })
    const start = Math.max(0, offset)
    return {
      rev: this.treeRev,
      total: rows.length,
      rows: rows.slice(start, start + Math.max(1, limit))
    }
  }

  /**
   * 分支统计（右键菜单「统计数据」）：体积/数量口径与体积树显示一致
   * （docs/Cleanup.md）。仅支持真实目录；大小分布做 1D k-means（≤10 组）。
   */
  treeStats(path: string): BranchStats | null {
    if (path.includes('::')) return null // 压缩包合成目录不支持
    const rec = this.dirs.get(path)
    if (!rec) return null
    const stop = this.keyOf(path)
    const sizes: number[] = []
    let fileCount = 0
    let dirCount = 0
    const visit = (dir: string): void => {
      for (const f of this.dirFiles.get(dir) ?? []) {
        sizes.push(f.size)
        fileCount++
      }
      for (const c of this.childDirs.get(dir) ?? []) {
        if (c.includes('::')) continue // 合成链不计目录数，包内条目下方按容器归并
        dirCount++
        visit(c)
      }
    }
    visit(path)
    for (const e of this.entries.values()) {
      if (e.containerPath === null) continue
      const ck = this.keyOf(e.containerPath)
      if (ck === stop || ck.startsWith(stop + '\\')) {
        sizes.push(e.size)
        fileCount++
      }
    }
    return {
      totalSize: rec.size,
      fileCount,
      dirCount,
      avgSize: fileCount > 0 ? rec.size / fileCount : 0,
      histogram: kmeansBuckets(sizes, 10)
    }
  }

  /**
   * 目录关系图（graph:relations）：把重复内容类按「展示单元」聚合为目录对关系。
   * 展示单元 = 目标根与目标下指定深度的目录（目标根 depth=0）；边 = 两个单元之间
   * 可互相消去的重复内容，无向、不含任何时间/行为语义。Phase 1 供「关系气泡」
   * 与「关系捆绑」两个视图使用，见 docs/Relations.md。
   */
  graphRelations(maxDepth: number, minSharedBytes: number): GraphRelationsReply {
    const depthLimit = Math.max(0, Math.min(6, Math.floor(maxDepth)))
    const minBytes = Math.max(0, Math.floor(minSharedBytes))
    /** 单组位置数上限：超过视为噪声大组（如全盘相同的空/模板文件），不参与关系图 */
    const MAX_UNITS_PER_GROUP = 32
    const MAX_EDGES = 20000

    const rootCache = new Map<string, string | null>()
    /** 单元所属目标根（取最深覆盖者）；不在任何目标内返回 null */
    const rootOf = (dir: string): string | null => {
      const cached = rootCache.get(dir)
      if (cached !== undefined) return cached
      const key = this.keyOf(dir)
      let best: string | null = null
      let bestLen = -1
      for (const t of this.coveredTargets) {
        const stop = this.stopOf(t)
        if ((key === stop || key.startsWith(stop + '\\')) && stop.length > bestLen) {
          best = t
          bestLen = stop.length
        }
      }
      rootCache.set(dir, best)
      return best
    }

    const unitCache = new Map<string, string | null>()
    /** 实例目录 → 展示单元：深度超过 depthLimit 时上卷到该层的祖先目录 */
    const displayUnit = (dir: string): string | null => {
      const cached = unitCache.get(dir)
      if (cached !== undefined) return cached
      const root = rootOf(dir)
      let unit: string | null = null
      if (root !== null) {
        const stop = this.stopOf(root)
        let cur = dir
        let depth = 0
        while (this.keyOf(cur) !== stop) {
          const parent = path.dirname(cur)
          if (parent === cur) break
          cur = parent
          depth++
        }
        const cut = depth - Math.min(depth, depthLimit)
        unit = dir
        for (let i = 0; i < cut; i++) unit = path.dirname(unit)
      }
      unitCache.set(dir, unit)
      return unit
    }

    // —— 内容类 → 展示单元对 的共享量聚合 ——
    interface PairAgg {
      source: string
      target: string
      sharedBytes: number
      sharedFiles: number
    }
    const pairs = new Map<string, PairAgg>()
    let truncatedGroups = 0
    const unitKey = (p: string): string => this.keyOf(p)
    for (const group of this.knownGroups.values()) {
      if (group.size === 0 || group.entries.length < 2) continue
      const counts = new Map<string, number>()
      for (const e of group.entries) {
        // Phase 1：压缩包内条目按其容器所在目录参与关系（包视为特殊目录的简化）
        const dir = e.containerPath !== null ? path.dirname(e.containerPath) : path.dirname(e.path)
        const unit = displayUnit(dir)
        if (unit === null) continue
        counts.set(unit, (counts.get(unit) ?? 0) + 1)
      }
      if (counts.size < 2) continue
      if (counts.size > MAX_UNITS_PER_GROUP) {
        truncatedGroups++
        continue
      }
      const units = [...counts.keys()]
      for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
          const a = units[i]
          const b = units[j]
          const sharedFiles = Math.min(counts.get(a) as number, counts.get(b) as number)
          if (sharedFiles <= 0) continue
          const ak = unitKey(a)
          const bk = unitKey(b)
          const key = ak < bk ? `${ak}\u0000${bk}` : `${bk}\u0000${ak}`
          const agg = pairs.get(key)
          const sharedBytes = sharedFiles * group.size
          if (agg) {
            agg.sharedBytes += sharedBytes
            agg.sharedFiles += sharedFiles
          } else {
            pairs.set(key, { source: a, target: b, sharedBytes, sharedFiles })
          }
        }
      }
    }

    // —— 阈值过滤 + 规模上限 ——
    let edges = [...pairs.values()].filter((p) => p.sharedBytes >= minBytes)
    edges.sort((a, b) => b.sharedBytes - a.sharedBytes)
    if (edges.length > MAX_EDGES) edges = edges.slice(0, MAX_EDGES)

    // —— 节点：边端点 + 祖先链（字节/回收走体积树口径）——
    const nodes = new Map<string, GraphNode>()
    const nodeOf = (p: string): GraphNode => {
      const k = unitKey(p)
      const hit = nodes.get(k)
      if (hit) return hit
      const rec = this.dirs.get(p)
      const node: GraphNode = {
        id: p,
        name: path.basename(p) || p,
        parentId: '',
        depth: 0,
        bytes: rec ? rec.size : 0,
        reclaim: rec ? rec.dup : 0,
        hasChildren: false
      }
      nodes.set(k, node)
      return node
    }
    const addChain = (unit: string): void => {
      const root = rootOf(unit)
      if (root === null) {
        nodeOf(unit)
        return
      }
      const stop = this.stopOf(root)
      const chain: string[] = [unit]
      let cur = unit
      while (this.keyOf(cur) !== stop) {
        const parent = path.dirname(cur)
        if (parent === cur) break
        cur = parent
        chain.push(cur)
      }
      for (let i = 0; i < chain.length; i++) {
        const node = nodeOf(chain[i])
        node.depth = chain.length - 1 - i
        node.parentId = i + 1 < chain.length ? chain[i + 1] : ''
      }
    }
    for (const e of edges) {
      addChain(e.source)
      addChain(e.target)
    }
    const list = [...nodes.values()]
    for (const n of list) {
      if (n.parentId === '') continue
      const parent = nodes.get(unitKey(n.parentId))
      if (parent) parent.hasChildren = true
    }
    list.sort((a, b) => (a.depth === b.depth ? a.id.localeCompare(b.id) : a.depth - b.depth))

    return { rev: this.treeRev, nodes: list, edges, truncatedGroups }
  }

  /** 阶梯比较一个桶，返回其中的全部重复组（可能多于一个） */
  private async resolveBucket(
    bucket: FileEntry[],
    tempPaths: Map<string, string>
  ): Promise<DupeGroup[]> {
    // 纯压缩包条目桶：先用元信息里免费获得的 crc32 初筛——crc 互异的条目对
    // 不可能内容相同，直接淘汰；混有普通文件时 crc 无从比对，整体走完整阶梯
    let sets: FileEntry[][] = [bucket]
    const hasNormal = bucket.some((e) => e.containerPath === null)
    const allCrcKnown = bucket.every((e) => e.crc32 !== null)
    if (!hasNormal && allCrcKnown) {
      const byCrc = new Map<number, FileEntry[]>()
      for (const e of bucket) {
        const arr = byCrc.get(e.crc32 as number)
        if (arr) arr.push(e)
        else byCrc.set(e.crc32 as number, [e])
      }
      sets = [...byCrc.values()].filter((g) => g.length >= 2)
    }

    const result: DupeGroup[] = []
    for (const set of sets) {
      if (this.canceled) break
      for (const headGroup of await this.partition(set, 'headmd5', tempPaths)) {
        if (this.canceled) break
        for (const fullGroup of await this.partition(headGroup, 'fullmd5', tempPaths)) {
          const md5 = fullGroup[0].fullmd5
          if (md5 === null) continue
          result.push({ key: `md5:${md5}`, size: fullGroup[0].size, entries: fullGroup })
        }
      }
    }
    return result
  }

  /**
   * 按指定哈希槽位把条目分堆，成员数 ≥ 2 的堆才返回。
   * 普通文件直接哈希；压缩包条目解压到内存后哈希，均提交给 worker 线程池；
   * 失败（null）的条目视为独立文件，不参与分组。
   */
  private async partition(
    entries: FileEntry[],
    slot: HashSlot,
    tempPaths: Map<string, string>
  ): Promise<FileEntry[][]> {
    const pool = getHashPool()
    // 小文件优化：size ≤ 1MB 时 headMD5 读的已是整个文件，直接复用为 fullMD5，免二次读盘
    if (slot === 'fullmd5') {
      for (const e of entries) {
        if (e.fullmd5 === null && e.headmd5 !== null && e.size <= HEAD_BYTES) {
          e.fullmd5 = e.headmd5
        }
      }
    }
    const pending = entries.filter((e) => e[slot] === null)
    const hashes = await pMap(pending, HASH_WORKERS, (e) => {
      // rar：已整卷解压到临时目录，直接按文件哈希（免二次解压）
      const temp = tempPaths.get(e.path)
      if (temp !== undefined) {
        return slot === 'headmd5' ? pool.md5Head(temp, HEAD_BYTES) : pool.md5Full(temp)
      }
      if (e.containerPath !== null && e.entryPath !== null && e.archiveType !== null) {
        // zip/7z：流式解压哈希
        return pool.archiveMd5(
          e.archiveType,
          e.containerPath,
          e.entryPath,
          slot === 'headmd5' ? HEAD_BYTES : undefined
        )
      }
      return slot === 'headmd5' ? pool.md5Head(e.path, HEAD_BYTES) : pool.md5Full(e.path)
    })
    for (let i = 0; i < pending.length; i++) {
      const h = hashes[i]
      const e = pending[i]
      if (h === null) {
        this.errors++
        continue
      }
      e[slot] = h
      this.bytesHashed += slot === 'headmd5' ? Math.min(e.size, HEAD_BYTES) : e.size
    }

    const groups = new Map<string, FileEntry[]>()
    for (const e of entries) {
      const h = e[slot]
      if (h === null) continue
      const arr = groups.get(h)
      if (arr) arr.push(e)
      else groups.set(h, [e])
    }
    return [...groups.values()].filter((g) => g.length >= 2)
  }
}
