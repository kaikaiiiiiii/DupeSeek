import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { FavoriteItem } from '../shared/types'

const DRIVE_TIMEOUT_MS = 800

async function probeDrive(letter: string): Promise<FavoriteItem | null> {
  const p = `${letter}:\\`
  try {
    await Promise.race([
      fs.promises.access(p),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), DRIVE_TIMEOUT_MS))
    ])
    return { label: `${letter}:`, path: p, builtin: true }
  } catch {
    return null
  }
}

/** 预置目录与盘符列表，用于 Explorer 的快速导航区 */
export async function places(): Promise<{ favorites: FavoriteItem[]; drives: FavoriteItem[] }> {
  const home = app.getPath('home')
  const builtinNames: Array<[string, 'desktop' | 'documents' | 'downloads']> = [
    ['桌面', 'desktop'],
    ['文档', 'documents'],
    ['下载', 'downloads']
  ]
  const favorites: FavoriteItem[] = builtinNames
    .map(([label, key]) => {
      try {
        return { label, path: app.getPath(key), builtin: true }
      } catch {
        return null
      }
    })
    .filter((v): v is FavoriteItem => v !== null)
  favorites.unshift({ label: '用户目录', path: home, builtin: true })

  let drives: FavoriteItem[] = []
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const probed = await Promise.all(letters.map(probeDrive))
    drives = probed.filter((v): v is FavoriteItem => v !== null)
  } else {
    drives = [{ label: '/', path: '/', builtin: true }]
  }
  return { favorites, drives }
}

/** 收藏目录的显示名：取路径末段 */
export function favoriteLabel(dirPath: string): string {
  const trimmed = dirPath.replace(/[\\/]+$/, '')
  const seg = path.basename(trimmed)
  return seg || trimmed
}
