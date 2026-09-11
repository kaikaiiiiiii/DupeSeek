import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import type { Readable } from 'stream'

/** 对流做 md5；capBytes 限制读取上限（读到即返回）；任何错误返回 null */
export function hashStreamMd5(stream: Readable, capBytes?: number): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('md5')
    let read = 0
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      stream.destroy()
      resolve(value)
    }
    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      const take = capBytes !== undefined ? Math.min(chunk.length, capBytes - read) : chunk.length
      if (take > 0) hash.update(take === chunk.length ? chunk : chunk.subarray(0, take))
      read += take
      if (capBytes !== undefined && read >= capBytes) finish(hash.digest('hex'))
    })
    stream.on('end', () => finish(hash.digest('hex')))
    stream.on('error', () => finish(null))
  })
}

/** 普通文件前 capBytes 字节的 md5 */
export function md5HeadFile(filePath: string, capBytes: number): Promise<string | null> {
  return hashStreamMd5(createReadStream(filePath, { end: capBytes - 1 }))
}

/** 普通文件全量 md5 */
export function md5FullFile(filePath: string): Promise<string | null> {
  return hashStreamMd5(createReadStream(filePath))
}
