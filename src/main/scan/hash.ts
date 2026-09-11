// 文件 md5 计算（仅 hash worker 使用）。
// 实测（13885 文件 / 196MB，本工程目录，NVMe）：
//   sync 读 x8 worker 364ms；async 流 x8 1334ms（UV 线程池扩到 16 也只到 1145ms）。
// 大量小文件场景下同步直读完胜异步流（免去线程池排队、流对象与事件循环跳转），
// 且任务本就派发在 worker 线程，同步不会阻塞主进程。
import { createHash } from 'crypto'
import fs from 'fs'

const FULL_CHUNK = 1024 * 1024

function md5Of(buf: Buffer, len: number): string {
  return createHash('md5')
    .update(len === buf.length ? buf : buf.subarray(0, len))
    .digest('hex')
}

/** 文件前 capBytes 字节的 md5；读取失败抛出（EACCES/EPERM 等保留在 err.code） */
export function md5HeadFile(filePath: string, capBytes: number): string {
  const len = Math.min(capBytes, 1 << 30)
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(len)
    let read = 0
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, read)
      if (n <= 0) break
      read += n
    }
    return md5Of(buf, read)
  } finally {
    fs.closeSync(fd)
  }
}

/** 文件全量 md5；按 1MB 块同步顺序读取（大文件内存占用有界） */
export function md5FullFile(filePath: string): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const hash = createHash('md5')
    const buf = Buffer.allocUnsafe(FULL_CHUNK)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, FULL_CHUNK, null)
      if (n <= 0) break
      hash.update(n === FULL_CHUNK ? buf : buf.subarray(0, n))
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}
