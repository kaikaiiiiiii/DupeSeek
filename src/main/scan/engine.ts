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
  ScanTreeNode,
  TreeNodeFile
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
 * - targetEntries：每个目标的条目清单（哈希记忆化挂在条目对象上，
 *   已算过的 headMD5/fullMD5 不再重算、不重复读盘）；
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
  private lastTreeAt = 0

  // —— 持久会话状态 ——
  private targetEntries = new Map<string, FileEntry[]>()
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
    const addList = settings.targets.filter((t) => !this.targetEntries.has(t))
    const removeList = [...this.targetEntries.keys()].filter((t) => !requested.has(t))

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
      // 移除：纯内存清理（条目、组、进度），零磁盘 I/O
      for (const t of removeList) {
        this.targetEntries.delete(t)
        this.foundPerTarget.delete(t)
        this.processedPerTarget.delete(t)
      }
      this.purgeGroupsByTargets(removeList)
      // 渐进树基线：先按（清理后的）既有条目重建一次并立刻推送，
      // 让"移除目标"的体积变化即时可见
      this.lastTreeAt = 0
      this.emitProgressiveTree(true)

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
      const tree = this.buildTree()
      let wastedBytes = 0
      for (const g of this.knownGroups.values()) {
        wastedBytes += g.size * (g.entries.length - 1)
      }
      let totalEntries = 0
      for (const list of this.targetEntries.values()) totalEntries += list.length
      const summary: ScanSummary = {
        sessionId,
        canceled: this.canceled,
        filesFound: totalEntries,
        dupeGroups: this.knownGroups.size,
        wastedBytes,
        durationMs: Date.now() - startedAt,
        errors: this.errors,
        denied: this.denied + getHashPool().deniedCount,
        tree
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
    this.targetEntries.clear()
    this.knownGroups.clear()
    this.foundPerTarget.clear()
    this.processedPerTarget.clear()
    return this.syncTargets(settings)
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
      const entries: FileEntry[] = []
      const ctx = {
        settings,
        canceled: (): boolean => this.canceled,
        onEntry: (e: FileEntry): void => {
          entries.push(e)
          this.found++
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
          handled = await this.listViaEverything(lister, target, settings, entries, lastPath)
        } catch (err) {
          console.warn(`[scan] Everything 枚举失败，回退 walk：${target}`, err)
        }
      }
      if (!handled) await walkTargets([target], ctx)

      // 压缩包条目枚举（容器来自本目标的条目）
      if (settings.scanArchives) {
        await this.listArchiveEntries(settings, entries, lastPath)
      }

      this.targetEntries.set(target, entries)
      this.foundPerTarget.set(target, entries.length)
    }
  }

  /** 枚举扫描到的压缩包内条目；容器本身也是普通候选，条目按 `容器::包内路径` 建条 */
  private async listArchiveEntries(
    settings: ScanSettings,
    entries: FileEntry[],
    lastPath: { value: string }
  ): Promise<void> {
    const pool = getHashPool()
    const containers = entries.filter(
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
            entries.push(entry)
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
    for (const t of addList) {
      for (const e of this.targetEntries.get(t) ?? []) touched.add(this.l0Key(e, settings))
    }

    // 全量条目分桶，只保留被触碰的桶
    const buckets = new Map<string, FileEntry[]>()
    for (const list of this.targetEntries.values()) {
      for (const e of list) {
        const key = this.l0Key(e, settings)
        if (!touched.has(key)) continue
        const b = buckets.get(key)
        if (b) b.push(e)
        else buckets.set(key, [e])
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
        const t = this.targetOf(e, settings.targets)
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
        this.attributeDupToDirs(group, settings.targets)
        out.push(group)
      } else {
        for (const group of await this.resolveBucket(bucket, tempPaths)) {
          this.knownGroups.set(group.key, group)
          this.attributeDupToDirs(group, settings.targets)
          out.push(group)
        }
      }
      this.emitProgress(bucket[0]?.path ?? '')
      if (out.length >= GROUP_FLUSH_COUNT || Date.now() - lastFlush >= GROUP_FLUSH_MS) flush()
    }
    flush()
  }

  /** 组确认后把重复占用计入渐进树（哈希期增量归集，与 rebuildDirs 第3步同语义） */
  private attributeDupToDirs(group: DupeGroup, targets: string[]): void {
    const kept = group.entries.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
    for (const e of group.entries) {
      if (e.path === kept.path) continue
      if (e.containerPath !== null && e.entryPath !== null) {
        this.addArchiveBytes(e.containerPath, e.entryPath, e.size, true)
      } else {
        const t = this.targetOf(e, targets)
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
      for (const list of this.targetEntries.values()) {
        for (const e of list) {
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
    }
    return tempPaths
  }

  /** 用 Everything 枚举一个目录目标；返回 false 表示走不了该通道（如目标是文件） */
  private async listViaEverything(
    lister: EverythingLister,
    target: string,
    settings: ScanSettings,
    entries: FileEntry[],
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
      entries.push(entry)
      // 渐进体积树：登记祖先目录并累加体积（与 rebuildDirs 同语义的增量版）
      this.addEntryToDirs(entry, target)
      lastPath.value = f.filename
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
    }
  }

  /** 渐进体积树：节流 1s 重建一次（纯内存操作），挂在 progress 事件回流；
   *  force 跳过节流立即推送（如移除目标后的基线） */
  private emitProgressiveTree(force = false): ScanTreeNode[] | undefined {
    const now = Date.now()
    if (!force && now - this.lastTreeAt < 1000) return undefined
    this.lastTreeAt = now
    return this.buildTreeFrom(this.dirs)
  }

  private emitProgress(currentPath: string): void {
    const now = Date.now()
    if (now - this.lastProgressAt < PROGRESS_MS) return
    this.lastProgressAt = now
    const tree = this.emitProgressiveTree()
    const progress: ScanProgress = {
      sessionId: this.sessionId,
      phase: this.phase,
      filesFound: this.found,
      filesProcessed: this.processed,
      bytesHashed: this.bytesHashed,
      currentPath,
      percent: this.found > 0 ? Math.min(100, (this.processed / this.found) * 100) : 0,
      denied: this.denied + getHashPool().deniedCount,
      targets: this.progressTargets.map((t) => {
        const total = this.foundPerTarget.get(t) ?? 0
        const processed = this.processedPerTarget.get(t) ?? 0
        return { path: t, percent: total > 0 ? Math.min(100, (processed / total) * 100) : 0 }
      }),
      ...(tree !== undefined ? { tree } : {})
    }
    this.broadcaster('scan:progress', progress)
  }

  /** 条目归属的扫描目标（最长前缀；包内条目按容器路径归属） */
  private targetOf(entry: FileEntry, targets: string[]): string | null {
    const root = (entry.containerPath ?? entry.path).toLowerCase()
    let best: string | null = null
    for (const t of targets) {
      const lt = t.toLowerCase()
      if (root === lt || root.startsWith(lt + '\\')) {
        if (best === null || lt.length > best.length) best = t
      }
    }
    return best
  }

  /** 移除目标后清理 knownGroups：剔除其成员，不足 2 个的组解散 */
  private purgeGroupsByTargets(targets: string[]): void {
    if (targets.length === 0) return
    for (const [key, g] of this.knownGroups) {
      const kept = g.entries.filter((e) => {
        const root = (e.containerPath ?? e.path).toLowerCase()
        return !targets.some((t) => {
          const lt = t.toLowerCase()
          return root === lt || root.startsWith(lt + '\\')
        })
      })
      if (kept.length === g.entries.length) continue
      if (kept.length >= 2) this.knownGroups.set(key, { ...g, entries: kept })
      else this.knownGroups.delete(key)
    }
  }

  /**
   * 体积树重算：目录节点与聚合全部由当前条目集推导（无增量残账）。
   * 三步：登记节点 → 体积聚合 → 重复占用归集（每组保留最早修改的一份）。
   */
  private rebuildDirs(): void {
    this.dirs = new Map()

    // 1) 登记节点：目标根、真实祖先目录、压缩包合成目录链
    for (const [target, list] of this.targetEntries) {
      this.recordDir(target)
      const stop = target.toLowerCase()
      for (const e of list) {
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
          let p = path.dirname(e.path)
          for (;;) {
            const lp = p.toLowerCase()
            if (lp === stop) break
            if (!lp.startsWith(stop + '\\')) break
            this.recordDir(p)
            const parent = path.dirname(p)
            if (parent === p) break
            p = parent
          }
        }
      }
    }

    // 2) 体积聚合
    for (const [target, list] of this.targetEntries) {
      for (const e of list) {
        if (e.containerPath !== null && e.entryPath !== null) {
          this.addArchiveBytes(e.containerPath, e.entryPath, e.size, false)
        } else {
          this.addBytes(e.path, e.size, false, target)
        }
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
          const target = this.targetOf(e, [...this.targetEntries.keys()])
          this.addBytes(e.path, e.size, true, target ?? '')
        }
      }
    }
  }

  /** 显式指定父节点的登记（用于 `容器::包内路径` 这类合成目录，dirname 不适用） */
  private recordDirAt(p: string, parent: string, name: string): void {
    if (this.dirs.has(p)) return
    this.dirs.set(p, { parent, name, size: 0, dup: 0 })
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

  /** 由目录聚合记录构建体积树，子级按体积降序 */
  private buildTree(): ScanTreeNode[] {
    return this.buildTreeFrom(this.dirs)
  }

  private buildTreeFrom(dirs: Map<string, DirAgg>): ScanTreeNode[] {
    const nodes = new Map<string, ScanTreeNode>()
    for (const [p, rec] of dirs) {
      nodes.set(p, {
        name: rec.name,
        path: p,
        size: rec.size,
        dupWasted: rec.dup,
        children: [],
        files: []
      })
    }
    const roots: ScanTreeNode[] = []
    for (const [p, rec] of dirs) {
      const node = nodes.get(p)
      if (!node) continue
      const parent = nodes.get(rec.parent)
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    // 真实文件挂到父目录节点（压缩包内条目不挂，其体积已走合成目录链）；
    // 文件级重复占用 = 该文件在各重复组中作为非保留副本的体积之和
    const wastedByPath = new Map<string, number>()
    for (const g of this.knownGroups.values()) {
      if (g.entries.length < 2) continue
      const kept = g.entries.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
      for (const e of g.entries) {
        if (e.path === kept.path || e.containerPath !== null) continue
        wastedByPath.set(e.path, (wastedByPath.get(e.path) ?? 0) + e.size)
      }
    }
    const fileGroups = new Map<string, TreeNodeFile[]>()
    for (const list of this.targetEntries.values()) {
      for (const e of list) {
        if (e.containerPath !== null) continue
        const item: TreeNodeFile = {
          path: e.path,
          name: e.name,
          size: e.size,
          dupWasted: wastedByPath.get(e.path) ?? 0
        }
        const parent = path.dirname(e.path)
        const arr = fileGroups.get(parent)
        if (arr) arr.push(item)
        else fileGroups.set(parent, [item])
      }
    }
    for (const [p, arr] of fileGroups) {
      const node = nodes.get(p)
      if (node) node.files = arr.sort((a, b) => b.size - a.size)
    }
    const bySize = (a: ScanTreeNode, b: ScanTreeNode): number => b.size - a.size
    for (const node of nodes.values()) node.children.sort(bySize)
    roots.sort(bySize)
    return roots
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
