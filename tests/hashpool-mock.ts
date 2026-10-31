// hashPool.ts 的 mock：哈希由 fixture 中的内容键确定性生成（同内容同摘要），
// 免去真实 worker 线程。测试通过 setContent(path, { head, full }) 定义内容等价类。
import { createHash } from 'node:crypto'

export interface MockContent {
  head: string
  full?: string
}

const content = new Map<string, MockContent>()
let archiveMd5Calls = 0

const digest = (kind: string, key: string): string =>
  createHash('md5').update(kind + '|' + key).digest('hex')

export function setContent(path: string, c: MockContent): void {
  content.set(path.toLowerCase(), c)
}

export function setContentBulk(
  entries: Array<{ path: string; head: string; full?: string }>
): void {
  for (const e of entries) setContent(e.path, { head: e.head, full: e.full })
}

export function resetContent(): void {
  content.clear()
  archiveMd5Calls = 0
}

export function archiveMd5CallCount(): number {
  return archiveMd5Calls
}

function lookup(p: string): MockContent | undefined {
  return content.get(p.toLowerCase())
}

export const HASH_WORKERS = 4
export function closeHashPool(): void {}

export function getHashPool() {
  return {
    deniedCount: 0,
    resetDenied(): void {},
    async md5Head(p: string): Promise<string | null> {
      const c = lookup(p)
      return digest('head', c ? c.head : p)
    },
    async md5Full(p: string): Promise<string | null> {
      const c = lookup(p)
      return digest('full', c ? (c.full ?? c.head) : p)
    },
    async archiveMd5(
      _type: string,
      container: string,
      entry: string
    ): Promise<string | null> {
      archiveMd5Calls++
      const c = lookup(container + '::' + entry)
      const key = c ? c.head : container + '::' + entry
      return digest('archive', key)
    },
    async archiveList(): Promise<never[]> {
      return []
    },
    async rarExtract(): Promise<boolean> {
      return true
    }
  }
}
