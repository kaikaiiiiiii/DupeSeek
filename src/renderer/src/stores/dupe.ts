import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CleanReport, DupeGroup, FileEntry } from '../../../shared/types'
import { baseName } from '../utils/format'
import { deepPlain } from '../utils/plain'

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

  /** 增量同步语义：按 key 幂等——同 key 的组整组替换（成员可能增加），
   *  id 保持稳定以保留选择状态；既有保留项若仍在组内则沿用 */
  function appendGroups(list: DupeGroup[]): void {
    for (const g of list) {
      const idx = groups.value.findIndex((x) => x.key === g.key)
      if (idx >= 0) {
        const id = groups.value[idx].id
        const view: DupeGroupView = { ...g, id }
        groups.value.splice(idx, 1, view)
        if (!g.entries.some((e) => e.path === keepChoice.value[id])) {
          keepChoice.value = { ...keepChoice.value, [id]: defaultKeep(view) }
        }
      } else {
        const id = nextId++
        const view: DupeGroupView = { ...g, id }
        groups.value = [...groups.value, view]
        keepChoice.value = { ...keepChoice.value, [id]: defaultKeep(view) }
      }
    }
  }

  /** 移除目标后的内存清理：剔除其成员（含包内条目），不足 2 个的组解散。
   *  纯内存操作，零磁盘 I/O。 */
  function purgeTargets(prefixes: string[]): void {
    if (prefixes.length === 0) return
    const isRemoved = (e: FileEntry): boolean => {
      const root = (e.containerPath ?? e.path).toLowerCase()
      return prefixes.some((p) => {
        const lp = p.toLowerCase()
        return root === lp || root.startsWith(lp + '\\')
      })
    }
    const keptGroups = groups.value
      .map((g) => ({ ...g, entries: g.entries.filter((e) => !isRemoved(e)) }))
      .filter((g) => g.entries.length >= 2)
    const nextKeep: Record<number, string> = {}
    for (const g of keptGroups) {
      const keep = keepChoice.value[g.id]
      nextKeep[g.id] = keep && g.entries.some((e) => e.path === keep) ? keep : defaultKeep(g)
    }
    groups.value = keptGroups
    keepChoice.value = nextKeep
  }

  /** 扫描结束信号；用于将来刷新统计，当前仅保留扩展点 */
  function markScanDone(): void {
    // intentionally left empty
  }

  function defaultKeep(group: DupeGroupView): string {
    const candidates = group.entries
    if (candidates.length === 0) return ''
    // 压缩包内条目无法被清理动作删除，保留项优先选普通文件
    const normal = candidates.filter((e) => e.containerPath === null)
    const pool = normal.length > 0 ? normal : candidates
    return pool.reduce((best, e) => (e.mtime < best.mtime ? e : best), pool[0]).path
  }

  function setKeep(groupId: number, path: string): void {
    keepChoice.value = { ...keepChoice.value, [groupId]: path }
  }

  function applyKeepRule(rule: KeepRule): void {
    const next: Record<number, string> = {}
    for (const g of visibleGroups.value) {
      const pool = g.entries.filter((e) => e.containerPath === null)
      if (pool.length === 0) continue
      let pick: FileEntry | undefined
      switch (rule) {
        case 'first':
          pick = pool[0]
          break
        case 'oldest':
          pick = pool.reduce((a, b) => (a.mtime <= b.mtime ? a : b))
          break
        case 'newest':
          pick = pool.reduce((a, b) => (a.mtime >= b.mtime ? a : b))
          break
        case 'shortestPath':
          pick = pool.reduce((a, b) => (a.path.length <= b.path.length ? a : b))
          break
      }
      if (pick) next[g.id] = pick.path
    }
    keepChoice.value = next
  }

  /** 组装清理动作并执行；确认弹窗由组件层负责。
   *  压缩包内条目只参与查重：既不能作为保留件被移动，也绝不进入删除清单。 */
  async function runClean(): Promise<CleanReport> {
    const keepPaths: string[] = []
    const removePaths: string[] = []
    for (const g of visibleGroups.value) {
      const keep = keepChoice.value[g.id]
      if (!keep || !g.entries.some((e) => e.path === keep)) continue
      keepPaths.push(keep)
      for (const e of g.entries) {
        if (e.path !== keep && e.containerPath === null) removePaths.push(e.path)
      }
    }
    const report = await window.api.cleanRun(deepPlain({ keepPaths, removePaths }))
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
    purgeTargets,
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
