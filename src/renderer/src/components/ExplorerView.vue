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
      <button
        class="btn small"
        :class="{ primary: activeCount > 0 }"
        :disabled="activeCount === 0"
        title="把所有选中的项加入左侧扫描目标"
        @click="addActive"
      >
        添加到扫描{{ activeCount > 0 ? `（${activeCount}）` : '' }}
      </button>
      <span v-if="addedMsg" class="added-msg">{{ addedMsg }}</span>
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
          <ExplorerRow
            :entry="item as DirEntry"
            :active="selected.has((item as DirEntry).path)"
            @open="openEntry(item as DirEntry)"
            @toggle="toggleActive(item as DirEntry)"
          />
        </template>
      </VirtualScrollList>
      <div v-else class="empty">
        {{
          explorer.loading
            ? '加载中…'
            : explorer.cwd
              ? '空目录'
              : '选择一个目录开始浏览；点击名称进入，点击右侧属性选中'
        }}
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
import { computed, onMounted, ref, watch } from 'vue'
import type { DirEntry } from '../../../shared/types'
import { useExplorerStore } from '../stores/explorer'
import { useTargetStore } from '../stores/target'
import ExplorerRow from './ExplorerRow.vue'
import VirtualScrollList from './VirtualScrollList.vue'

const explorer = useExplorerStore()
const targetStore = useTargetStore()
const pathInput = ref('')

/** 选中（active）的条目路径；以 path 为键，虚拟滚动复用行不影响状态 */
const selected = ref<Set<string>>(new Set())
const addedMsg = ref('')
let addedTimer: ReturnType<typeof setTimeout> | undefined

const activeCount = computed(() => selected.value.size)

// 换目录后旧选中项不可见，保留会造成"隐形添加"，故清空
watch(
  () => explorer.cwd,
  () => {
    selected.value = new Set()
  }
)

function toggleActive(entry: DirEntry): void {
  const next = new Set(selected.value)
  if (next.has(entry.path)) next.delete(entry.path)
  else next.add(entry.path)
  selected.value = next
}

async function addActive(): Promise<void> {
  const paths = [...selected.value]
  if (paths.length === 0) return
  const added = await targetStore.add(paths)
  selected.value = new Set()
  addedMsg.value = added > 0 ? `已添加 ${added} 项` : '均已在目标列表中'
  clearTimeout(addedTimer)
  addedTimer = setTimeout(() => (addedMsg.value = ''), 2000)
}

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

.added-msg {
  color: var(--accent);
  white-space: nowrap;
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
