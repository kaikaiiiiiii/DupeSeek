// 压缩包元信息读取与条目解压哈希。本模块同时被主进程与 hash worker 引用，
// 因此禁止 import electron。
import { spawn } from 'child_process'
import fs from 'fs'
import { createHash } from 'crypto'
import { path7za } from '7zip-bin'
import { createExtractorFromFile, createExtractorFromData } from 'node-unrar-js'
import type { ArchiveType } from '../../shared/types'

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
  return headers
    .filter((h) => !h.flags.directory)
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

/** 7za 把条目解压到 stdout，流式哈希；退出码非 0 且非主动截断时视为失败 */
async function hashSevenZipEntry(
  containerPath: string,
  entryPath: string,
  capBytes?: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(path7za, ['x', '-y', '-so', containerPath, entryPath], {
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

/** rar：整包读入 worker 内存，解压目标条目后哈希（解压到内存） */
async function hashRarEntry(
  containerPath: string,
  entryPath: string,
  capBytes?: number
): Promise<string | null> {
  const buf = fs.readFileSync(containerPath)
  const ext = await createExtractorFromData({
    data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })
  const extracted = ext.extract({ files: [entryPath] })
  for (const f of extracted.files) {
    const content = f.extraction
    if (!content) continue
    const slice = capBytes && content.length > capBytes ? content.subarray(0, capBytes) : content
    return createHash('md5').update(slice).digest('hex')
  }
  return null
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
