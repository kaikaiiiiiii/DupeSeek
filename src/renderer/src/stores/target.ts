import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSettingsStore } from './settings'

export const useTargetStore = defineStore('target', () => {
  const targets = ref<string[]>([])

  /** 启动时用持久化的目标列表初始化 */
  function init(list: string[]): void {
    targets.value = [...list]
  }

  async function add(paths: string[]): Promise<number> {
    const fresh = paths.filter((p) => !targets.value.includes(p))
    if (fresh.length > 0) {
      targets.value = [...targets.value, ...fresh]
      await useSettingsStore().patch({ targets: targets.value })
    }
    return fresh.length
  }

  async function remove(path: string): Promise<void> {
    targets.value = targets.value.filter((t) => t !== path)
    await useSettingsStore().patch({ targets: targets.value })
  }

  async function clear(): Promise<void> {
    targets.value = []
    await useSettingsStore().patch({ targets: targets.value })
  }

  return { targets, init, add, remove, clear }
})
