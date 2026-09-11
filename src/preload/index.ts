import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { CleanAction, DupeSeekApi, ScanSettings } from '../shared/types'

function subscribe<T>(channel: string): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const listener = (_: unknown, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

const api: DupeSeekApi = {
  selectTargets: (kind) => ipcRenderer.invoke('dialog:select-targets', kind),
  listDir: (path) => ipcRenderer.invoke('fs:list', path),
  places: () => ipcRenderer.invoke('fs:places'),
  reveal: (path) => ipcRenderer.invoke('fs:reveal', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  scanStart: (settings: ScanSettings) => ipcRenderer.invoke('scan:start', settings),
  scanStop: (sessionId) => ipcRenderer.send('scan:stop', sessionId),
  cleanRun: (action: CleanAction) => ipcRenderer.invoke('clean:run', action),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('app:set-settings', patch),

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
