<template>
  <div class="dupe-list">
    <div class="toolbar">
      <span class="stat"
        >共 {{ dupe.visibleGroups.length }} 组 · 可释放 {{ formatBytes(dupe.totalWasted) }}</span
      >
      <select v-model="rule" class="input">
        <option value="first">每组保留首个</option>
        <option value="oldest">每组保留最早的</option>
        <option value="newest">每组保留最新的</option>
        <option value="shortestPath">每组保留路径最短的</option>
      </select>
      <button class="btn" @click="dupe.applyKeepRule(rule as KeepRule)">应用选择器</button>
      <button class="btn danger" :disabled="!canClean" @click="clean">删除所选（进回收站）</button>
    </div>

    <div class="filter-row">
      <input v-model="dupe.filter.class" class="input" placeholder="扩展名筛选，如 .jpg" />
      <input v-model="dupe.filter.pathIncludes" class="input grow" placeholder="路径包含…" />
      <input
        v-model.number="filterMB"
        class="input num"
        type="number"
        min="0"
        placeholder="最小 MB"
      />
    </div>

    <div v-if="dupe.lastReport" class="report">
      已清理 {{ dupe.lastReport.ok }} 项，释放 {{ formatBytes(dupe.lastReport.freedBytes) }}
      <span v-if="dupe.lastReport.failed.length > 0" class="fail"
        >（{{ dupe.lastReport.failed.length }} 项失败）</span
      >
    </div>

    <div class="list-area">
      <VirtualScrollList v-if="rows.length > 0" :items="rows" :item-size="30">
        <template #default="{ item }">
          <div
            v-if="(item as Row).kind === 'header'"
            class="group-header"
            @click="toggleCollapse((item as HeaderRow).group.id)"
          >
            <span class="disclosure" :class="{ exp: !collapsed.has((item as HeaderRow).group.id) }">
              <AppIcon name="chevron" />
            </span>
            <span class="group-title">{{
              baseName((item as HeaderRow).group.entries[0].path)
            }}</span>
            <span class="group-meta"
              >{{ (item as HeaderRow).group.entries.length }} 个文件 ·
              {{ formatBytes((item as HeaderRow).group.size) }}</span
            >
            <span class="group-keep">保留：{{ keepDisplay((item as HeaderRow).group) }}</span>
          </div>
          <div
            v-else
            class="entry-row"
            :class="{
              kept: isKept((item as EntryRow).group, (item as EntryRow).entry),
              readonly: (item as EntryRow).entry.containerPath !== null
            }"
            :title="
              (item as EntryRow).entry.containerPath !== null
                ? '压缩包内条目仅参与查重，不参与清理'
                : '点击设为保留项'
            "
            @click="setKeep((item as EntryRow).group, (item as EntryRow).entry)"
          >
            <span class="keep-mark">
              <AppIcon v-if="(item as EntryRow).entry.containerPath !== null" name="box" />
              <span
                v-else
                class="keep-dot"
                :class="{ on: isKept((item as EntryRow).group, (item as EntryRow).entry) }"
              ></span>
            </span>
            <span class="entry-path" :title="(item as EntryRow).entry.path">{{
              (item as EntryRow).entry.path
            }}</span>
            <span class="entry-mtime">{{ formatTime((item as EntryRow).entry.mtime) }}</span>
          </div>
        </template>
      </VirtualScrollList>
      <div v-else class="empty">暂无重复文件，先到「扫描参数」页运行一次扫描</div>
    </div>

    <ConfirmDialog
      :open="cleanOpen"
      title="删除重复文件"
      :message="`确认把 ${cleanCount} 个重复文件移入回收站？（每组保留 1 个原件）`"
      confirm-text="删除"
      danger
      @confirm="onCleanConfirm"
      @cancel="cleanOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FileEntry } from '../../../shared/types'
import { keepName, useDupeStore, type DupeGroupView, type KeepRule } from '../stores/dupe'
import { baseName, formatBytes, formatTime } from '../utils/format'
import AppIcon from './AppIcon.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import VirtualScrollList from './VirtualScrollList.vue'

const dupe = useDupeStore()
const rule = ref<KeepRule>('first')
const filterMB = ref<number | null>(null)
const collapsed = ref<Set<number>>(new Set())
const cleanOpen = ref(false)
const cleanCount = ref(0)

watch(filterMB, (v) => {
  dupe.filter.minSize = v !== null && v > 0 ? v * 1024 * 1024 : null
})

type HeaderRow = { kind: 'header'; group: DupeGroupView }
type EntryRow = { kind: 'entry'; group: DupeGroupView; entry: FileEntry }
type Row = HeaderRow | EntryRow

const rows = computed<Row[]>(() => {
  const list: Row[] = []
  for (const g of dupe.visibleGroups) {
    list.push({ kind: 'header', group: g })
    if (!collapsed.value.has(g.id)) {
      for (const e of g.entries) list.push({ kind: 'entry', group: g, entry: e })
    }
  }
  return list
})

const canClean = computed(
  () => dupe.visibleGroups.length > 0 && dupe.visibleGroups.every((g) => dupe.keepChoice[g.id])
)

function isKept(group: DupeGroupView, entry: FileEntry): boolean {
  return dupe.keepChoice[group.id] === entry.path
}

/** 压缩包内条目不可作为保留件（无法被清理动作触碰） */
function setKeep(group: DupeGroupView, entry: FileEntry): void {
  if (entry.containerPath !== null) return
  dupe.setKeep(group.id, entry.path)
}

function keepDisplay(group: DupeGroupView): string {
  return keepName(group, dupe.keepChoice[group.id])
}

function toggleCollapse(groupId: number): void {
  const next = new Set(collapsed.value)
  if (next.has(groupId)) next.delete(groupId)
  else next.add(groupId)
  collapsed.value = next
}

function clean(): void {
  cleanCount.value = dupe.visibleGroups.reduce(
    (n, g) => n + g.entries.filter((e) => e.path !== dupe.keepChoice[g.id]).length,
    0
  )
  cleanOpen.value = true
}

async function onCleanConfirm(): Promise<void> {
  cleanOpen.value = false
  await dupe.runClean()
}
</script>

<style scoped>
.dupe-list {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.stat {
  flex: 1;
  color: var(--muted);
}

.filter-row {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.filter-row .input.num {
  width: 100px;
}

.report {
  padding: 6px 10px;
  background: var(--hover-bg);
  border-bottom: 1px solid var(--border);
}

.fail {
  color: var(--danger);
}

.list-area {
  flex: 1;
  min-height: 0;
}

.group-header {
  height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: var(--hover-bg);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  box-sizing: border-box;
  user-select: none;
}

.disclosure {
  width: 14px;
  flex-shrink: 0;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.disclosure svg {
  width: 11px;
  height: 11px;
  transition: transform 0.12s ease;
}

.disclosure.exp svg {
  transform: rotate(90deg);
}

.group-title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-meta {
  color: var(--muted);
  flex-shrink: 0;
}

.group-keep {
  margin-left: auto;
  color: var(--accent);
  font-size: 12px;
  flex-shrink: 0;
}

.entry-row {
  height: 30px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px 0 28px;
  border-bottom: 1px solid var(--border-light);
  cursor: pointer;
  box-sizing: border-box;
}

.entry-row:hover {
  background: var(--hover-bg);
}

.entry-row.kept {
  color: var(--accent);
}

.keep-mark {
  width: 16px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}

.keep-mark svg {
  width: 13px;
  height: 13px;
}

/* 保留标记：单选圆点，选中填充强调色 */
.keep-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--muted);
  box-sizing: border-box;
}

.keep-dot.on {
  border-color: var(--accent);
  background: var(--accent);
}

.entry-path {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.entry-row.readonly {
  color: var(--muted);
  cursor: default;
}

.entry-mtime {
  color: var(--muted);
  font-size: 12px;
  flex-shrink: 0;
}

.empty {
  padding: 16px;
  color: var(--muted);
}
</style>
