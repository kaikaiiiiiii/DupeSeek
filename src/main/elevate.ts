import { spawn } from 'child_process'
import { app } from 'electron'
import { saveSettings } from './settings'

/**
 * 以管理员身份重启应用：保存续扫标记 → PowerShell Start-Process -Verb RunAs
 * 触发 UAC。运行中的进程无法原地提权，只能拉起新实例；成功后旧实例自行退出。
 * 用户取消 UAC 或被策略拒绝时返回 false，应用继续以当前权限运行。
 */
export function elevateAndRestart(): Promise<boolean> {
  saveSettings({ resumeScan: true })
  const exe = process.execPath.replace(/'/g, "''")
  // dev 模式下 process.execPath 是 electron.exe，需要附带应用目录参数
  const appArgs = app.isPackaged ? '' : ` -ArgumentList '${app.getAppPath().replace(/'/g, "''")}'`
  const script = `try { Start-Process -FilePath '${exe}'${appArgs} -Verb RunAs; exit 0 } catch { exit 1 }`
  // EncodedCommand（UTF-16LE base64）规避路径空格与引号问题
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
      windowsHide: true
    })
    child.on('exit', (code) => {
      const ok = code === 0
      if (ok) setTimeout(() => app.quit(), 800)
      resolve(ok)
    })
    child.on('error', () => resolve(false))
  })
}
