import fs from 'fs'
import path from 'path'
import type { FileEntry, ScanSettings } from '../../shared/types'

/** Windows 上默认排除的系统目录名 */
const SYSTEM_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'WindowsApps'])

export interface WalkContext {
  settings: ScanSettings
  canceled: () => boolean
  onEntry: (entry: FileEntry) => void
  onDir: (dirPath: string) => void
  onError: (p: string, err: unknown) => void
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i) : ''
}

function extAllowed(cls: string, settings: ScanSettings): boolean {
  const ext = cls.replace(/^\./, '').toLowerCase()
  if (settings.extBlacklist.some((b) => b.toLowerCase() === ext)) return false
  if (
    settings.extWhitelist.length > 0 &&
    !settings.extWhitelist.some((w) => w.toLowerCase() === ext)
  ) {
    return false
  }
  return true
}

async function collectFile(fullPath: string, name: string, ctx: WalkContext): Promise<void> {
  const { settings } = ctx
  if (settings.excludeHidden && name.startsWith('.')) return
  const cls = extOf(name)
  if (!extAllowed(cls, settings)) return
  try {
    const st = await fs.promises.lstat(fullPath)
    if (settings.minSize !== null && st.size < settings.minSize) return
    if (settings.maxSize !== null && st.size > settings.maxSize) return
    ctx.onEntry({
      path: fullPath,
      name,
      size: st.size,
      class: cls,
      mtime: Math.floor(st.mtimeMs),
      headmd5: null,
      fullmd5: null
    })
  } catch (err) {
    ctx.onError(fullPath, err)
  }
}

/** 迭代式递归遍历所有目标目录，产出符合条件的文件条目 */
export async function walkTargets(roots: string[], ctx: WalkContext): Promise<void> {
  const stack = [...roots]
  const visited = new Set<string>()

  while (stack.length > 0) {
    if (ctx.canceled()) return
    const dir = stack.pop() as string
    if (visited.has(dir)) continue
    visited.add(dir)
    ctx.onDir(dir)

    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (err) {
      ctx.onError(dir, err)
      continue
    }

    for (const d of dirents) {
      if (ctx.canceled()) return
      const full = path.join(dir, d.name)
      if (d.isDirectory()) {
        if (settingsExcludesDir(d.name, ctx.settings)) continue
        // junction / 目录符号链接按设置跳过；lstat 才能识别链接本身
        if (ctx.settings.excludeJunction) {
          try {
            const st = await fs.promises.lstat(full)
            if (st.isSymbolicLink()) continue
          } catch {
            continue
          }
        }
        stack.push(full)
      } else if (d.isFile()) {
        await collectFile(full, d.name, ctx)
      }
    }
  }
}

function settingsExcludesDir(name: string, settings: ScanSettings): boolean {
  if (settings.excludeHidden && name.startsWith('.')) return true
  if (settings.excludeSystem && SYSTEM_DIRS.has(name)) return true
  return false
}
