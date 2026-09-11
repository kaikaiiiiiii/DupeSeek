import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CleanReport, DupeGroup, FileEntry } from '../../../shared/types'
import { baseName } from '../utils/format'

export interface DupeGroupView extends DupeGroup {
  /** 会话内唯一的组 ID，作为选择状态键 */
  id: number
}

export type KeepRule = 'first' | 'oldest' | 'newest' | 'shortestPath'

export interface DupeFilter {
  class: string
  minSize: number | null
  pathIncludes: string
}

let nextId = 1

export const useDupeStore = defineStore('dupe', () => {
  const groups = ref<DupeGroupView[]>([])
  const keepChoice = ref<Record<number, string>>({})
  const filter = ref<DupeFilter>({ class: '', minSize: null, pathIncludes: '' })
  const lastReport = ref<CleanReport | null>(null)

  const totalWasted = computed(() =>
    groups.value.reduce((sum, g) => sum + g.size * (g.entries.length - 1), 0)
  )

  const visibleGroups = computed(() =>
    groups.value.filter((g) => {
      const f = filter.value
      if (f.class && !g.entries.some((e) => e.class.toLowerCase() === f.class.toLowerCase())) {
        return false
      }
      if (f.minSize !== null && g.size < f.minSize) return false
      if (f.pathIncludes && !g.entries.some((e) => e.path.includes(f.pathIncludes))) return false
      return true
    })
  )

  function appendGroups(list: DupeGroup[]): void {
    for (const g of list) {
      const view: DupeGroupView = { ...g, id: nextId++ }
      groups.value = [...groups.value, view]
      if (!keepChoice.value[view.id]) {
        keepChoice.value = { ...keepChoice.value, [view.id]: defaultKeep(view) }
      }
    }
  }

  /** 扫描结束信号；用于将来刷新统计，当前仅保留扩展点 */
  function markScanDone(): void {
    // intentionally left empty
  }

  function defaultKeep(group: DupeGroupView): string {
    const candidates = group.entries
    if (candidates.length === 0) return ''
    return candidates.reduce((best, e) => (e.mtime < best.mtime ? e : best), candidates[0]).path
  }

  function setKeep(groupId: number, path: string): void {
    keepChoice.value = { ...keepChoice.value, [groupId]: path }
  }

  function applyKeepRule(rule: KeepRule): void {
    const next: Record<number, string> = {}
    for (const g of visibleGroups.value) {
      let pick: FileEntry | undefined
      switch (rule) {
        case 'first':
          pick = g.entries[0]
          break
        case 'oldest':
          pick = g.entries.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
          break
        case 'newest':
          pick = g.entries.reduce((a, b) => (a.mtime >= b.mtime ? a : b))
          break
        case 'shortestPath':
          pick = g.entries.reduce((a, b) => (a.path.length <= b.path.length ? a : b))
          break
      }
      if (pick) next[g.id] = pick.path
    }
    keepChoice.value = next
  }

  /** 组装清理动作并执行；确认弹窗由组件层负责 */
  async function runClean(): Promise<CleanReport> {
    const keepPaths: string[] = []
    const removePaths: string[] = []
    for (const g of visibleGroups.value) {
      const keep = keepChoice.value[g.id]
      if (!keep || !g.entries.some((e) => e.path === keep)) continue
      keepPaths.push(keep)
      for (const e of g.entries) {
        if (e.path !== keep) removePaths.push(e.path)
      }
    }
    const report = await window.api.cleanRun({ keepPaths, removePaths })
    lastReport.value = report
    // 从列表中移除已清理的条目（失败的保留），少于 2 个成员的组解散
    const failed = new Set(report.failed.map((f) => f.path))
    groups.value = groups.value
      .map((g) => ({
        ...g,
        entries: g.entries.filter((e) => !removePaths.includes(e.path) || failed.has(e.path))
      }))
      .filter((g) => g.entries.length >= 2)
    return report
  }

  function reset(): void {
    groups.value = []
    keepChoice.value = {}
    lastReport.value = null
  }

  return {
    groups,
    keepChoice,
    filter,
    lastReport,
    totalWasted,
    visibleGroups,
    appendGroups,
    markScanDone,
    setKeep,
    applyKeepRule,
    runClean,
    reset
  }
})

// 供展示用：组内保留项的显示名
export function keepName(group: DupeGroupView, keep: string | undefined): string {
  if (!keep) return '—'
  const found = group.entries.find((e) => e.path === keep)
  return found ? baseName(found.path) : '—'
}
