import { spawn } from 'child_process'
import { app } from 'electron'
import { saveSettings } from './settings'

/**
 * 以管理员身份重启应用：保存续扫标记 → PowerShell Start-Process -Verb RunAs
 * 触发 UAC。运行中的进程无法原地提权，只能拉起新实例；新实例经
 * --handover-pid 等待本实例退出后再取单实例锁，成功后本实例自行退出。
 * 用户取消 UAC 或被策略拒绝时返回 false，应用继续以当前权限运行。
 */
export function elevateAndRestart(): Promise<boolean> {
  saveSettings({ resumeScan: true })

  const args: string[] = [`--handover-pid=${process.pid}`]
  if (!app.isPackaged) {
    // dev：electron.exe 需要应用目录参数；提权实例无法复用随旧实例
    // 退出的 dev server，先构建渲染层，新实例走 loadFile
    args.push(app.getAppPath())
  }

  const exe = process.execPath.replace(/'/g, "''")
  const list = args.map((a) => `'"${a.replace(/'/g, "''")}"'`).join(',')
  const script = `try { Start-Process -FilePath '${exe}' -ArgumentList @(${list}) -Verb RunAs; exit 0 } catch { exit 1 }`
  // EncodedCommand（UTF-16LE base64）规避路径空格与引号问题
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  const launch = (): Promise<boolean> =>
    new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
        windowsHide: true
      })
      child.on('exit', (code) => {
        const ok = code === 0
        if (ok) setTimeout(() => app.quit(), 500)
        resolve(ok)
      })
      child.on('error', () => resolve(false))
    })

  const buildRenderer = (): Promise<void> =>
    app.isPackaged
      ? Promise.resolve()
      : new Promise((resolve) => {
          // dev 提权实例无法使用随旧实例退出的 dev server，先构建最新渲染层（loadFile 使用）
          const child = spawn('npx electron-vite build', [], {
            windowsHide: true,
            cwd: app.getAppPath(),
            shell: true
          })
          child.on('exit', () => resolve())
          child.on('error', () => resolve())
        })

  return buildRenderer().then(launch)
}
