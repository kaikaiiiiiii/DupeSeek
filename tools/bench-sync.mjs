// 基准 B：同步 fs 枚举 + 同步读取 md5（支持多 worker）
// 用法：node bench-sync.mjs <目录> <worker数> [head|full] [文件数上限]
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

const root = path.resolve(process.argv[2] ?? '.')
const workerCount = Number(process.argv[3] ?? 1)
const mode = process.argv[4] ?? 'head'
const fileLimit = Number(process.argv[5] ?? Infinity)
const HEAD = 1024 * 1024

function walkSync(dir, out) {
  let dirents
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const d of dirents) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walkSync(p, out)
    else if (d.isFile()) out.push(p)
  }
}

function headMd5Sync(p, size) {
  const len = mode === 'full' ? size : Math.min(size, HEAD)
  const fd = fs.openSync(p, 'r')
  try {
    const buf = Buffer.allocUnsafe(Math.min(len, HEAD))
    const hash = createHash('md5')
    let read = 0
    while (read < len) {
      const want = Math.min(HEAD, len - read)
      const n = fs.readSync(fd, buf, 0, want, read)
      if (n <= 0) break
      hash.update(n === want ? buf : buf.subarray(0, n))
      read += n
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

const t0 = performance.now()
const files = []
walkSync(root, files)
if (Number.isFinite(fileLimit)) files.length = Math.min(files.length, fileLimit)
const walkMs = performance.now() - t0

const t1 = performance.now()
let bytes = 0
let failed = 0

if (workerCount <= 1) {
  for (const p of files) {
    try {
      const st = fs.statSync(p)
      headMd5Sync(p, st.size)
      bytes += mode === 'full' ? st.size : Math.min(st.size, HEAD)
    } catch {
      failed++
    }
  }
} else {
  // 动态分片：主线程按批派发路径，worker 同步消费后领下一批
  const workerCode = `
    const { parentPort } = require('node:worker_threads')
    const fs = require('node:fs')
    const { createHash } = require('node:crypto')
    const HEAD = 1024 * 1024
    const FULL = ${mode === 'full'}
    function headMd5Sync(p, size) {
      const len = FULL ? size : Math.min(size, HEAD)
      const fd = fs.openSync(p, 'r')
      try {
        const buf = Buffer.allocUnsafe(Math.min(len, HEAD))
        const hash = createHash('md5')
        let read = 0
        while (read < len) {
          const want = Math.min(HEAD, len - read)
          const n = fs.readSync(fd, buf, 0, want, read)
          if (n <= 0) break
          hash.update(n === want ? buf : buf.subarray(0, n))
          read += n
        }
        return hash.digest('hex')
      } finally { fs.closeSync(fd) }
    }
    parentPort.on('message', (paths) => {
      let bytes = 0
      let failed = 0
      for (const p of paths) {
        try {
          const st = fs.statSync(p)
          headMd5Sync(p, st.size)
          bytes += FULL ? st.size : Math.min(st.size, HEAD)
        } catch { failed++ }
      }
      parentPort.postMessage({ bytes, failed })
    })
  `
  // 分片大小自适应：文件多时 256/片，文件少时按 worker 数均分（保证真并行）
  const CHUNK =
    files.length >= 256 ? 256 : Math.max(1, Math.ceil(files.length / Math.max(1, workerCount)))
  // 只创建真正会领到分片的 worker：分片数少于 worker 数时，空分片 worker 永远
  // 不会回报，导致 remaining 永远无法归零（死锁）
  const active = Math.max(1, Math.min(workerCount, Math.ceil(files.length / CHUNK)))
  const pool = Array.from({ length: active }, () => new Worker(workerCode, { eval: true }))
  let next = 0
  const results = Array.from({ length: active }, () => ({ bytes: 0, failed: 0 }))
  const feed = (w) => {
    const chunk = files.slice(next, next + CHUNK)
    next += chunk.length
    if (chunk.length > 0) w.postMessage(chunk)
    else w.unref?.()
  }
  await new Promise((resolve) => {
    let remaining = active
    pool.forEach((w, i) => {
      w.on('message', (r) => {
        results[i].bytes += r.bytes
        results[i].failed += r.failed
        if (next < files.length) feed(w)
        else if (--remaining === 0) resolve()
      })
      feed(w)
    })
  })
  bytes = results.reduce((s, r) => s + r.bytes, 0)
  failed = results.reduce((s, r) => s + r.failed, 0)
}
const hashMs = performance.now() - t1

console.log(
  JSON.stringify({
    variant: `sync x${workerCount} ${mode}`,
    files: files.length,
    walkMs: Math.round(walkMs),
    hashMs: Math.round(hashMs),
    totalMs: Math.round(performance.now() - t0),
    hashMB: (bytes / 1048576).toFixed(1),
    failed
  })
)
// worker 线程残留会拖住事件循环导致进程不退出，基准打印完直接结束
process.exit(0)
