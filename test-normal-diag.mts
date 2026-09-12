// vosscript.normal.rar 诊断：全量解压 vs 逐条目解压 计时 + 54 条缺失定位
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

const require_ = createRequire(import.meta.url)
const UNRAR = 'D:\\Coding\\DupeSeek\\resources\\bin\\UnRAR.exe'
const RAR = 'D:\\Coding\\vosscript.normal.rar'
const XTREE = 'C:\\tmp-xtract'

interface Spec {
  name: string
  size: number
}

function unrarOut(args: string[]): Promise<{ code: number | null; out: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(UNRAR, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('exit', (code) => resolve({ code, out: Buffer.concat(chunks) }))
  })
}

function parseEs(text: string): Spec[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (!text.trim()) return []
  return JSON.parse(text).map((r) => ({ name: '', size: 0 }))
}

async function main(): Promise<void> {
  // 1) 清单（node-unrar-js）
  const { createExtractorFromFile } = require_('node-unrar-js')
  const ext = await createExtractorFromFile({ filepath: RAR })
  const specs: Spec[] = [...ext.getFileList().fileHeaders]
    .filter((h) => !h.flags.directory)
    .map((h) => ({ name: h.name, size: h.unpSize }))
  const sum = specs.reduce((s, e) => s + e.size, 0)
  console.log('清单:', specs.length, '条目,', (sum / 1048576).toFixed(1), 'MB')

  // 2) 全量解压（x 到磁盘）计时——模拟"压缩包视作目录"模型
  const tX0 = Date.now()
  const x1 = await unrarOut(['x', '-y', '-inul', RAR, 'C:\\tmp-xtract2\\'])
  const xMs = Date.now() - tX0
  void x1
  console.log('全量解压 (x 到临时目录):', xMs, 'ms')

  // 3) 逐条目独立解压采样（p 单条）：30 个均匀样本
  const tP0 = Date.now()
  let pSum = 0
  let pMax = 0
  let pOk = 0
  const SAMPLES = 30
  for (let i = 0; i < SAMPLES; i++) {
    const spec = specs[Math.floor((i * specs.length) / SAMPLES)]
    const native = spec.name.split('/').join('\\')
    const t0 = Date.now()
    const r = await unrarOut(['p', '-inul', '-y', RAR, native])
    const ms = Date.now() - t0
    pSum += ms
    if (ms > pMax) pMax = ms
    if (r.out.length === spec.size) pOk++
  }
  const pAvg = pSum / SAMPLES
  console.log(
    '逐条目解压采样:',
    JSON.stringify({ samples: SAMPLES, avgMs: pAvg.toFixed(0), maxMs: pMax, sizeOk: pOk }),
    '→ 外推全量:',
    ((pAvg * specs.length) / 1000).toFixed(0),
    's'
  )

  // 4) 缺失定位：全量 p 流切片，检查从哪一条起对不上
  //    （把 p 全量流落盘一次，按清单边界切片，逐条目比对独立解压的长度）
  const streamResult = await unrarOut(['p', '-inul', '-y', RAR])
  const stream = streamResult.out
  console.log('全量 p 流字节:', stream.length, '（清单', sum, '，差', sum - stream.length, '）')

  // 按清单顺序切片并记录每条目的实际字节数
  let off = 0
  const actualSizes: number[] = []
  for (const spec of specs) {
    if (off >= stream.length) {
      actualSizes.push(-1)
      continue
    }
    const n = Math.min(spec.size, stream.length - off)
    actualSizes.push(n)
    off += n
  }
  const bad = specs
    .map((s, i) => ({ i, spec: s, actual: actualSizes[i] }))
    .filter((x) => x.actual !== x.spec.size)
  console.log('不一致条目数:', bad.length, '（首个不一致位置）:')
  for (const b of bad.slice(0, 6)) {
    console.log(
      '  #',
      b.i,
      JSON.stringify(b.spec.name.slice(0, 90)),
      '清单',
      b.spec.size,
      '实际',
      b.actual
    )
  }

  // 5) x 解压树对照：缺失条目在解压树中的实际大小
  for (const b of bad.slice(0, 3)) {
    const disk = 'C:\\tmp-xtract2\\' + b.spec.name.split('/').join('\\')
    try {
      const st = fs.statSync(disk)
      console.log(
        'x 树对照:',
        JSON.stringify(b.spec.name.slice(0, 70)),
        '清单',
        b.spec.size,
        '磁盘',
        st.size
      )
    } catch {
      console.log('x 树对照: 不存在于解压树', JSON.stringify(disk))
    }
  }
  process.exit(0)
}

void main()
