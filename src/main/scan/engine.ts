import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  ArchiveType,
  DupeGroup,
  FileEntry,
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
import { extAllowed, extOf, settingsExcludesDir, walkTargets } from './walk'

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

  // —— 持久会话状态 ——
  private entries = new Map<string, FileEntry>()
  private owners = new Map<string, string>()
  private coveredTargets = new Set<string>()
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

  /** 目标列表同步：新增目标增量扫描，移除目标纯内存清理 */
  async syncTargets(settings: ScanSettings): Promise<ScanSummary> {
    if (this.running) throw new Error('已有扫描任务在进行中')
    if (settings.targets.length === 0) throw new Error('请先添加扫描目标')

    const requested = new Set(settings.targets)
    const addList = settings.targets.filter((t) => !this.coveredTargets.has(t))
    const removeList = [...this.coveredTargets].filter((t) => !requested.has(t))

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
    const sessionId = this.sessionId
    const startedAt = Date.now()

    try {
      // 移除：纯内存清理（条目重归属/删除、组剔除、进度），零磁盘 I/O
      for (const t of removeList) this.removeTarget(t)

      // 新增：枚举 → 触碰桶比较（只有 L0 同桶的新条目触发哈希）
      if (addList.length > 0) {
        const lister = settings.useEverything ? await createEverythingLister() : null
        console.info(
          `[scan] 枚举通道（${addList.length} 个新增目标）：${lister ? 'Everything (es.exe)' : settings.useEverything ? 'fs walk（Everything 不可用）' : 'fs walk（已在设置中禁用 Everything）'}`
        )
        await this.enumerateAdds(addList, settings, lister)

        if (!this.canceled) {
          this.phase = 'hashing'
          this.processed = 0
          await this.hashTouched(settings, addList)
        }
      }

      // 汇总：体积树按当前全量条目重算，组数为会话累计值
      this.phase = 'finalizing'
      this.rebuildDirs()
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
    this.entries.clear()
    this.owners.clear()
    this.coveredTargets.clear()
    this.knownGroups.clear()
    this.foundPerTarget.clear()
    this.processedPerTarget.clear()
    return this.syncTargets(settings)
  }

  /** 条目主键：Windows 路径大小写不敏感按小写归一，其余平台原样 */
  private keyOf(p: string): string {
    return process.platform === 'win32' ? p.toLowerCase() : p
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

  /** 移除目标：其条目若仍被剩余目标覆盖则改归属，否则删除并从组中剔除 */
  private removeTarget(target: string): void {
    this.coveredTargets.delete(target)
    const remaining = [...this.coveredTargets]
    const deleted = new Set<string>()
    for (const [key, owner] of this.owners) {
      if (owner !== target) continue
      const cover = remaining.find((t) => {
        const lt = this.keyOf(t)
        return key === lt || key.startsWith(lt + '\\')
      })
      if (cover) this.owners.set(key, cover)
      else {
        this.entries.delete(key)
        this.owners.delete(key)
        deleted.add(key)
      }
    }
    this.foundPerTarget.delete(target)
    this.processedPerTarget.delete(target)
    this.purgeGroupsByPaths(deleted)
    // 目录聚合/子级索引按存活条目全量重建（增量反扣代价高，一次性重算更稳）
    this.rebuildDirs()
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
   */
  private async hashTouched(settings: ScanSettings, addList: string[]): Promise<void> {
    const touched = new Set<string>()
    const addSet = new Set(addList)
    // 触碰桶 = 新增目标所拥有条目的 L0 键（嵌套覆盖的既有条目不重触发哈希）
    for (const [key, e] of this.entries) {
      const owner = this.owners.get(key)
      if (owner !== undefined && addSet.has(owner)) touched.add(this.l0Key(e, settings))
    }

    // 全量条目分桶，只保留被触碰的桶
    const buckets = new Map<string, FileEntry[]>()
    for (const e of this.entries.values()) {
      const key = this.l0Key(e, settings)
      if (!touched.has(key)) continue
      const b = buckets.get(key)
      if (b) b.push(e)
      else buckets.set(key, [e])
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

  /** 组确认后把重复占用计入渐进树（哈希期增量归集，与 rebuildDirs 第3步同语义） */
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
    for (const dir of res.dirs) {
      if (settingsExcludesDir(path.basename(dir), settings)) {
        excluded.push(dir)
        continue
      }
      if (isReparse(dir) && skipReparse) {
        excluded.push(dir)
        continue
      }
      dirOk.push(dir)
    }
    const isExcluded = (p: string): boolean => {
      const lower = p.toLowerCase()
      return excluded.some((d) => lower.startsWith(`${d.toLowerCase()}\\`))
    }

    for (const f of res.files) {
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
    const stop = target.toLowerCase()
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
        const stop = (this.owners.get(this.keyOf(e.path)) ?? '').toLowerCase()
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
    const stop = targetRoot.toLowerCase()
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
    let totalSize = 0
    for (const e of this.entries.values()) totalSize += e.size
    let totalDup = 0
    for (const g of this.knownGroups.values()) {
      if (g.entries.length >= 2) totalDup += g.size * (g.entries.length - 1)
    }
    return { totalSize, totalDup, dirCount: this.dirs.size }
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
