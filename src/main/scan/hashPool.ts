import os from 'os'
import { Worker } from 'worker_threads'
import CreateHashWorker from './hash.worker?nodeWorker'
import type { ArchiveEntryMeta } from './archives'

/** 默认 worker 数：留出主进程与 I/O 余量 */
export const HASH_WORKERS = Math.max(2, Math.min(8, os.availableParallelism() - 1))

export type HashJobKind = 'md5-head' | 'md5-full' | 'archive-list' | 'archive-head' | 'archive-full'

interface HashJob {
  kind: HashJobKind
  path?: string
  cap?: number
  archiveType?: 'zip' | '7z' | 'rar'
  archivePath?: string
  entryPath?: string
}

interface QueueItem {
  job: HashJob
  resolve: (value: unknown) => void
}

/**
 * 固定大小的 md5 计算线程池：哈希的 CPU 开销不再阻塞主进程事件循环。
 * worker 意外退出时自动重建，其在途任务按读取失败（null）结算。
 */
export class HashPool {
  private closed = false
  private workers: Worker[] = []
  private idle: Worker[] = []
  private busy = new Set<Worker>()
  private pending = new Map<Worker, Map<number, (value: unknown) => void>>()
  private queue: QueueItem[] = []
  private nextId = 1

  constructor(size: number) {
    for (let i = 0; i < size; i++) this.spawn()
  }

  md5Head(path: string, cap: number): Promise<string | null> {
    return this.run({ kind: 'md5-head', path, cap }) as Promise<string | null>
  }

  md5Full(path: string): Promise<string | null> {
    return this.run({ kind: 'md5-full', path }) as Promise<string | null>
  }

  /** 读取压缩包元信息条目列表；失败返回 null */
  archiveList(
    archiveType: 'zip' | '7z' | 'rar',
    archivePath: string
  ): Promise<ArchiveEntryMeta[] | null> {
    return this.run({ kind: 'archive-list', archiveType, archivePath }) as Promise<
      ArchiveEntryMeta[] | null
    >
  }

  /** 解压条目并哈希（cap 限制读取字节数）；失败返回 null */
  archiveMd5(
    archiveType: 'zip' | '7z' | 'rar',
    archivePath: string,
    entryPath: string,
    cap?: number
  ): Promise<string | null> {
    return this.run({
      kind: cap === undefined ? 'archive-full' : 'archive-head',
      archiveType,
      archivePath,
      entryPath,
      cap
    }) as Promise<string | null>
  }

  close(): void {
    this.closed = true
    for (const item of this.queue) item.resolve(null)
    this.queue = []
    for (const w of this.workers) {
      this.pending.delete(w)
      void w.terminate()
    }
    this.workers = []
    this.idle = []
    this.busy.clear()
  }

  private run(job: HashJob): Promise<unknown> {
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.queue.push({ job, resolve })
      this.dispatch()
    })
  }

  private spawn(): void {
    const w = CreateHashWorker({})
    this.pending.set(w, new Map())
    w.on('message', (msg: { id: number; value: unknown }) => {
      const pend = this.pending.get(w)
      const resolve = pend?.get(msg.id)
      if (pend && resolve) {
        pend.delete(msg.id)
        resolve(msg.value)
      }
      this.busy.delete(w)
      this.idle.push(w)
      this.dispatch()
    })
    w.on('error', () => this.reap(w))
    w.on('exit', () => this.reap(w))
    this.workers.push(w)
    this.idle.push(w)
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop() as Worker
      const item = this.queue.shift() as QueueItem
      const id = this.nextId++
      this.pending.get(w)?.set(id, item.resolve)
      this.busy.add(w)
      w.postMessage({ id, ...item.job })
    }
  }

  private reap(w: Worker): void {
    if (this.closed) return
    const pend = this.pending.get(w)
    if (pend) {
      for (const resolve of pend.values()) resolve(null)
      this.pending.delete(w)
    }
    this.busy.delete(w)
    this.idle = this.idle.filter((x) => x !== w)
    this.workers = this.workers.filter((x) => x !== w)
    this.spawn()
    this.dispatch()
  }
}

let shared: HashPool | null = null

/** 池为进程级单例，扫描会话间复用；应用退出时由 will-quit 关闭 */
export function getHashPool(): HashPool {
  if (!shared) shared = new HashPool(HASH_WORKERS)
  return shared
}

export function closeHashPool(): void {
  shared?.close()
  shared = null
}
