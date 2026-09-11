import { randomUUID } from 'crypto'
import type {
  DupeGroup,
  FileEntry,
  ScanProgress,
  ScanSettings,
  ScanSummary
} from '../../shared/types'
import { md5FullFile, md5HeadFile } from './hash'
import { walkTargets } from './walk'

const HEAD_BYTES = 1024 * 1024
const HASH_CONCURRENCY = 4
const GROUP_FLUSH_COUNT = 50
const GROUP_FLUSH_MS = 500
const PROGRESS_MS = 100

type Broadcaster = (channel: string, payload: unknown) => void

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
        errors: this.errors
      }
      this.broadcaster('scan:done', summary)
      return sessionId
    } finally {
      this.running = false
      this.canceled = false
    }
  }

  private listPhase(settings: ScanSettings): Promise<FileEntry[]> {
    this.phase = 'listing'
    const entries: FileEntry[] = []
    const lastPath = { value: '' }
    const ctx = {
      settings,
      canceled: (): boolean => this.canceled,
      onEntry: (e: FileEntry): void => {
        entries.push(e)
        lastPath.value = e.path
      },
      onDir: (p: string): void => {
        lastPath.value = p
      },
      onError: (): void => {
        this.errors++
      }
    }
    const tick = setInterval(() => {
      this.found = entries.length
      this.emitProgress(lastPath.value)
    }, PROGRESS_MS)
    return walkTargets(settings.targets, ctx)
      .finally(() => clearInterval(tick))
      .then(() => entries)
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
   * 计算失败（null）的条目视为独立文件，不参与分组。
   */
  private async partition(entries: FileEntry[], slot: HashSlot): Promise<FileEntry[][]> {
    const pending = entries.filter((e) => e[slot] === null)
    const hashes = await pMap(pending, HASH_CONCURRENCY, (e) =>
      slot === 'headmd5' ? md5HeadFile(e.path, HEAD_BYTES) : md5FullFile(e.path)
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
