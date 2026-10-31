export type ThemeMode = 'system' | 'light' | 'dark'

const KEY = 'dupeseek-theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

export function themeMode(): ThemeMode {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

function resolve(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'dark' || (mode === 'system' && media.matches) ? 'dark' : 'light'
}

function applyResolved(mode: ThemeMode): void {
  const resolved = resolve(mode)
  document.documentElement.dataset.theme = resolved
  document.documentElement.classList.toggle('mica', !!window.api.mica)
  // Win11 标题栏按钮配色随主题同步（非 Windows / 未启用 overlay 时主进程忽略）
  void window.api.setOverlayTheme(resolved === 'dark').catch(() => {})
}

export function applyTheme(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode)
  applyResolved(mode)
}

/** 应用启动时调用：按持久化模式（默认跟随系统）应用并监听系统主题变化 */
export function initTheme(): void {
  applyResolved(themeMode())
  media.addEventListener('change', () => {
    if (themeMode() === 'system') applyResolved('system')
  })
}
