import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import type { AppSettings, CleanAction, DirEntry, ScanSettings } from '../shared/types'
import { runClean } from './clean'
import { places } from './places'
import { loadSettings, saveSettings } from './settings'
import { ScanEngine } from './scan/engine'

type OpenKind = 'dir' | 'file' | 'both'

function dialogProperties(kind: OpenKind): Array<'openFile' | 'openDirectory' | 'multiSelections'> {
  const props: Array<'openFile' | 'openDirectory' | 'multiSelections'> = ['multiSelections']
  if (kind === 'dir') props.push('openDirectory')
  else if (kind === 'file') props.push('openFile')
  else props.push('openFile', 'openDirectory')
  return props
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const engine = new ScanEngine((channel, payload) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  })

  ipcMain.handle('dialog:select-targets', async (_e, kind: OpenKind) => {
    const win = getWindow()
    const options = { properties: dialogProperties(kind) }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    return result.filePaths
  })

  ipcMain.handle('fs:list', async (_e, dirPath: string) => {
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true })
    const entries: DirEntry[] = []
    for (const d of dirents) {
      const full = path.join(dirPath, d.name)
      if (d.isDirectory()) {
        entries.push({ name: d.name, path: full, isDir: true, size: 0, mtime: 0, class: '' })
      } else if (d.isFile()) {
        try {
          const st = await fs.promises.lstat(full)
          const i = d.name.lastIndexOf('.')
          entries.push({
            name: d.name,
            path: full,
            isDir: false,
            size: st.size,
            mtime: Math.floor(st.mtimeMs),
            class: i > 0 ? d.name.slice(i) : ''
          })
        } catch {
          // 文件可能刚被删除或不可访问，跳过
        }
      }
    }
    return entries
  })

  ipcMain.handle('fs:places', () => places())
  ipcMain.handle('fs:reveal', (_e, p: string) => shell.showItemInFolder(p))

  ipcMain.handle('scan:start', async (_e, settings: ScanSettings) => engine.start(settings))
  ipcMain.on('scan:stop', () => engine.stop())

  ipcMain.handle('clean:run', (_e, action: CleanAction) => runClean(action))

  ipcMain.handle('app:get-settings', () => loadSettings())
  ipcMain.handle('app:set-settings', (_e, patch: Partial<AppSettings>) => saveSettings(patch))
}
