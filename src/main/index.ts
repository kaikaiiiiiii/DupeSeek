import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { closeHashPool } from './scan/hashPool'
import { registerIpc } from './ipc'

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

// 单实例锁：提权重启时新旧实例可能短暂交叠，等待旧实例释放锁（最多 ~8s）
if (app.requestSingleInstanceLock()) {
  boot()
} else {
  let retries = 0
  const timer = setInterval(() => {
    retries++
    if (app.requestSingleInstanceLock()) {
      clearInterval(timer)
      boot()
    } else if (retries > 16) {
      clearInterval(timer)
      app.quit()
    }
  }, 500)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  closeHashPool()
})
