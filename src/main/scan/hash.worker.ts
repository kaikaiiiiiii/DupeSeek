import { parentPort } from 'worker_threads'
import { md5FullFile, md5HeadFile } from './hash'

interface HashJob {
  id: number
  kind: 'head' | 'full'
  path: string
  cap?: number
}

/** 单 worker 一次只处理一个任务，由 HashPool 调度；读取失败返回 null */
parentPort?.on('message', (job: HashJob) => {
  const run =
    job.kind === 'head' ? md5HeadFile(job.path, job.cap ?? 1024 * 1024) : md5FullFile(job.path)
  void run.then((md5) => parentPort?.postMessage({ id: job.id, md5 }))
})
