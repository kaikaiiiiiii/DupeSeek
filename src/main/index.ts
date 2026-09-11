import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { closeHashPool } from './scan/hashPool'
import { registerIpc } from './ipc'

// stdio 加固：启动本应用的终端/父进程退出后，stdout/stderr 写入会 EPIPE。
// 挂 no-op error 监听并全局兜底，避免未捕获异常弹窗中断应用。
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (): void => undefined)
}
process.on('uncaughtException', (err): void => {
  if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') return
  try {
    console.error('[main] 未捕获异常', err)
  } catch {
    /* stdio 已断开 */
  }
})
process.on('unhandledRejection', (reason): void => {
  try {
    console.error('[main] 未处理的 Promise 拒绝', reason)
  } catch {
    /* stdio 已断开 */
  }
})

// 提权重启交接：新实例从命令行拿到旧实例 PID 与一次性续扫标记
function argValue(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`))
  return hit?.split('=').slice(1).join('=')
}
const handoverPid = Number(argValue('--handover-pid'))

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'DupeSeek',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (is.dev) mainWindow.webContents.openDevTools({ mode: 'bottom' })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function boot(): void {
  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.dupeseek')

    // worker 线程也要能定位随应用分发的二进制（es.exe / UnRAR.exe）
    process.env['DUPESEEK_BIN_DIR'] = app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'bin')
      : join(app.getAppPath(), 'resources', 'bin')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const mainWindow = createWindow()
    let currentWindow: BrowserWindow | null = mainWindow
    registerIpc(() => currentWindow)

    app.on('second-instance', () => {
      if (currentWindow && !currentWindow.isDestroyed()) {
        if (currentWindow.isMinimized()) currentWindow.restore()
        currentWindow.focus()
      }
    })

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) currentWindow = createWindow()
    })
  })
}

// 提权重启交接：先轮询等旧实例（按 PID）退出，再获取单实例锁（确定性，无竞态）
async function waitForHandover(): Promise<void> {
  if (!Number.isFinite(handoverPid) || handoverPid <= 0) return
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(handoverPid, 0)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

void (async () => {
  await waitForHandover()
  if (app.requestSingleInstanceLock()) {
    boot()
  } else {
    app.quit()
  }
})()

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  closeHashPool()
})
