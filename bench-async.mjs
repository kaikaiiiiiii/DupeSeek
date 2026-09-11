// 基准 A：异步 fs 枚举 + 异步流式 head-1MB md5
// 用法：node bench-async.mjs <目录> <并发数>
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.')
const concurrency = Number(process.argv[3] ?? 1)
const HEAD = 1024 * 1024

async function walk(dir, out) {
  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const d of dirents) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) await walk(p, out)
    else if (d.isFile()) out.push(p)
  }
}

function headMd5(p, size) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(p, size > HEAD ? { end: HEAD - 1 } : undefined)
    stream.on('data', (c) => hash.update(c))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

const t0 = performance.now()
const files = []
await walk(root, files)
const walkMs = performance.now() - t0

const t1 = performance.now()
let bytes = 0
let failed = 0
let index = 0
async function worker() {
  while (index < files.length) {
    const p = files[index++]
    try {
      const st = await fs.stat(p)
      await headMd5(p, st.size)
      bytes += Math.min(st.size, HEAD)
    } catch {
      failed++
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
const hashMs = performance.now() - t1

console.log(
  JSON.stringify({
    variant: `async x${concurrency}`,
    files: files.length,
    walkMs: Math.round(walkMs),
    hashMs: Math.round(hashMs),
    totalMs: Math.round(performance.now() - t0),
    hashMB: (bytes / 1048576).toFixed(1),
    failed
  })
)
