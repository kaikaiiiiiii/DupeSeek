import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import type { Readable } from 'stream'

/** 对流做 md5；capBytes 限制读取上限（读到即返回）；读取错误以 reject 抛出（保留 errno 供上层识别） */
export function hashStreamMd5(stream: Readable, capBytes?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    let read = 0
    let settled = false
    const finish = (value: string | undefined, err?: unknown): void => {
      if (settled) return
      settled = true
      stream.destroy()
      if (err !== undefined) reject(err)
      else resolve(value as string)
    }
    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      const take = capBytes !== undefined ? Math.min(chunk.length, capBytes - read) : chunk.length
      if (take > 0) hash.update(take === chunk.length ? chunk : chunk.subarray(0, take))
      read += take
      if (capBytes !== undefined && read >= capBytes) finish(hash.digest('hex'))
    })
    stream.on('end', () => finish(hash.digest('hex')))
    stream.on('error', (err) => finish(undefined, err))
  })
}

/** 普通文件前 capBytes 字节的 md5；读取失败 reject（EACCES/EPERM 等保留在 err.code） */
export function md5HeadFile(filePath: string, capBytes: number): Promise<string> {
  return hashStreamMd5(createReadStream(filePath, { end: capBytes - 1 }))
}

/** 普通文件全量 md5 */
export function md5FullFile(filePath: string): Promise<string> {
  return hashStreamMd5(createReadStream(filePath))
}
