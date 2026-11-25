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
      <button class="btn danger" :disabled="dupe.checkedCount === 0" @click="clean">
        删除勾选（进回收站）
      </button>
    </div>

    <!-- 范围规则激活时的提示条（右键菜单「清理该位置重复文件」应用） -->
    <div v-if="dupe.scopeRule !== null" class="scope-bar">
      <AppIcon class="scope-icon" name="search" />
      <span class="scope-text">
        范围规则：仅勾选 <b>{{ scopePath }}</b> 下的文件（{{ dupe.checkedCount }} 项）
      </span>
      <button class="scope-clear" title="清除范围规则" @click="dupe.clearScopeRule()">
        <AppIcon name="dismiss" />
      </button>
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
            <span class="group-keep"
              >勾选 {{ checkedIn((item as HeaderRow).group) }} /
              {{ normalCount((item as HeaderRow).group) }}</span
            >
          </div>
          <div
            v-else
            class="entry-row"
            :class="{
              checked: dupe.isChecked((item as EntryRow).entry.path),
              readonly: (item as EntryRow).entry.containerPath !== null
            }"
            :title="
              (item as EntryRow).entry.containerPath !== null
                ? '压缩包内条目仅参与查重，不参与清理'
                : '点击切换勾选（勾选 = 待清理）'
            "
            @click="toggle((item as EntryRow).entry)"
          >
            <span class="keep-mark">
              <AppIcon v-if="(item as EntryRow).entry.containerPath !== null" name="box" />
              <span
                v-else
                class="check-box"
                :class="{ on: dupe.isChecked((item as EntryRow).entry.path) }"
              >
                <AppIcon v-if="dupe.isChecked((item as EntryRow).entry.path)" name="check" />
              </span>
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
      :message="confirmMessage"
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
import { useDupeStore, type DupeGroupView, type KeepRule } from '../stores/dupe'
import { baseName, formatBytes, formatTime } from '../utils/format'
import AppIcon from './AppIcon.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import VirtualScrollList from './VirtualScrollList.vue'

const dupe = useDupeStore()
const rule = ref<KeepRule>('first')
const filterMB = ref<number | null>(null)
const collapsed = ref<Set<number>>(new Set())
const cleanOpen = ref(false)
const plan = ref<{ remove: number; skipped: number }>({ remove: 0, skipped: 0 })

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

const scopePath = computed(() =>
  dupe.scopeRule !== null && dupe.scopeRule.kind === 'underPath' ? dupe.scopeRule.path : ''
)

const confirmMessage = computed(() => {
  const base = `确认把 ${plan.value.remove} 个勾选文件移入回收站？`
  return plan.value.skipped > 0
    ? `${base}（另有 ${plan.value.skipped} 组将整组跳过：全部副本都在勾选范围内，删光会丢失文件）`
    : base
})

function normalEntries(g: DupeGroupView): FileEntry[] {
  return g.entries.filter((e) => e.containerPath === null)
}

function normalCount(g: DupeGroupView): number {
  return normalEntries(g).length
}

function checkedIn(g: DupeGroupView): number {
  return normalEntries(g).filter((e) => dupe.isChecked(e.path)).length
}

/** 压缩包内条目不可勾选（无法被清理动作触碰） */
function toggle(entry: FileEntry): void {
  if (entry.containerPath !== null) return
  dupe.toggleChecked(entry.path)
}

function toggleCollapse(groupId: number): void {
  const next = new Set(collapsed.value)
  if (next.has(groupId)) next.delete(groupId)
  else next.add(groupId)
  collapsed.value = next
}

function clean(): void {
  const p = dupe.planClean()
  plan.value = { remove: p.removePaths.length, skipped: p.skippedGroups }
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

/* 范围规则提示条：彩边 info-bar 样式 */
.scope-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--info-bg);
  border-bottom: 1px solid var(--info-bd);
}

.scope-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.scope-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scope-clear {
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 4px;
  display: inline-flex;
  flex-shrink: 0;
}

.scope-clear:hover {
  background: var(--hover-bg);
  color: var(--text);
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
  font-variant-numeric: tabular-nums;
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

/* 勾选行 = 待清理，危险色提示 */
.entry-row.checked {
  color: var(--danger);
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

/* 勾选框：方形复选，选中填充强调色并打勾 */
.check-box {
  width: 14px;
  height: 14px;
  border: 1px solid var(--border);
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-fg);
  box-sizing: border-box;
}

.check-box.on {
  background: var(--accent);
  border-color: var(--accent);
}

.check-box svg {
  width: 10px;
  height: 10px;
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
