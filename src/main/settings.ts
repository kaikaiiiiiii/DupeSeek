import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { defaultScanDraft } from '../shared/defaults'
import type { AppSettings, ScanSettings } from '../shared/types'

function defaults(): AppSettings {
  return {
    targets: [],
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
    const scanDraft: ScanSettings = { ...base.scanDraft, ...(raw.scanDraft ?? {}) }
    // 旧版布尔开关迁移：用户曾关闭「忽略 node_modules」→ 名称排除列表置空
    if (scanDraft.excludeDirNames === base.scanDraft.excludeDirNames) {
      const legacy = (raw.scanDraft as Record<string, unknown> | undefined)?.excludeNodeModules
      if (legacy === false) scanDraft.excludeDirNames = ''
    }
    cached = {
      targets: Array.isArray(raw.targets) ? raw.targets : base.targets,
      scanDraft,
      resumeScan: raw.resumeScan === true
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
