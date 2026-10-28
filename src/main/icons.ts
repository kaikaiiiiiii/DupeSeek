// 系统图标服务：走 Electron app.getFileIcon（Windows 底层为 SHGetFileInfo，
// 命中系统图标缓存，TreeSize Free 同款思路）。目录先看 desktop.ini 的
// 自定义图标（IconResource/IconFile 指向图片文件时直接读图；指向
// dll/exe 资源的不解析，回退系统文件夹图标）。
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const cache = new Map<string, string>()
const MAX_CACHE = 20000
const IMAGE_MIME: Record<string, string> = {
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif'
}

function cacheSet(key: string, value: string): string {
  if (cache.size >= MAX_CACHE) cache.clear()
  cache.set(key, value)
  return value
}

/** 单个路径的系统图标（dataURL，失败为空串） */
export async function fileIconDataUrl(p: string): Promise<string> {
  const hit = cache.get(p)
  if (hit !== undefined) return hit
  let custom: string | null = null
  try {
    if (fs.statSync(p).isDirectory()) custom = await customDirIcon(p)
  } catch {
    // stat 失败按普通文件处理
  }
  if (custom !== null) return cacheSet(p, custom)
  try {
    const icon = await app.getFileIcon(p, { size: 'small' })
    return cacheSet(p, icon.toDataURL())
  } catch {
    return cacheSet(p, '')
  }
}

/** 批量取图标（单次上限 64，防渲染层一次灌入过多） */
export async function fileIcons(paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const p of paths.slice(0, 64)) out[p] = await fileIconDataUrl(p)
  return out
}

/** 读目录的 desktop.ini，自定义图标指向图片文件时返回其 dataURL */
async function customDirIcon(dir: string): Promise<string | null> {
  let text: string
  try {
    const buf = fs.readFileSync(path.join(dir, 'desktop.ini'))
    // desktop.ini 常为 UTF-16LE（带 BOM），也可能 UTF-8/ANSI
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le', 2)
    else text = buf.toString('utf8')
  } catch {
    return null
  }

  // 只关心 [.ShellClassInfo] 段
  const section = text.split(/^\s*\[/m).find((s) => s.toLowerCase().startsWith('.shellclassinfo'))
  if (!section) return null
  const valueOf = (key: string): string | null => {
    const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'im'))
    return m ? m[1].trim() : null
  }

  const resource = valueOf('IconResource') ?? valueOf('IconFile')
  if (!resource) return null

  // 形如 "path",index 或 path,index（路径含引号时逗号可能属于路径本身）
  let file: string
  if (resource.startsWith('"')) {
    const end = resource.indexOf('"', 1)
    file = resource.slice(1, end > 0 ? end : undefined)
  } else {
    const cut = resource.lastIndexOf(',')
    file = cut > 0 ? resource.slice(0, cut) : resource
  }
  // 展开 %VAR% 环境变量
  file = file.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`)
  const ext = path.extname(file).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (!mime) return null
  try {
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}
