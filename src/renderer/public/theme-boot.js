// 主题启动引导：必须在 main.ts 模块执行前同步设置 data-theme，避免首帧闪色
;(function () {
  try {
    var mode = localStorage.getItem('dupeseek-theme') || 'system'
    var dark =
      mode === 'dark' ||
      (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    if (window.api && window.api.mica) document.documentElement.classList.add('mica')
  } catch (e) {
    /* 主题探测失败按亮色渲染 */
  }
})()
