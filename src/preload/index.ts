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
  selectTargets: (kind) => ipcRenderer.invoke('dialog:select-targets', kind),
  listDir: (path) => ipcRenderer.invoke('fs:list', path),
  places: () => ipcRenderer.invoke('fs:places'),
  reveal: (path) => ipcRenderer.invoke('fs:reveal', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  scanStart: (settings) => ipcRenderer.invoke('scan:start', plainJson(settings)),
  scanStop: (sessionId) => ipcRenderer.send('scan:stop', sessionId),
  cleanRun: (action) => ipcRenderer.invoke('clean:run', plainJson(action)),
  elevate: () => ipcRenderer.invoke('app:elevate'),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('app:set-settings', plainJson(patch)),

  onScanProgress: subscribe('scan:progress'),
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
