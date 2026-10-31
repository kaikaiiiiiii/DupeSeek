<template>
  <div class="settings-view">
    <div class="settings-card">
      <div class="card-title">扫描</div>
      <label class="check-row">
        <input
          type="checkbox"
          :checked="scan.draft.useEverything"
          @change="setUseEverything(($event.target as HTMLInputElement).checked)"
        />
        使用本机 Everything 加快扫描
      </label>
      <p class="hint">
        勾选时，若 Everything
        正在运行则用其索引枚举文件（未运行自动回退常规遍历）；取消勾选则始终常规遍历。改动即时保存，对下一次扫描生效，不打断进行中的扫描。
      </p>
      <div class="card-subtitle">压缩包</div>
      <label class="check-row">
        <input
          type="checkbox"
          :checked="scan.draft.scanArchives"
          @change="setScanArchives(($event.target as HTMLInputElement).checked)"
        />
        解析压缩包内容（zip/7z/rar）
      </label>
      <p class="hint">
        勾选时，压缩包内的文件参与查重（压缩包本身始终作为普通文件参与）；取消勾选则压缩包视作普通文件，只比对包文件本身。改动即时保存，对下一次扫描生效，不打断进行中的扫描。
      </p>
    </div>
    <div class="settings-card">
      <div class="card-title">能力检测</div>
      <div class="text-row">
        <label class="text-label">主题</label>
        <select class="input" :value="themeSel" @change="onThemeChange">
          <option value="system">跟随系统</option>
          <option value="light">亮色</option>
          <option value="dark">暗色</option>
        </select>
      </div>
      <div class="cap-row">
        <span class="cap-label">RAR 内容读取（内置 unrar）</span>
        <span v-if="caps === null" class="cap-value">检测中…</span>
        <span
          v-else-if="caps.rar.bundledExtract"
          class="cap-value ok"
          :title="caps.rar.bundledExtract"
          >可用</span
        >
        <span v-else class="cap-value bad">不可用</span>
      </div>
      <div class="cap-row">
        <span class="cap-label">RAR 压缩（本机 WinRAR / rar）</span>
        <span v-if="caps === null" class="cap-value">检测中…</span>
        <span v-else-if="caps.rar.compress" class="cap-value ok" :title="caps.rar.compress"
          >已安装</span
        >
        <span v-else class="cap-value">未检测到</span>
      </div>
      <p class="hint">
        内置 unrar 随应用分发（Windows / Linux / macOS 各一份），作为读取 RAR 包内容的默认能力。
        压缩工具仅作检测展示——应用本身不提供压缩功能，未检测到不影响任何扫描能力。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AppCapabilities } from '../../../shared/types'
import { applyTheme, themeMode, type ThemeMode } from '../utils/theme'
import { useScanStore } from '../stores/scan'
import { useSettingsStore } from '../stores/settings'
import { deepPlain } from '../utils/plain'

const scan = useScanStore()

/** 本机能力检测结果（进入设置页时探测一次） */
const caps = ref<AppCapabilities | null>(null)
const themeSel = ref<ThemeMode>(themeMode())

function onThemeChange(ev: Event): void {
  themeSel.value = (ev.target as HTMLSelectElement).value as ThemeMode
  applyTheme(themeSel.value)
}
onMounted(() => {
  void window.api.capabilities().then((c) => {
    caps.value = c
  })
})

/** 即时生效：写入扫描草稿并立刻持久化，下一次扫描开始时生效 */
function setUseEverything(v: boolean): void {
  scan.draft.useEverything = v
  void useSettingsStore().patch({ scanDraft: deepPlain(scan.draft) })
}

function setScanArchives(v: boolean): void {
  scan.draft.scanArchives = v
  void useSettingsStore().patch({ scanDraft: deepPlain(scan.draft) })
}
</script>

<style scoped>
.settings-view {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.settings-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  padding: 12px;
}

.card-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.card-subtitle {
  font-weight: 600;
  margin: 10px 0 6px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  cursor: pointer;
}

.hint {
  margin: 8px 0 0 20px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.cap-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.cap-label {
  color: var(--muted);
}

.cap-value {
  min-width: 60px;
}

.cap-value.ok {
  color: var(--ok);
  font-weight: 600;
}

.cap-value.bad {
  color: var(--danger);
  font-weight: 600;
}
</style>
