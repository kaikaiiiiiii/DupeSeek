// 基准 B：同步 fs 枚举 + 同步读取 head-1MB md5（支持多 worker）
// 用法：node bench-sync.mjs <目录> <worker数>
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

const root = path.resolve(process.argv[2] ?? '.')
const workerCount = Number(process.argv[3] ?? 1)
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
  const len = Math.min(size, HEAD)
  const fd = fs.openSync(p, 'r')
  try {
    const buf = Buffer.allocUnsafe(len)
    let read = 0
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, read)
      if (n <= 0) break
      read += n
    }
    return createHash('md5')
      .update(read === len ? buf : buf.subarray(0, read))
      .digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

const t0 = performance.now()
const files = []
walkSync(root, files)
const walkMs = performance.now() - t0

const t1 = performance.now()
let bytes = 0
let failed = 0

if (workerCount <= 1) {
  for (const p of files) {
    try {
      const st = fs.statSync(p)
      headMd5Sync(p, st.size)
      bytes += Math.min(st.size, HEAD)
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
    function headMd5Sync(p, size) {
      const len = Math.min(size, HEAD)
      const fd = fs.openSync(p, 'r')
      try {
        const buf = Buffer.allocUnsafe(len)
        let read = 0
        while (read < len) {
          const n = fs.readSync(fd, buf, read, len - read, read)
          if (n <= 0) break
          read += n
        }
        return createHash('md5').update(read === len ? buf : buf.subarray(0, read)).digest('hex')
      } finally { fs.closeSync(fd) }
    }
    parentPort.on('message', (paths) => {
      let bytes = 0
      let failed = 0
      for (const p of paths) {
        try {
          const st = fs.statSync(p)
          headMd5Sync(p, st.size)
          bytes += Math.min(st.size, HEAD)
        } catch { failed++ }
      }
      parentPort.postMessage({ bytes, failed })
    })
  `
  const CHUNK = 256
  const pool = Array.from({ length: workerCount }, () => new Worker(workerCode, { eval: true }))
  let next = 0
  const results = Array.from({ length: workerCount }, () => ({ bytes: 0, failed: 0 }))
  const feed = (w) => {
    const chunk = files.slice(next, next + CHUNK)
    next += chunk.length
    if (chunk.length > 0) w.postMessage(chunk)
    else w.unref?.()
  }
  await new Promise((resolve) => {
    let remaining = workerCount
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
    variant: `sync x${workerCount}`,
    files: files.length,
    walkMs: Math.round(walkMs),
    hashMs: Math.round(hashMs),
    totalMs: Math.round(performance.now() - t0),
    hashMB: (bytes / 1048576).toFixed(1),
    failed
  })
)
