// 交叉对照：WASM 全量解压 vs 清单 vs 原生 p 流（断点复现性）
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require_ = createRequire(import.meta.url)
const UNRAR = 'D:\\Coding\\DupeSeek\\resources\\bin\\UnRAR.exe'
const RAR = 'D:\\Coding\\vosscript.normal.rar'

interface EsRow {
  filename: string
}

interface Spec {
  name: string
  size: number
}

function esList(): Promise<Spec[]> {
  return new Promise((resolve) => {
    const child = spawn('D:\\Coding\\DupeSeek\\resources\\bin\\es.exe', [
      '-path',
      'D:\\Coding',
      '-n',
      '50000',
      '-json',
      '-full-path-and-name',
      '-size-format',
      '1'
    ], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('exit', () => {
      let t = out
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
      const rows: EsRow[] = t.trim() ? JSON.parse(t) : []
      resolve(
        rows
          .filter((r) => r.filename.toLowerCase() === RAR.toLowerCase())
          .map(() => ({ name: '', size: 0 }))
      )
    })
  })
}

async function listing(): Promise<Spec[]> {
  const { createExtractorFromFile } = require_('node-unrar-js')
  const ext = await createExtractorFromFile({ filepath: RAR })
  return [...ext.getFileList().fileHeaders]
    .filter((h) => !h.flags.directory)
    .map((h) => ({ name: h.name, size: h.unpSize }))
}

/** 原生 p 流切片（带调试：断点条目名） */
function streamSlice(specs: Spec[]): Promise<{ idx: number; total: number; expected: number }> {
  return new Promise((resolve) => {
    const child = spawn(UNRAR, ['p', '-inul', '-y', RAR], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let idx = 0
    let inEntry = 0
    let total = 0
    let settled = false
    const expected = specs.reduce((s, e) => s + e.size, 0)
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      let off = 0
      while (off < chunk.length) {
        if (idx >= specs.length) {
          settled = true
          resolve({ idx, total, expected })
          return
        }
        const take = Math.min(specs[idx].size - inEntry, chunk.length - off)
        inEntry += take
        off += take
        if (inEntry >= specs[idx].size && specs[idx].size >= 0) {
          if (inEntry === specs[idx].size) {
            idx++
            inEntry = 0
          }
        }
      }
    })
    child.on('exit', () => {
      if (!settled) {
        settled = true
        resolve({ idx, total, expected })
      }
    })
  })
}

async function main(): Promise<void> {
  const specs = await listing()
  console.log('清单:', specs.length, '条目,', (specs.reduce((s, e) => s + e.size, 0) / 1048576).toFixed(1), 'MB')

  // WASM 全量解压：逐条目长度序列 vs 清单长度序列
  const { createExtractorFromFile } = require_('node-unrar-js')
  const ext = await createExtractorFromFile({ filepath: RAR })
  const gen = ext.extract()
  let n = 0
  let sizeMismatch = 0
  const t0 = Date.now()
  for (const f of gen.files) {
    if (f.fileHeader.flags.directory) continue
    const actual = f.extraction ? f.extraction.length : -1
    if (n < specs.length && actual !== specs[n].size) sizeMismatch++
    n++
  }
  console.log('WASM 全量解压条目数:', n, '尺寸不一致:', sizeMismatch, '耗时:', Date.now() - t0, 'ms')

  // 原生 p 断点复现 ×2
  for (let round = 1; round <= 2; round++) {
    const r = await streamSlice(specs)
    console.log('p 流 round', round, ':', JSON.stringify(r))
  }
  process.exit(0)
}

void main()
