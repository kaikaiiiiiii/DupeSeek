import { ElectronAPI } from '@electron-toolkit/preload'

type ReadDirResult =
  | { success: true; dirs: string[]; files: string[] }
  | { success: false; error: string }

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      readDir: (path: string) => Promise<ReadDirResult>
    }
  }
}
