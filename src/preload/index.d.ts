import type { ElectronAPI } from '@electron-toolkit/preload'
import type { DupeSeekApi } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: DupeSeekApi
  }
}
