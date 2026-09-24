// 非固实 rar：逐条目独立解压 vs 全量流式切片 对比
// 用法：node --experimental-strip-types test-rar-normal.mts
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require_ = createRequire(import.meta.url)
const UNRAR = 'D:\\Coding\\DupeSeek\\resources\\bin\\UnRAR.exe'
const RAR = 'D:\\Coding\\vosscript.normal.rar'

interface EntrySpec {
  name: string
  size: number
}

/** rar 条目清单（顺序 = 数据流顺序） */
async function listing(): Promise<EntrySpec[]> {
  const { createExtractorFromFile } = require_('node-unrar-js')
  const ext = await createExtractorFromFile({ filepath: RAR })
  return [...ext.getFileList().fileHeaders]
    .filter((h) => !h.flags.directory)
    .map((h) => ({ name: h.name, size: h.unpSize }))
}

/** 逐条目独立解压（随机访问） */
function singleEntryMd5(entry: string): Promise<{ ms: number; bytes: number }> {
  const native = entry.split('/').join('\\')
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(UNRAR, ['p', '-inul', '-y', RAR, native], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const hash = createHash('md5')
    let bytes = 0
    child.stdout.on('data', (c: Buffer) => {
      bytes += c.length
      hash.update(c)
    })
    child.on('exit', (code) => resolve({ ms: Date.now() - t0, bytes: code === 0 ? bytes : -1 }))
    child.on('error', () => resolve({ ms: Date.now() - t0, bytes: -1 }))
  })
}

/** 全量流式切片（与 test-rar-stream.mts 相同的实现） */
function streamSlice(specs: EntrySpec[]): Promise<{ ok: boolean; count: number; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(UNRAR, ['p', '-inul', '-y', RAR], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const full: string[] = []
    let idx = 0
    let inEntry = 0
    let total = 0
    let settled = false
    let cur = createHash('md5')

    const closeEntry = (): void => {
      full.push(cur.digest('hex'))
      idx++
      inEntry = 0
      cur = createHash('md5')
    }
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      const expected = specs.reduce((s, e) => s + e.size, 0)
      console.log(
        'TEMP-DEBUG exit:',
        JSON.stringify({
          exitCode: child.exitCode,
          totalBytes: total,
          listingBytes: expected,
          idx,
          short: specs.length - idx
        })
      )
      if (idx < specs.length) {
        for (const sp of specs.slice(idx, idx + 5))
          console.log('  缺失起始条目:', JSON.stringify(sp))
      }
      resolve({
        ok: ok && allBytes && idx === specs.length,
        count: full.length,
        ms: Date.now() - t0
      })
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      let off = 0
      while (off < chunk.length) {
        if (idx >= specs.length) {
          finish(false)
          return
        }
        const remaining = specs[idx].size - inEntry
        const take = Math.min(remaining, chunk.length - off)
        cur.update(chunk.subarray(off, off + take))
        inEntry += take
        off += take
        if (inEntry >= specs[idx].size && specs[idx].size >= 0) {
          if (inEntry === specs[idx].size) closeEntry()
        }
      }
    })
    child.on('exit', (code) => finish(code === 0))
    child.on('error', () => finish(false))
  })
}

async function main(): Promise<void> {
  const specs = await listing()
  console.log(
    '清单:',
    specs.length,
    '条目,',
    (specs.reduce((s, e) => s + e.size, 0) / 1048576).toFixed(1),
    'MB'
  )

  // 全量流式切片
  const stream = await streamSlice(specs)
  console.log(
    JSON.stringify({
      approach: 'stream-slice',
      ok: stream.ok,
      entries: stream.count,
      ms: stream.ms,
      perEntryUs: (stream.ms * 1000) / specs.length
    })
  )

  // 逐条目独立解压：20 个均匀采样
  const SAMPLES = 20
  let sum = 0
  let max = 0
  let okCount = 0
  const t0 = Date.now()
  for (let i = 0; i < SAMPLES; i++) {
    const spec = specs[Math.floor((i * specs.length) / SAMPLES)]
    const r = await singleEntryMd5(spec.name)
    sum += r.ms
    if (r.ms > max) max = r.ms
    if (r.bytes === spec.size) okCount++
  }
  const sampleMs = Date.now() - t0
  const avg = sum / SAMPLES
  console.log(
    JSON.stringify({
      approach: 'per-entry (sample 20)',
      sampleTotalMs: sampleMs,
      avgMs: avg.toFixed(0),
      maxMs: max,
      okCount,
      projectedAllMs: (avg * specs.length).toFixed(0)
    })
  )
  process.exit(0)
}

void main()
