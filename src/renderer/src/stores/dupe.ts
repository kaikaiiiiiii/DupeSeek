import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CleanReport, DupeGroup, FileEntry, ScopeRule } from '../../../shared/types'
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

/** Windows 路径口径的前缀归属判断（含自身；大小写不敏感、容尾分隔符） */
function underPath(p: string, root: string): boolean {
  const lp = p.toLowerCase()
  const lr = root.toLowerCase().replace(/[\\/]+$/, '')
  return lp === lr || lp.startsWith(lr + '\\')
}

/**
 * 清理规则页状态：勾选即待清理（删除候选），见 docs/Cleanup.md。
 * 范围规则（ScopeRule）与应用动作分离：规则是带参数的纯数据，入口
 * （右键菜单等）构造规则并调用 applyScopeRule。
 */
export const useDupeStore = defineStore('dupe', () => {
  const groups = ref<DupeGroupView[]>([])
  /** 待清理勾选集（路径）；压缩包内条目永不进入 */
  const checked = ref<Set<string>>(new Set())
  /** 当前生效的范围规则；null 表示纯手动勾选 */
  const scopeRule = ref<ScopeRule | null>(null)
  const filter = ref<DupeFilter>({ class: '', minSize: null, pathIncludes: '' })
  const lastReport = ref<CleanReport | null>(null)

  const totalWasted = computed(() =>
    groups.value.reduce((sum, g) => sum + g.size * (g.entries.length - 1), 0)
  )

  const checkedCount = computed(() => checked.value.size)

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
   *  id 保持稳定；组变化后勾选集与现存条目对齐 */
  function appendGroups(list: DupeGroup[]): void {
    for (const g of list) {
      const idx = groups.value.findIndex((x) => x.key === g.key)
      if (idx >= 0) {
        groups.value.splice(idx, 1, { ...g, id: groups.value[idx].id })
      } else {
        const id = nextId++
        groups.value = [...groups.value, { ...g, id }]
      }
    }
    syncChecked()
  }

  /** 移除目标后的内存清理：剔除其成员（含包内条目），不足 2 个的组解散。
   *  纯内存操作，零磁盘 I/O。 */
  function purgeTargets(prefixes: string[]): void {
    if (prefixes.length === 0) return
    const isRemoved = (e: FileEntry): boolean => {
      const root = (e.containerPath ?? e.path).toLowerCase()
      return prefixes.some((p) => underPath(root, p))
    }
    groups.value = groups.value
      .map((g) => ({ ...g, entries: g.entries.filter((e) => !isRemoved(e)) }))
      .filter((g) => g.entries.length >= 2)
    syncChecked()
  }

  /** 扫描结束信号；用于将来刷新统计，当前仅保留扩展点 */
  function markScanDone(): void {
    // intentionally left empty
  }

  function isChecked(path: string): boolean {
    return checked.value.has(path)
  }

  function toggleChecked(path: string): void {
    const next = new Set(checked.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    checked.value = next
  }

  /**
   * 范围规则应用（两段逻辑第一段）：登记规则并据此重算勾选集。
   * 勾选 = 待清理；压缩包内条目永不入选。
   */
  function applyScopeRule(rule: ScopeRule): void {
    scopeRule.value = rule
    const next = new Set<string>()
    if (rule.kind === 'underPath') {
      for (const g of groups.value) {
        for (const e of g.entries) {
          if (e.containerPath === null && underPath(e.path, rule.path)) next.add(e.path)
        }
      }
    }
    checked.value = next
  }

  /** 清除范围规则并清空勾选 */
  function clearScopeRule(): void {
    scopeRule.value = null
    checked.value = new Set()
  }

  /** 勾选集与现存条目对齐：范围规则生效时按规则重算，否则剔除已不存在的路径 */
  function syncChecked(): void {
    if (scopeRule.value !== null) {
      applyScopeRule(scopeRule.value)
      return
    }
    const live = new Set<string>()
    for (const g of groups.value) {
      for (const e of g.entries) if (e.containerPath === null) live.add(e.path)
    }
    const next = new Set<string>()
    for (const p of checked.value) if (live.has(p)) next.add(p)
    checked.value = next
  }

  /** 分支刷新后调用：该前缀下的条目已在引擎侧对齐磁盘，勾选集中相应路径剔除 */
  function pruneUnderPath(prefix: string): void {
    const next = new Set<string>()
    for (const p of checked.value) if (!underPath(p, prefix)) next.add(p)
    checked.value = next
  }

  /** 保留规则选择器：每组按规则挑出存活件，其余普通条目自动反勾 */
  function applyKeepRule(rule: KeepRule): void {
    scopeRule.value = null
    const next = new Set<string>()
    for (const g of visibleGroups.value) {
      const pool = g.entries.filter((e) => e.containerPath === null)
      if (pool.length < 2) continue // 无可删件（仅单普通文件或全是包内条目）
      let pick: FileEntry
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
      for (const e of pool) if (e.path !== pick.path) next.add(e.path)
    }
    checked.value = next
  }

  /**
   * 清理计划：勾选 → 删除清单。「范围外存活才删」——一组内全部普通条目都被
   * 勾选时整组跳过（无范围外存活副本，删光会丢文件），跳过数供确认弹窗预告。
   */
  function planClean(): { removePaths: string[]; keepPaths: string[]; skippedGroups: number } {
    const removePaths: string[] = []
    const keepPaths: string[] = []
    let skippedGroups = 0
    for (const g of visibleGroups.value) {
      const normal = g.entries.filter((e) => e.containerPath === null)
      const picked = normal.filter((e) => checked.value.has(e.path))
      if (picked.length === 0) continue
      if (picked.length === normal.length) {
        skippedGroups++
        continue
      }
      for (const e of picked) removePaths.push(e.path)
      for (const e of normal) if (!checked.value.has(e.path)) keepPaths.push(e.path)
    }
    return { removePaths, keepPaths, skippedGroups }
  }

  /** 组装清理动作并执行；确认弹窗由组件层负责。
   *  压缩包内条目只参与查重：既不能作为保留件，也绝不进入删除清单。 */
  async function runClean(): Promise<CleanReport> {
    const { removePaths, keepPaths } = planClean()
    if (removePaths.length === 0) return { ok: 0, failed: [], freedBytes: 0 }
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
    syncChecked()
    return report
  }

  function reset(): void {
    groups.value = []
    checked.value = new Set()
    scopeRule.value = null
    lastReport.value = null
  }

  return {
    groups,
    checked,
    checkedCount,
    scopeRule,
    filter,
    lastReport,
    totalWasted,
    visibleGroups,
    appendGroups,
    purgeTargets,
    markScanDone,
    isChecked,
    toggleChecked,
    applyScopeRule,
    clearScopeRule,
    pruneUnderPath,
    applyKeepRule,
    planClean,
    runClean,
    reset
  }
})
