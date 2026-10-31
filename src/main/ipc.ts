import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { AppSettings, CleanAction, ScanSettings, TreeSortKey } from '../shared/types'
import { runClean } from './clean'
import { detectCapabilities } from './capabilities'
import { elevateAndRestart } from './elevate'
import { fileIcons } from './icons'
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

  ipcMain.handle('fs:reveal', (_e, p: string) => shell.showItemInFolder(p))

  ipcMain.handle('scan:sync', async (_e, settings: ScanSettings) => engine.syncTargets(settings))
  ipcMain.handle('scan:rescan', async (_e, settings: ScanSettings) => engine.rescanAll(settings))
  ipcMain.on('scan:stop', () => engine.stop())

  ipcMain.handle('clean:run', (_e, action: CleanAction) => runClean(action))
  ipcMain.handle('app:elevate', () => elevateAndRestart())

  ipcMain.handle('app:get-settings', () => loadSettings())
  ipcMain.handle('app:set-settings', (_e, patch: Partial<AppSettings>) => saveSettings(patch))
  ipcMain.handle('app:capabilities', () => detectCapabilities())
  ipcMain.handle('app:file-icons', (_e, paths: string[]) => fileIcons(paths))
  // 主题切换时同步 Win11 标题栏按钮配色（未启用 overlay 的环境忽略）
  ipcMain.handle('app:overlay-theme', (_e, dark: boolean) => {
    const win = getWindow()
    if (process.platform === 'win32' && win && !win.isDestroyed()) {
      try {
        win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#f2f2f2' : '#1a1a1a', height: 36 })
      } catch {
        /* titleBarOverlay 未启用 */
      }
    }
  })
  ipcMain.handle('tree:roots', (_e, sortKey: TreeSortKey, desc: boolean) =>
    engine.treeRoots(sortKey, desc)
  )
  ipcMain.handle('tree:children', (_e, dir: string, sortKey: TreeSortKey, desc: boolean) =>
    engine.treeChildren(dir, sortKey, desc)
  )
  ipcMain.handle(
    'tree:files',
    (_e, dir: string, sortKey: TreeSortKey, desc: boolean, offset: number, limit: number) =>
      engine.treeFiles(dir, sortKey, desc, offset, limit)
  )
}
