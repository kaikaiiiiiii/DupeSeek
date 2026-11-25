<template>
  <Teleport to="body">
    <div v-if="open" class="scrim" @click.self="emit('close')">
      <div class="panel" role="dialog" aria-modal="true" :aria-label="title">
        <div class="panel-title">{{ title }}</div>
        <div v-if="data === null" class="hint">统计中…</div>
        <template v-else>
          <div class="stat-rows">
            <div class="stat-line">
              <span class="k">总体积</span>
              <span class="v">{{ formatBytes(data.totalSize) }}</span>
            </div>
            <div class="stat-line">
              <span class="k">总文件数</span>
              <span class="v num">{{ data.fileCount.toLocaleString() }}</span>
            </div>
            <div class="stat-line">
              <span class="k">总文件夹数</span>
              <span class="v num">{{ data.dirCount.toLocaleString() }}</span>
            </div>
            <div class="stat-line">
              <span class="k">平均每文件体积</span>
              <span class="v">{{ formatBytes(data.avgSize) }}</span>
            </div>
          </div>

          <div class="chart-title">文件大小分布（k-means 分组）</div>
          <div v-if="data.histogram.length === 0" class="hint">该位置没有文件</div>
          <div v-else class="chart">
            <div
              v-for="(b, i) in data.histogram"
              :key="i"
              class="bar-col"
              :title="`${formatBytes(b.center)} 附近：${b.count.toLocaleString()} 个文件`"
            >
              <span class="bar-count">{{ b.count.toLocaleString() }}</span>
              <div class="bar-track">
                <div class="bar-fill" :style="{ '--h': barRatio(b.count) }"></div>
              </div>
              <span class="bar-label">{{ formatBytes(b.center) }}</span>
            </div>
          </div>
        </template>
        <div class="panel-actions">
          <button class="btn" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { BranchStats } from '../../../shared/types'
import { baseName, formatBytes } from '../utils/format'

const props = defineProps<{ open: boolean; path: string }>()

const emit = defineEmits<{ close: [] }>()

const data = ref<BranchStats | null>(null)

const title = computed(() => `统计数据 — ${baseName(props.path) || props.path}`)
const maxCount = computed(() =>
  data.value === null ? 0 : Math.max(...data.value.histogram.map((b) => b.count), 1)
)

/** 柱高按成员数等比例（CSS 变量驱动，与树体积条同一模式） */
function barRatio(count: number): string {
  return `${Math.max(2, Math.round((count / maxCount.value) * 100))}%`
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    data.value = null
    window.addEventListener('keydown', onKey)
    try {
      data.value = await window.api.treeStats(props.path)
    } catch {
      data.value = null
    }
  }
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 560px;
  max-width: calc(100vw - 48px);
  padding: 20px 24px;
}

.panel-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 14px;
  word-break: break-all;
}

.stat-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stat-line {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.stat-line .k {
  width: 110px;
  flex-shrink: 0;
  color: var(--muted);
}

.stat-line .v {
  font-weight: 600;
}

.stat-line .v.num {
  font-variant-numeric: tabular-nums;
}

.chart-title {
  margin: 16px 0 8px;
  color: var(--muted);
  font-size: 12px;
}

.hint {
  color: var(--muted);
  padding: 8px 0;
}

.chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 150px;
}

.bar-col {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.bar-count {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.bar-track {
  width: 100%;
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

/* 柱体高度由数据驱动的 --h 变量决定 */
.bar-fill {
  width: 64%;
  height: var(--h, 0%);
  background: var(--accent);
  border-radius: 3px 3px 0 0;
  opacity: 0.85;
}

.bar-label {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.panel-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}
</style>
