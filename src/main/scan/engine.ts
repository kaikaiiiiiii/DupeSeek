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
  ScanTreeNode
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

/** 目录聚合记录：枚举时登记，体积/重复沿祖先链累加 */
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
 * 单会话扫描引擎：枚举 → L0 分组（文件名+大小）→ headMD5（前 1MB）→ fullMD5。
 * 重复组增量回流；全程协作式取消。哈希在主进程异步执行，首版不做 worker 线程。
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
  private rootParents = new Set<string>()
  private denied = 0
  private archiveTempRoots: string[] = []

  constructor(broadcaster: Broadcaster) {
    this.broadcaster = broadcaster
  }

  isRunning(): boolean {
    return this.running
  }

  stop(): void {
    if (this.running) this.canceled = true
  }

  async start(settings: ScanSettings): Promise<string> {
    if (this.running) throw new Error('已有扫描任务在进行中')
    if (settings.targets.length === 0) throw new Error('请先添加扫描目标')

    this.running = true
    this.canceled = false
    this.errors = 0
    this.found = 0
    this.processed = 0
    this.bytesHashed = 0
    this.denied = 0
    getHashPool().resetDenied()
    this.cleanupArchiveTemps()
    this.dirs = new Map()
    // 体积归集的停点：目标目录的父目录（大小只归到目标根为止）
    this.rootParents = new Set(settings.targets.map((t) => path.dirname(t).toLowerCase()))
    this.sessionId = randomUUID()
    const sessionId = this.sessionId
    const startedAt = Date.now()

    try {
      const entries = await this.listPhase(settings)
      const { count, wasted } = await this.hashPhase(settings, entries)
      const summary: ScanSummary = {
        sessionId,
        canceled: this.canceled,
        filesFound: entries.length,
        dupeGroups: count,
        wastedBytes: wasted,
        durationMs: Date.now() - startedAt,
        errors: this.errors,
        denied: this.denied + getHashPool().deniedCount,
        tree: this.buildTree()
      }
      this.broadcaster('scan:done', summary)
      return sessionId
    } finally {
      this.running = false
      this.canceled = false
    }
  }

  private async listPhase(settings: ScanSettings): Promise<FileEntry[]> {
    this.phase = 'listing'
    const entries: FileEntry[] = []
    const lastPath = { value: '' }
    const ctx = {
      settings,
      canceled: (): boolean => this.canceled,
      onEntry: (e: FileEntry): void => {
        entries.push(e)
        this.addBytes(e.path, e.size, false)
        lastPath.value = e.path
      },
      onDir: (p: string): void => {
        this.recordDir(p)
        lastPath.value = p
      },
      onError: (_p: string, err: unknown): void => {
        this.errors++
        if (isPermissionError(err)) this.denied++
      }
    }

    // 优先 Everything 枚举（可在设置中关闭）；未安装 / 未运行 / 单目标失败时逐目标回退 fs walk
    const lister = settings.useEverything ? await createEverythingLister() : null
    console.info(
      `[scan] 枚举通道：${lister ? 'Everything (es.exe)' : settings.useEverything ? 'fs walk（Everything 不可用）' : 'fs walk（已在设置中禁用 Everything）'}`
    )

    const tick = setInterval(() => {
      this.found = entries.length
      this.emitProgress(lastPath.value)
    }, PROGRESS_MS)
    try {
      for (const target of settings.targets) {
        if (this.canceled) break
        let handled = false
        if (lister) {
          try {
            handled = await this.listViaEverything(lister, target, settings, entries, lastPath)
          } catch (err) {
            console.warn(`[scan] Everything 枚举失败，回退 walk：${target}`, err)
          }
        }
        if (!handled) await walkTargets([target], ctx)
      }
      await this.listArchiveEntries(settings, entries, lastPath)
    } finally {
      clearInterval(tick)
    }
    return entries
  }

  /** 枚举扫描到的压缩包内条目；容器本身也是普通候选，条目按 `容器::包内路径` 建条 */
  private async listArchiveEntries(
    settings: ScanSettings,
    entries: FileEntry[],
    lastPath: { value: string }
  ): Promise<void> {
    if (!settings.scanArchives) return
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
        // 压缩包即特殊目录：合成根挂在容器所在的真实目录下，包内子目录逐级挂在其下
        const root = c.path + '::'
        this.recordDirAt(root, path.dirname(c.path), path.basename(c.path))
        for (const m of metas) {
          const segs = m.entryPath.split(/[\\/]/)
          let p = root
          for (let i = 0; i < segs.length - 1; i++) {
            const next = p + '/' + segs[i]
            this.recordDirAt(next, p, segs[i])
            p = next
          }
          this.addArchiveBytes(c.path, m.entryPath, m.size, false)
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
   * RAR 批量解压 pass：收集多成员桶内的 rar 条目，按容器分批解到临时目录，
   * 建立 条目 path → 临时文件 的映射供哈希阶段使用。
   * 未成功解出的条目保持无映射（哈希阶段按独立文件跳过）。
   */
  private async extractRarCandidates(
    settings: ScanSettings,
    buckets: Map<string, FileEntry[]>
  ): Promise<Map<string, string>> {
    const tempPaths = new Map<string, string>()
    if (!settings.scanArchives) return tempPaths

    const pool = getHashPool()
    const perArchive = new Map<string, Set<string>>()
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue
      for (const e of bucket) {
        if (e.archiveType === 'rar' && e.containerPath !== null && e.entryPath !== null) {
          const set = perArchive.get(e.containerPath)
          if (set) set.add(e.entryPath)
          else perArchive.set(e.containerPath, new Set([e.entryPath]))
        }
      }
    }
    if (perArchive.size === 0) return tempPaths

    await pMap(
      [...perArchive.entries()],
      Math.min(2, perArchive.size),
      async ([container, entries]) => {
        if (this.canceled) return
        const tempRoot = path.join(
          os.tmpdir(),
          'dupeseek-rar-' +
            createHash('md5').update(container.toLowerCase()).digest('hex').slice(0, 12)
        )
        this.archiveTempRoots.push(tempRoot)
        const entryList = [...entries]
        const ok = await pool.rarExtract('rar', container, entryList, tempRoot)
        if (!ok) return
        for (const rel of entryList) {
          const temp = path.join(tempRoot, rel)
          try {
            if (fs.statSync(temp).isFile()) tempPaths.set(`${container}::${rel}`, temp)
          } catch {
            // 加密/损坏条目解不出，哈希阶段按独立文件跳过
          }
        }
      }
    )
    return tempPaths
  }

  private cleanupArchiveTemps(): void {
    for (const dir of this.archiveTempRoots) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    this.archiveTempRoots = []
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
    this.recordDir(target)

    // reparse point 清单（/aL 一次查询）：junction/符号链接目录 + 云占位等。
    // 内存前缀比较替代逐目录 lstat——目录数量大时显著更快，且不产生磁盘 I/O。
    const reparseSet = new Set(res.reparse.map((p) => p.toLowerCase()))
    const isReparse = (p: string): boolean => reparseSet.has(p.toLowerCase())
    // excludeJunction=false 时 junction 子树照常纳入（与 walk 通道语义一致）
    const skipReparse = settings.excludeJunction

    // 目录级排除：被排除目录的整棵子树都要剔除（Everything 返回顺序不定，先收集前缀再统一过滤）
    const excluded: string[] = []
    const dirOk: string[] = []
    for (const dir of res.dirs) {
      if (settingsExcludesDir(path.basename(dir), settings)) {
        excluded.push(dir)
        continue
      }
      // junction / 目录符号链接 / 云占位目录：reparse 清单命中即整棵剔除
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
    for (const dir of dirOk) {
      if (!isExcluded(dir)) this.recordDir(dir)
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
      this.addBytes(f.filename, f.size, false)
      lastPath.value = f.filename
    }
    return true
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
      denied: this.denied + getHashPool().deniedCount
    }
    this.broadcaster('scan:progress', progress)
  }

  private recordDir(dir: string): void {
    if (this.dirs.has(dir)) return
    this.dirs.set(dir, {
      parent: path.dirname(dir),
      name: path.basename(dir) || dir,
      size: 0,
      dup: 0
    })
  }

  /** 显式指定父节点的登记（用于 `容器::包内路径` 这类合成目录，dirname 不适用） */
  private recordDirAt(p: string, parent: string, name: string): void {
    if (this.dirs.has(p)) return
    this.dirs.set(p, { parent, name, size: 0, dup: 0 })
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

  /** 把字节数沿文件的祖先目录链累加到目标根为止 */
  private addBytes(filePath: string, bytes: number, dup: boolean): void {
    let p = path.dirname(filePath)
    for (;;) {
      const rec = this.dirs.get(p)
      if (!rec) break
      if (dup) rec.dup += bytes
      else rec.size += bytes
      if (this.rootParents.has(p.toLowerCase())) break
      const parent = path.dirname(p)
      if (parent === p) break
      p = parent
    }
  }

  /** 重复占用的归集口径：每组保留最早修改的一份，其余副本计入各自所在目录；
   *  压缩包内副本计入包内合成目录链 */
  private attributeDup(group: DupeGroup): void {
    const kept = group.entries.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
    for (const e of group.entries) {
      if (e.path === kept.path) continue
      if (e.containerPath !== null && e.entryPath !== null) {
        this.addArchiveBytes(e.containerPath, e.entryPath, e.size, true)
      } else {
        this.addBytes(e.path, e.size, true)
      }
    }
  }

  /** 由目录聚合记录构建体积树，子级按体积降序 */
  private buildTree(): ScanTreeNode[] {
    const nodes = new Map<string, ScanTreeNode>()
    for (const [p, rec] of this.dirs) {
      nodes.set(p, { name: rec.name, path: p, size: rec.size, dupWasted: rec.dup, children: [] })
    }
    const roots: ScanTreeNode[] = []
    for (const [p, rec] of this.dirs) {
      const node = nodes.get(p)
      if (!node) continue
      const parent = nodes.get(rec.parent)
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    const bySize = (a: ScanTreeNode, b: ScanTreeNode): number => b.size - a.size
    for (const node of nodes.values()) node.children.sort(bySize)
    roots.sort(bySize)
    return roots
  }

  private async hashPhase(
    settings: ScanSettings,
    entries: FileEntry[]
  ): Promise<{ count: number; wasted: number }> {
    this.phase = 'hashing'
    this.found = entries.length

    // L0：按 文件名+大小（或仅大小）分桶
    const buckets = new Map<string, FileEntry[]>()
    for (const e of entries) {
      const key = settings.ignoreName ? `s:${e.size}` : `n:${e.name}#s:${e.size}`
      const bucket = buckets.get(key)
      if (bucket) bucket.push(e)
      else buckets.set(key, [e])
    }

    // RAR 批量解压 pass：多成员桶内的 rar 条目先解到临时目录，
    // 之后的 head/full 哈希直接读临时文件（固实卷逐条目解压需重复解压公共前缀，
    // 实测单条 2s × 数千条会拖死整个哈希阶段）
    const tempPaths = await this.extractRarCandidates(settings, buckets)

    // 计数独立于冲刷缓冲：缓冲发出后即清零，总数必须另记
    let count = 0
    let wasted = 0
    const out: DupeGroup[] = []
    let lastFlush = Date.now()
    const flush = (): void => {
      if (out.length === 0) return
      this.broadcaster('scan:group', { sessionId: this.sessionId, groups: [...out] })
      out.length = 0
      lastFlush = Date.now()
    }

    for (const bucket of buckets.values()) {
      if (this.canceled) break
      this.processed += bucket.length

      if (bucket.length < 2) {
        this.emitProgress(bucket[0]?.path ?? '')
        continue
      }

      // 空文件内容必然相同，免哈希直接成组
      if (bucket[0].size === 0) {
        out.push({ key: `empty:${bucket[0].name}#${bucket.length}`, size: 0, entries: bucket })
        count++
      } else {
        for (const group of await this.resolveBucket(bucket, tempPaths)) {
          out.push(group)
          count++
          wasted += group.size * (group.entries.length - 1)
          this.attributeDup(group)
        }
      }
      this.emitProgress(bucket[0]?.path ?? '')
      if (out.length >= GROUP_FLUSH_COUNT || Date.now() - lastFlush >= GROUP_FLUSH_MS) flush()
    }

    this.phase = 'finalizing'
    flush()
    return { count, wasted }
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
      // rar：已批量解压到临时目录，直接按文件哈希（免二次解压）
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
