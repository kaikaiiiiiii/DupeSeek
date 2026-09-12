// 压缩包元信息读取与条目解压哈希。本模块同时被主进程与 hash worker 引用，
// 因此禁止 import electron。
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { path7za } from '7zip-bin'
import { createExtractorFromFile } from 'node-unrar-js'
import type { ArchiveType } from '../../shared/types'

/** 原生 unrar.exe（resources/bin 随应用分发），由主进程经环境变量告知位置 */
function unrarExe(): string | null {
  const bin = process.env['DUPESEEK_BIN_DIR']
  if (!bin) return null
  const p = bin + '\\UnRAR.exe'
  return fs.existsSync(p) ? p : null
}

export interface ArchiveEntryMeta {
  /** 包内条目路径（工具返回的原样分隔符） */
  entryPath: string
  /** 未压缩字节数 */
  size: number
  /** 元信息中的 crc32；缺失为 null */
  crc32: number | null
  mtimeMs: number
}

interface SltBlock {
  get(key: string): string | undefined
}

function parseSltBlocks(output: string): SltBlock[] {
  // 技术清单从 ---------- 分隔线之后开始；之前是压缩包自身信息块
  const sep = output.search(/^-{10,}\s*$/m)
  if (sep < 0) return []
  const body = output.slice(sep)
  return body
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const map = new Map<string, string>()
      for (const line of block.split(/\r?\n/)) {
        const i = line.indexOf(' = ')
        if (i > 0) map.set(line.slice(0, i), line.slice(i + 3))
      }
      return { get: (key: string) => map.get(key) }
    })
    .filter((b) => b.get('Path') !== undefined)
}

function parseMtime(v: string | undefined): number {
  if (!v) return 0
  return Date.parse(v.replace(' ', 'T')) || 0
}

async function run7za(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(path7za, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('7za 执行超时'))
    }, 120_000)
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`7za 退出码 ${code}：${stderr.slice(0, 200)}`))
    })
  })
}

/** 用 7za 技术清单读取 zip/7z 内条目（跳过目录项） */
async function listSevenZip(containerPath: string): Promise<ArchiveEntryMeta[]> {
  const output = await run7za(['l', '-slt', containerPath])
  const out: ArchiveEntryMeta[] = []
  for (const b of parseSltBlocks(output)) {
    if ((b.get('Folder') ?? '-') !== '-') continue
    const attrs = b.get('Attributes') ?? ''
    if (attrs.split('').includes('D')) continue
    const entryPath = b.get('Path') as string
    const size = Number.parseInt(b.get('Size') ?? '', 10)
    if (!Number.isFinite(size)) continue
    const crcText = b.get('CRC')
    out.push({
      entryPath,
      size,
      crc32: crcText ? Number.parseInt(crcText, 16) >>> 0 : null,
      mtimeMs: parseMtime(b.get('Modified'))
    })
  }
  return out
}

/** 用 unrar（WASM）读取 rar 内条目 */
async function listRar(containerPath: string): Promise<ArchiveEntryMeta[]> {
  const ext = await createExtractorFromFile({ filepath: containerPath })
  const headers = [...ext.getFileList().fileHeaders]
  // node-unrar-js 会把部分目录误报为文件（flags.directory 漏标、size 为目录聚合值），
  // 需按名称尾部分隔符二次排除
  return headers
    .filter((h) => !h.flags.directory && !h.name.endsWith('/') && !h.name.endsWith('\\'))
    .map((h) => ({
      entryPath: h.name,
      size: h.unpSize,
      crc32: typeof h.crc === 'number' ? h.crc >>> 0 : null,
      mtimeMs: h.time ? Date.parse(h.time) || 0 : 0
    }))
}

export async function listArchive(
  containerPath: string,
  type: ArchiveType
): Promise<ArchiveEntryMeta[]> {
  return type === 'rar' ? listRar(containerPath) : listSevenZip(containerPath)
}

/** 解压工具把条目写到 stdout，流式哈希；cap 读满提前 kill（信任摘要），否则退出码非 0 视为失败 */
function hashSpawnStdout(
  toolPath: string,
  args: string[],
  capBytes?: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(toolPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const hash = createHash('md5')
    let read = 0
    let digest: string | null = null
    let killed = false
    let exited = false
    let exitCode: number | null = null
    let settled = false

    const tryFinish = (): void => {
      if (settled || digest === null) return
      if (killed) {
        settled = true
        resolve(digest)
      } else if (exited) {
        settled = true
        resolve(exitCode === 0 ? digest : null)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      const take = capBytes !== undefined ? Math.min(chunk.length, capBytes - read) : chunk.length
      if (take > 0) hash.update(take === chunk.length ? chunk : chunk.subarray(0, take))
      read += take
      if (capBytes !== undefined && read >= capBytes) {
        digest = hash.digest('hex')
        killed = true
        child.kill()
        tryFinish()
      }
    })
    child.stdout.on('end', () => {
      digest = hash.digest('hex')
      tryFinish()
    })
    child.stderr.on('data', (): void => undefined)
    child.on('close', (code) => {
      exited = true
      exitCode = code ?? -1
      if (digest === null) {
        settled = true
        resolve(null)
        return
      }
      tryFinish()
    })
    child.on('error', () => {
      settled = true
      resolve(null)
    })
  })
}

/** 7za 把条目解压到 stdout，流式哈希 */
async function hashSevenZipEntry(
  containerPath: string,
  entryPath: string,
  capBytes?: number
): Promise<string | null> {
  return hashSpawnStdout(path7za, ['x', '-y', '-so', containerPath, entryPath], capBytes)
}

/** rar：原生 unrar.exe 把条目解压到 stdout，流式哈希（cap 读满即提前终止）。
 *  注意：native unrar 匹配包内路径要求反斜杠分隔（node-unrar-js 列表给的是正斜杠）。
 *  已弃用：固实卷逐条目解压需重复解压前缀（O(条目×前缀)），改用 extractRarEntries 批量解压。 */
async function hashRarEntry(
  containerPath: string,
  entryPath: string,
  capBytes?: number
): Promise<string | null> {
  const unrar = unrarExe()
  if (!unrar) return null
  const nativePath = entryPath.replace(/\//g, '\\')
  return hashSpawnStdout(unrar, ['p', '-inul', '-y', containerPath, nativePath], capBytes)
}

export interface RarExtractResult {
  /** 成功写出的条目数 */
  extracted: number
}

/**
 * rar 批量解压：一次 unrar x 把一批条目解到临时目录（返回实际写出的条目数）。
 * 固实卷逐条目解压需要重复解压公共前缀（实测单条 2s × 数千条），批量一次解压
 * 摊平该成本。解出的文件路径 = tempRoot + '\' + entryPath。
 */
export async function extractRarEntries(
  containerPath: string,
  entryPaths: string[],
  tempRoot: string,
  unrarPath: string | null
): Promise<number> {
  const unrar = unrarPath ?? unrarExe()
  if (!unrar) return 0
  fs.mkdirSync(tempRoot, { recursive: true })
  const dest = tempRoot.endsWith('\\') ? tempRoot : tempRoot + '\\'
  let extracted = 0
  // 单次 spawn 的参数总长约 32KB 上限，按 60 条/批切分（CJK 路径每条可达数百字节）
  const CHUNK = 60
  for (let i = 0; i < entryPaths.length; i += CHUNK) {
    const chunk = entryPaths.slice(i, i + CHUNK).map((p) => p.replace(/\//g, '\\'))
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(unrar, ['x', '-y', '-inul', containerPath, ...chunk, dest], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        resolve(false)
      }, 600_000)
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
      child.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
      void stderr
    })
    if (!ok) continue
    // 统计实际落盘数（加密/损坏条目可能缺失）
    for (const rel of chunk) {
      try {
        if (fs.statSync(path.join(dest, rel)).isFile()) extracted++
      } catch {
        // 缺失条目忽略
      }
    }
  }
  return extracted
}

export function hashArchiveEntry(
  containerPath: string,
  entryPath: string,
  type: ArchiveType,
  capBytes?: number
): Promise<string | null> {
  return type === 'rar'
    ? hashRarEntry(containerPath, entryPath, capBytes)
    : hashSevenZipEntry(containerPath, entryPath, capBytes)
}
