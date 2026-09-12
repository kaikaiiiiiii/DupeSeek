import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'

const ES_TIMEOUT_MS = 60_000
const PROBE_TIMEOUT_MS = 5_000

export interface EverythingMeta {
  /** 完整路径 */
  filename: string
  /** 字节数 */
  size: number
  mtimeMs: number
}

export interface EverythingListResult {
  /** 目标目录下的全部子目录（含 reparse point 目录，剔除由调用方完成） */
  dirs: string[]
  /** 目标目录下的全部文件（不含 reparse point） */
  files: EverythingMeta[]
  /** 目标目录下的全部 reparse point 路径（junction/符号链接/云占位），用于子树剔除 */
  reparse: string[]
}

export interface EverythingLister {
  list(target: string): Promise<EverythingListResult>
}

interface EsRow {
  filename: string
  size?: number
  date_modified?: string
}

function esCandidates(): string[] {
  const candidates = [
    // 打包后：asarUnpack 展开到 app.asar.unpacked
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'bin', 'es.exe'),
    // 开发态：项目根下的 resources
    path.join(app.getAppPath(), 'resources', 'bin', 'es.exe'),
    path.join('C:\\Program Files\\Everything', 'es.exe'),
    path.join('C:\\Program Files (x86)\\Everything', 'es.exe')
  ]
  return candidates.filter((p) => fs.existsSync(p))
}

function runEs(esPath: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(esPath, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('es.exe 执行超时'))
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`es.exe 退出码 ${code}：${stderr.slice(0, 200)}`))
    })
  })
}

function parseRows(text: string): EsRow[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.trim() === '') return []
  return JSON.parse(text) as EsRow[]
}

async function listViaEs(esPath: string, target: string): Promise<EverythingListResult> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const outFile = path.join(os.tmpdir(), `dupeseek-es-f-${stamp}.json`)
  const outDir = path.join(os.tmpdir(), `dupeseek-es-d-${stamp}.json`)
  const outReparse = path.join(os.tmpdir(), `dupeseek-es-r-${stamp}.json`)
  // 布局：filename=完整路径；size 字节；date_modified 为 ISO-8601 UTC
  const layout = [
    '-json',
    '-size',
    '-date-modified',
    '-full-path-and-name',
    '-size-format',
    '1',
    '-date-format',
    '3',
    '-utf8-bom',
    '-timeout',
    '10000'
  ]
  try {
    // 属性开关用文档形式 /a-d、/ad、/aL，每个开关只携带一个属性。
    // 实测（es 1.1.0.37）：多属性塞进单个开关的组合形式（/a-d-L 等）D 排除失效。
    // junction/符号链接/云占位等 reparse point 统一经 /aL 清单返回，
    // 由调用方（引擎）做内存前缀剔除，不依赖 es 的属性排除语法。
    await runEs(
      esPath,
      ['-path', target, '/a-d', ...layout, '-export-json', outFile],
      ES_TIMEOUT_MS
    )
    await runEs(esPath, ['-path', target, '/ad', ...layout, '-export-json', outDir], ES_TIMEOUT_MS)
    await runEs(
      esPath,
      ['-path', target, '/aL', '-json', '-full-path-and-name', '-export-json', outReparse],
      ES_TIMEOUT_MS
    )
    const files = parseRows(fs.readFileSync(outFile, 'utf8'))
    const dirs = parseRows(fs.readFileSync(outDir, 'utf8')).map((r) =>
      r.filename.replace(/[\\/]+$/, '')
    )
    const reparse = parseRows(fs.readFileSync(outReparse, 'utf8')).map((r) =>
      r.filename.replace(/[\\/]+$/, '')
    )

    // 一致性哨兵：目录存在且非空，但 Everything 返回 0 条，说明未收录（如非 NTFS 卷），必须回退
    if (files.length === 0 && dirs.length === 0) {
      let direct: string[] = []
      try {
        direct = await fs.promises.readdir(target)
      } catch {
        direct = []
      }
      if (direct.length > 0) throw new Error('Everything 未收录该目录')
    }

    return {
      dirs,
      reparse,
      files: files.map((r) => ({
        filename: r.filename,
        size: r.size ?? 0,
        mtimeMs: r.date_modified ? Date.parse(r.date_modified) || 0 : 0
      }))
    }
  } finally {
    fs.rmSync(outFile, { force: true })
    fs.rmSync(outDir, { force: true })
    fs.rmSync(outReparse, { force: true })
  }
}

/** 探测 es.exe 且 Everything IPC 可达；不可用返回 null，由调用方回退 fs walk */
export async function createEverythingLister(): Promise<EverythingLister | null> {
  const esPath = esCandidates()[0]
  if (!esPath) return null
  try {
    await runEs(esPath, ['-n', '1'], PROBE_TIMEOUT_MS)
  } catch {
    return null
  }
  return { list: (target) => listViaEs(esPath, target) }
}
