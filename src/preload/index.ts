import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { DupeSeekApi } from '../shared/types'

function subscribe<T>(channel: string): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const listener = (_: unknown, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

/** contextBridge 无法序列化 Vue 的响应式 Proxy；IPC 契约是纯 JSON，入口统一拍平 */
function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const api: DupeSeekApi = {
  platform: process.platform,
  mica: process.env['DUPESEEK_MICA'] === '1',
  selectTargets: (kind) => ipcRenderer.invoke('dialog:select-targets', kind),
  reveal: (path) => ipcRenderer.invoke('fs:reveal', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  setOverlayTheme: (dark) => ipcRenderer.invoke('app:overlay-theme', dark),
  scanSync: (settings) => ipcRenderer.invoke('scan:sync', plainJson(settings)),
  scanRescan: (settings) => ipcRenderer.invoke('scan:rescan', plainJson(settings)),
  scanStop: (sessionId) => ipcRenderer.send('scan:stop', sessionId),
  cleanRun: (action) => ipcRenderer.invoke('clean:run', plainJson(action)),
  elevate: () => ipcRenderer.invoke('app:elevate'),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('app:set-settings', plainJson(patch)),
  capabilities: () => ipcRenderer.invoke('app:capabilities'),
  fileIcons: (paths) => ipcRenderer.invoke('app:file-icons', paths),
  treeRoots: (sortKey, desc) => ipcRenderer.invoke('tree:roots', sortKey, desc),
  treeChildren: (dir, sortKey, desc) => ipcRenderer.invoke('tree:children', dir, sortKey, desc),
  treeFiles: (dir, sortKey, desc, offset, limit) =>
    ipcRenderer.invoke('tree:files', dir, sortKey, desc, offset, limit),

  onScanProgress: subscribe('scan:progress'),
  onTreeRev: subscribe('scan:rev'),
  onScanGroup: subscribe('scan:group'),
  onScanDone: subscribe('scan:done'),
  onScanError: subscribe('scan:error')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
