<template>
  <div class="explorer">
    <div class="toolbar">
      <button class="btn small" :disabled="!canBack" @click="explorer.back()">◀</button>
      <button class="btn small" :disabled="!canForward" @click="explorer.forward()">▶</button>
      <nav class="breadcrumb">
        <template v-for="(part, i) in crumbs" :key="part.path">
          <button
            class="crumb"
            :class="{ current: i === crumbs.length - 1 }"
            @click="go(part.path)"
          >
            {{ part.label }}
          </button>
          <span v-if="i < crumbs.length - 1" class="sep">›</span>
        </template>
      </nav>
      <button class="btn small" :disabled="!explorer.cwd" @click="explorer.addFavorite()">
        ★ 收藏
      </button>
    </div>

    <div class="places">
      <div
        v-for="fav in explorer.places"
        :key="fav.path"
        class="place-chip"
        :title="fav.path"
        @click="go(fav.path)"
      >
        <span class="place-icon">{{
          fav.path.endsWith('\\') || fav.path === '/' ? '💾' : '📁'
        }}</span>
        <span class="place-label">{{ fav.label }}</span>
        <span
          v-if="!fav.builtin"
          class="chip-remove"
          title="移除收藏"
          @click.stop="explorer.removeFavorite(fav.path)"
          >×</span
        >
      </div>
    </div>

    <div v-if="explorer.error" class="error-banner">{{ explorer.error }}</div>

    <div class="list-area">
      <VirtualScrollList
        v-if="explorer.entries.length > 0"
        :items="explorer.entries"
        :item-size="30"
      >
        <template #default="{ item }">
          <div class="dir-row" @click="openEntry(item as DirEntry)">
            <span class="entry-icon">{{ (item as DirEntry).isDir ? '📁' : '📄' }}</span>
            <span class="entry-name" :title="(item as DirEntry).path">{{
              (item as DirEntry).name
            }}</span>
            <span class="entry-mtime">{{ formatTime((item as DirEntry).mtime) }}</span>
            <span class="entry-class">{{ (item as DirEntry).class || '—' }}</span>
            <span class="entry-size">{{
              (item as DirEntry).isDir ? '' : formatBytes((item as DirEntry).size)
            }}</span>
          </div>
        </template>
      </VirtualScrollList>
      <div v-else class="empty">
        {{ explorer.loading ? '加载中…' : explorer.cwd ? '空目录' : '选择一个目录开始浏览' }}
      </div>
    </div>

    <div class="path-bar">
      <input
        v-model="pathInput"
        class="input grow"
        placeholder="输入目录路径后回车"
        @keyup.enter="go(pathInput)"
      />
      <button class="btn primary" @click="go(pathInput)">转到</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { DirEntry } from '../../../shared/types'
import { useExplorerStore } from '../stores/explorer'
import { formatBytes, formatTime } from '../utils/format'
import VirtualScrollList from './VirtualScrollList.vue'

const explorer = useExplorerStore()
const pathInput = ref('')

const canBack = computed(() => explorer.cursor > 0 && !explorer.loading)
const canForward = computed(
  () => explorer.cursor < explorer.history.length - 1 && !explorer.loading
)

interface Crumb {
  label: string
  path: string
}

const crumbs = computed<Crumb[]>(() => {
  const p = explorer.cwd
  if (!p) return []
  const parts = p.split(/[\\/]+/).filter((s) => s !== '')
  const list: Crumb[] = []
  // Windows 盘符（如 C:）与首段合并为根
  let acc = ''
  for (let i = 0; i < parts.length; i++) {
    acc = acc === '' ? parts[i] : `${acc}\\${parts[i]}`
    if (i === 0 && parts[0].endsWith(':')) {
      acc = `${acc}\\`
    }
    list.push({ label: parts[i], path: acc })
  }
  return list
})

onMounted(async () => {
  await explorer.loadPlaces()
  if (!explorer.cwd) {
    const home = explorer.places.find((f) => f.label === '用户目录') ?? explorer.places[0]
    if (home) await explorer.open(home.path)
  }
})

function go(path: string): void {
  const p = path.trim()
  if (p !== '') void explorer.open(p)
}

function openEntry(entry: DirEntry): void {
  if (entry.isDir) void explorer.open(entry.path)
}
</script>

<style scoped>
.explorer {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.breadcrumb {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
}

.crumb {
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
  padding: 2px 4px;
}

.crumb.current {
  color: var(--text);
  font-weight: 600;
}

.sep {
  color: var(--muted);
}

.places {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.place-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  user-select: none;
}

.place-chip:hover {
  background: var(--hover-bg);
}

.place-label {
  max-width: 120px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip-remove {
  color: var(--muted);
  font-weight: 700;
}

.chip-remove:hover {
  color: var(--danger);
}

.error-banner {
  margin: 6px 8px 0;
  padding: 6px 10px;
  border: 1px solid var(--danger);
  border-radius: 4px;
  color: var(--danger);
}

.list-area {
  flex: 1;
  min-height: 0;
}

.dir-row {
  height: 30px;
  display: grid;
  grid-template-columns: 24px 1fr 140px 60px 80px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-light);
  cursor: default;
  box-sizing: border-box;
}

.dir-row:hover {
  background: var(--hover-bg);
}

.entry-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.entry-mtime,
.entry-size {
  color: var(--muted);
  font-size: 12px;
  text-align: right;
}

.entry-class {
  color: var(--muted);
  font-size: 12px;
}

.path-bar {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--border);
}

.grow {
  flex: 1;
}
</style>
