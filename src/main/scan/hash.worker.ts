import { parentPort } from 'worker_threads'
import { md5FullFile, md5HeadFile } from './hash'
import { isPermissionError } from '../../shared/errors'
import { extractRarEntries, hashArchiveEntry, listArchive } from './archives'
import type { ArchiveType } from '../../shared/types'

interface HashJob {
  id: number
  kind: 'md5-head' | 'md5-full' | 'archive-list' | 'archive-head' | 'archive-full' | 'rar-extract'
  /** md5-head / md5-full */
  path?: string
  cap?: number
  /** archive-* 任务 */
  archiveType?: ArchiveType
  archivePath?: string
  entryPath?: string
  entries?: string[]
  tempRoot?: string
}

for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (): void => undefined)
}

/** 单 worker 一次只处理一个任务，由 HashPool 调度；失败以 null 结算 */
parentPort?.on('message', (job: HashJob) => {
  void (async () => {
    let value: unknown = null
    let denied = false
    try {
      switch (job.kind) {
        case 'md5-head':
          value = md5HeadFile(job.path as string, job.cap ?? 1024 * 1024)
          break
        case 'md5-full':
          value = md5FullFile(job.path as string)
          break
        case 'archive-list':
          value = await listArchive(job.archivePath as string, job.archiveType as ArchiveType)
          break
        case 'rar-extract':
          value = await extractRarEntries(
            job.archivePath as string,
            job.entries as string[],
            job.tempRoot as string,
            null
          )
          break
        case 'archive-head':
        case 'archive-full':
          value = await hashArchiveEntry(
            job.archivePath as string,
            job.entryPath as string,
            job.archiveType as ArchiveType,
            job.kind === 'archive-head' ? job.cap : undefined
          )
          break
      }
    } catch (err) {
      console.error('[hash-worker] 任务失败', job.kind, err)
      value = null
      denied = isPermissionError(err)
    }
    parentPort?.postMessage({ id: job.id, value, denied })
  })()
})
