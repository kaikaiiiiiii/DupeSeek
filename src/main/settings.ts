import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { defaultScanDraft } from '../shared/defaults'
import type { AppSettings } from '../shared/types'

function defaults(): AppSettings {
  return {
    targets: [],
    favorites: [],
    scanDraft: defaultScanDraft()
  }
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

let cached: AppSettings | null = null

export function loadSettings(): AppSettings {
  if (cached) return cached
  const base = defaults()
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Partial<AppSettings>
    cached = {
      targets: Array.isArray(raw.targets) ? raw.targets : base.targets,
      favorites: Array.isArray(raw.favorites) ? raw.favorites : base.favorites,
      scanDraft: { ...base.scanDraft, ...(raw.scanDraft ?? {}) }
    }
  } catch {
    cached = base
  }
  return cached
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...patch }
  cached = merged
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(merged, null, 2), 'utf-8')
  } catch {
    // 设置写盘失败不阻断功能，下次启动回到默认
  }
  return merged
}
