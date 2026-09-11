import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppSettings } from '../../../shared/types'
import { deepPlain } from '../utils/plain'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings | null>(null)

  async function load(): Promise<AppSettings> {
    settings.value = await window.api.getSettings()
    return settings.value
  }

  async function patch(p: Partial<AppSettings>): Promise<void> {
    settings.value = await window.api.setSettings(deepPlain(p))
  }

  return { settings, load, patch }
})
