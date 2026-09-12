// RAR 全量内存哈希验证：流式切片（原生 unrar）+ 交叉对照
// 用法：node --experimental-strip-types test-rar-stream.mts
// 注意：不用正则字面量——strip-types 会损坏含反斜杠的正则
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require_ = createRequire(import.meta.url)
const UNRAR = 'D:\\Coding\\DupeSeek\\resources\\bin\\UnRAR.exe'
const RAR = 'D:\\Coding\\vosscript.rar'
const HEAD = 1048576

interface EntrySpec {
  name: string
  size: number
}

interface StreamResult {
  ok: boolean
  full: string[]
  head: string[]
  ms: number
  peakRSSmb: number
}

function esSpawn(args: string[]): Promise<string> {
  const ES = 'D:\\Coding\\DupeSeek\\resources\\bin\\es.exe'
  return new Promise((resolve) => {
    const child = spawn(ES, args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('exit', () => resolve(out))
  })
}

/** rar 条目清单（顺序 = unrar p 数据流顺序） */
async function listing(): Promise<EntrySpec[]> {
  const { createExtractorFromFile } = require_('node-unrar-js')
  const ext = await createExtractorFromFile({ filepath: RAR })
  return [...ext.getFileList().fileHeaders]
    .filter((h) => !h.flags.directory)
    .map((h) => ({ name: h.name, size: h.unpSize }))
}

/**
 * 方案 B：unrar p 全量输出（无条目过滤，全部条目按存档顺序串联），
 * 按清单未压缩大小切片——每条目独立双哈希（full + head-1MB），零落盘
 */
function streamSlice(specs: EntrySpec[]): Promise<StreamResult> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(UNRAR, ['p', '-inul', '-y', RAR], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const full: string[] = []
    const head: string[] = []
    let idx = 0
    let inEntry = 0
    let headConsumed = 0
    let total = 0
    let peak = 0
    let settled = false
    let cur = createHash('md5')
    let curHead = createHash('md5')

    const closeEntry = (): void => {
      full.push(cur.digest('hex'))
      head.push(curHead.digest('hex'))
      idx++
      inEntry = 0
      headConsumed = 0
      cur = createHash('md5')
      curHead = createHash('md5')
    }

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      const allBytes = total === specs.reduce((s, e) => s + e.size, 0)
      resolve({
        ok: ok && allBytes && idx === specs.length,
        full,
        head,
        ms: Date.now() - t0,
        peakRSSmb: peak / 1048576
      })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      const m = process.memoryUsage().rss
      if (m > peak) peak = m
      let off = 0
      while (off < chunk.length) {
        if (idx >= specs.length) {
          finish(false)
          return
        }
        const spec = specs[idx]
        const remaining = spec.size - inEntry
        const take = Math.min(remaining, chunk.length - off)
        const piece = chunk.subarray(off, off + take)
        cur.update(piece)
        // head：只累计每条目前 1MB（不足 1MB 的条目即整条）
        if (headConsumed < Math.min(spec.size, HEAD)) {
          const hp = piece.subarray(
            0,
            Math.min(piece.length, Math.min(spec.size, HEAD) - headConsumed)
          )
          curHead.update(hp)
          headConsumed += hp.length
        }
        inEntry += take
        off += take
        if (inEntry >= spec.size) {
          closeEntry()
        }
      }
    })
    child.on('exit', (code) => finish(code === 0))
    child.on('error', () => finish(false))
  })
}

/** 对照组：单条目独立解压（unrar p 逐条），验证切片哈希的正确性。
 *  注意：native unrar 匹配包内路径要求反斜杠（清单给的是正斜杠） */
function singleEntryMd5(entry: string, cap?: number): Promise<string> {
  const native = entry.split('/').join('\\')
  return new Promise((resolve) => {
    const child = spawn(UNRAR, ['p', '-inul', '-y', RAR, native], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const hash = createHash('md5')
    let bytes = 0
    child.stdout.on('data', (c: Buffer) => {
      const take = cap !== undefined ? Math.min(c.length, cap - bytes) : c.length
      if (take > 0) {
        hash.update(c.subarray(0, take))
        bytes += take
      }
    })
    child.on('exit', () => resolve(hash.digest('hex')))
    child.on('error', () => resolve('ERROR'))
  })
}

async function main(): Promise<void> {
  const { createExtractorFromFile } = require_('node-unrar-js')

  // 1) 清单（node-unrar-js 头解析，顺序 = 数据流顺序，含免费 crc32）
  const tList0 = Date.now()
  const ext = await createExtractorFromFile({ filepath: RAR })
  const specs: EntrySpec[] = [...ext.getFileList().fileHeaders]
    .filter((h) => !h.flags.directory)
    .map((h) => ({ name: h.name, size: h.unpSize }))
  const listMs = Date.now() - tList0
  const expected = specs.reduce((s, e) => s + e.size, 0)
  console.log(
    '清单:',
    specs.length,
    '条目,',
    (expected / 1048576).toFixed(1),
    'MB, 头解析',
    listMs,
    'ms'
  )

  // 2) 方案 B：流式切片双哈希
  const r = await streamSlice(specs)
  console.log(
    JSON.stringify({
      approach: 'native-stream-slice',
      ok: r.ok,
      entries: r.full.length,
      ms: r.ms,
      peakRSSmb: r.peakRSSmb.toFixed(0)
    })
  )

  // 3) 对照：第 1 条与中间一条，独立解压比对（full 与 head 分别比对）
  if (r.ok && specs.length >= 3) {
    const mid = Math.floor(specs.length / 2)
    const soloFull1 = await singleEntryMd5(specs[0].name)
    const soloFullMid = await singleEntryMd5(specs[mid].name)
    const soloHeadMid = await singleEntryMd5(specs[mid].name, HEAD)
    console.log(
      JSON.stringify({
        checkFirst: soloFull1 === r.full[0],
        checkMidFull: soloFullMid === r.full[mid],
        checkMidHead: soloHeadMid === r.head[mid]
      })
    )
  }
  process.exit(0)
}

void main()
