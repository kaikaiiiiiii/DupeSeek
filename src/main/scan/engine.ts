import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  DupeGroup,
  FileEntry,
  ScanProgress,
  ScanSettings,
  ScanSummary,
  ScanTreeNode
} from '../../shared/types'
import { createEverythingLister, type EverythingLister } from './everything'
import { getHashPool, HASH_WORKERS } from './hashPool'
import { extAllowed, extOf, settingsExcludesDir, walkTargets } from './walk'

const HEAD_BYTES = 1024 * 1024
const GROUP_FLUSH_COUNT = 50
const GROUP_FLUSH_MS = 500
const PROGRESS_MS = 100

type Broadcaster = (channel: string, payload: unknown) => void

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
      onError: (): void => {
        this.errors++
      }
    }

    // 优先 Everything 枚举；未安装 / 未运行 / 单目标失败时逐目标回退 fs walk
    const lister = await createEverythingLister()
    console.info(`[scan] 枚举通道：${lister ? 'Everything (es.exe)' : 'fs walk'}`)

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
    } finally {
      clearInterval(tick)
    }
    return entries
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

    // 目录级排除：被排除目录的整棵子树都要剔除（Everything 返回顺序不定，先收集前缀再统一过滤）
    const excluded: string[] = []
    const dirOk: string[] = []
    for (const dir of res.dirs) {
      if (settingsExcludesDir(path.basename(dir), settings)) excluded.push(dir)
      else dirOk.push(dir)
    }
    const isExcluded = (p: string): boolean => {
      const lower = p.toLowerCase()
      return excluded.some((d) => lower.startsWith(`${d.toLowerCase()}\\`))
    }
    for (const dir of dirOk) {
      if (!isExcluded(dir)) this.recordDir(dir)
    }

    for (const f of res.files) {
      if (isExcluded(f.filename)) continue
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
      percent: this.found > 0 ? Math.min(100, (this.processed / this.found) * 100) : 0
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

  /** 重复占用的归集口径：每组保留最早修改的一份，其余副本计入各自所在目录 */
  private attributeDup(group: DupeGroup): void {
    const kept = group.entries.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
    for (const e of group.entries) {
      if (e.path !== kept.path) this.addBytes(e.path, e.size, true)
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
        for (const group of await this.resolveBucket(bucket)) {
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
  private async resolveBucket(bucket: FileEntry[]): Promise<DupeGroup[]> {
    const headGroups = await this.partition(bucket, 'headmd5')
    const result: DupeGroup[] = []
    for (const headGroup of headGroups) {
      if (this.canceled) break
      for (const fullGroup of await this.partition(headGroup, 'fullmd5')) {
        const md5 = fullGroup[0].fullmd5
        if (md5 === null) continue
        result.push({ key: `md5:${md5}`, size: fullGroup[0].size, entries: fullGroup })
      }
    }
    return result
  }

  /**
   * 按指定哈希槽位把条目分堆，成员数 ≥ 2 的堆才返回。
   * 哈希计算提交给 worker 线程池；失败（null）的条目视为独立文件，不参与分组。
   */
  private async partition(entries: FileEntry[], slot: HashSlot): Promise<FileEntry[][]> {
    const pool = getHashPool()
    const pending = entries.filter((e) => e[slot] === null)
    const hashes = await pMap(pending, HASH_WORKERS, (e) =>
      slot === 'headmd5' ? pool.md5Head(e.path, HEAD_BYTES) : pool.md5Full(e.path)
    )
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
