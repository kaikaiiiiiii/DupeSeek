import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { DirEntry, FavoriteItem } from '../../../shared/types'
import { baseName } from '../utils/format'
import { useSettingsStore } from './settings'

function sortEntries(list: DirEntry[]): DirEntry[] {
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

export const useExplorerStore = defineStore('explorer', () => {
  const cwd = ref('')
  const entries = ref<DirEntry[]>([])
  const loading = ref(false)
  const error = ref('')
  const history = ref<string[]>([])
  const cursor = ref(-1)
  const drives = ref<FavoriteItem[]>([])
  const userFavorites = ref<FavoriteItem[]>([])

  const places = computed<FavoriteItem[]>(() => [...userFavorites.value, ...drives.value])

  async function loadPlaces(): Promise<void> {
    const res = await window.api.places()
    drives.value = res.drives
    userFavorites.value = res.favorites
    const saved = useSettingsStore().settings?.favorites ?? []
    userFavorites.value = [...saved, ...userFavorites.value]
  }

  async function load(path: string): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const list = await window.api.listDir(path)
      cwd.value = path
      entries.value = sortEntries(list)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  /** 前进式导航：载入目录并写入历史 */
  async function open(path: string): Promise<void> {
    await load(path)
    if (cwd.value === path) {
      history.value = [...history.value.slice(0, cursor.value + 1), path]
      cursor.value = history.value.length - 1
    }
  }

  async function back(): Promise<void> {
    if (cursor.value > 0) await load(history.value[--cursor.value])
  }

  async function forward(): Promise<void> {
    if (cursor.value < history.value.length - 1) await load(history.value[++cursor.value])
  }

  async function refresh(): Promise<void> {
    if (cwd.value) await open(cwd.value)
  }

  async function addFavorite(): Promise<void> {
    if (!cwd.value) return
    const item: FavoriteItem = { label: baseName(cwd.value), path: cwd.value, builtin: false }
    if (userFavorites.value.some((f) => f.path === cwd.value)) return
    userFavorites.value = [...userFavorites.value, item]
    await useSettingsStore().patch({ favorites: userFavorites.value.filter((f) => !f.builtin) })
  }

  async function removeFavorite(path: string): Promise<void> {
    userFavorites.value = userFavorites.value.filter((f) => f.path !== path)
    await useSettingsStore().patch({ favorites: userFavorites.value.filter((f) => !f.builtin) })
  }

  return {
    cwd,
    entries,
    loading,
    error,
    history,
    cursor,
    drives,
    places,
    loadPlaces,
    open,
    back,
    forward,
    refresh,
    addFavorite,
    removeFavorite
  }
})
