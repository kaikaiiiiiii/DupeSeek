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
    </div>
  </div>
</template>

<script setup lang="ts">
import { useScanStore } from '../stores/scan'
import { useSettingsStore } from '../stores/settings'
import { deepPlain } from '../utils/plain'

const scan = useScanStore()

/** 即时生效：写入扫描草稿并立刻持久化，下一次扫描开始时生效 */
function setUseEverything(v: boolean): void {
  scan.draft.useEverything = v
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
</style>
