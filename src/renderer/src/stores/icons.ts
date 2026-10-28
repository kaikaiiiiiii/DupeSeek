import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 虚拟滚动只挂载可见行：行内组件 onMounted 时请求，未可见的路径不会产生开销。
 *  请求按 120ms 合批；主进程侧另有 path → 图标 缓存 */
export const useIconStore = defineStore('icons', () => {
  const cache = ref<Record<string, string>>({})
  const pending = new Set<string>()
  let timer: number | undefined

  function request(path: string): void {
    if (cache.value[path] !== undefined || pending.has(path)) return
    pending.add(path)
    if (timer === undefined) timer = window.setTimeout(flush, 120)
  }

  async function flush(): Promise<void> {
    timer = undefined
    const paths = [...pending]
    pending.clear()
    if (paths.length === 0) return
    try {
      const res = await window.api.fileIcons(paths)
      cache.value = { ...cache.value, ...res }
    } catch {
      // 取图标失败不致命：行内保持占位符
    }
  }

  return { cache, request }
})
