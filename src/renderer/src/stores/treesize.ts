import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  TreeChildrenReply,
  TreeDirRowData,
  TreeFilesReply,
  TreeSortKey
} from '../../../shared/types'
import { useScanStore } from './scan'

export interface TreeDirRow {
  kind: 'dir'
  /** 位置标识：祖先链唯一确定一个 UI 条目（同一路径可在多处出现，展开互不联动） */
  id: string
  data: TreeDirRowData
  depth: number
}

export interface TreeFileRow {
  kind: 'file'
  path: string
  name: string
  size: number
  dupWasted: number
  depth: number
}

/** 目录直属文件聚合条目（[n 个文件]），可展开为逐文件条目 */
export interface TreeAggRow {
  kind: 'aggregate'
  id: string
  parent: string
  name: string
  size: number
  dupWasted: number
  count: number
  depth: number
}

/** 子级数据在途时的占位行（定高，保虚拟滚动稳定） */
export interface TreeLoadingRow {
  kind: 'loading'
  depth: number
}

export type TreeRow = TreeDirRow | TreeFileRow | TreeAggRow | TreeLoadingRow

/** 根级缓存的约定键 */
const ROOT = ''
/** 位置标识的分隔符：文件名理论可含任何可见字符，用控制字符杜绝碰撞 */
const SEP = '\u0000'
/** 聚合行的展开指令前缀（expanded 值的约定） */
const AGG_PREFIX = '::files:'

/**
 * 空间分析视图的拉取式模型：树的权威数据在后端，前端只保存
 * 已展开路径的子级/文件缓存并拼装成虚拟滚动平面行。
 * 树版本（rev）随扫描 progress 事件推进，变化即失效缓存重取。
 *
 * 展开状态按「位置」而非「路径」记键：同一目录作为嵌套目标的根行、
 * 又作为父目标树中的子行出现时，是两个独立 UI 条目，展开互不联动；
 * 数据缓存仍按路径共享——同一份后端聚合服务两处展示。
 */
export const useTreeSizeStore = defineStore('treesize', () => {
  /** 位置标识 → 取数指令（目录路径，或 AGG_PREFIX + 父目录路径） */
  const expanded = ref<Map<string, string>>(new Map())
  const sortKey = ref<TreeSortKey>('size')
  const sortDesc = ref(true)
  const rev = ref(0)
  /** 目录子级缓存：dirPath（'' 为根）→ 回复；'loading' 表示在途 */
  const childrenCache = ref<Record<string, TreeChildrenReply | 'loading'>>({})
  /** 直属文件缓存：dirPath → 分页回复（聚合展开与纯文件目录共用） */
  const filesCache = ref<Record<string, TreeFilesReply | 'loading'>>({})

  const stats = computed(() => {
    const c = childrenCache.value[ROOT]
    return c && c !== 'loading' ? c.stats : { totalSize: 0, totalDup: 0, dirCount: 0 }
  })

  function setSort(key: TreeSortKey): void {
    if (sortKey.value === key) sortDesc.value = !sortDesc.value
    else {
      sortKey.value = key
      sortDesc.value = key !== 'name'
    }
    refresh()
  }

  async function ensureChildren(dir: string, force = false): Promise<void> {
    const cur = childrenCache.value[dir]
    if (cur === 'loading') return // 在途
    if (cur !== undefined && !force) return // 已有缓存
    try {
      const res =
        dir === ROOT
          ? await window.api.treeRoots(sortKey.value, sortDesc.value)
          : await window.api.treeChildren(dir, sortKey.value, sortDesc.value)
      if (res === null || res.rev < rev.value) {
        // 过期响应：首取失败回退为可重试；已有旧数据则保留显示，等下一轮
        if (cur === undefined) {
          const next = { ...childrenCache.value }
          delete next[dir]
          childrenCache.value = next
        }
        return
      }
      rev.value = Math.max(rev.value, res.rev)
      childrenCache.value = { ...childrenCache.value, [dir]: res }
    } catch {
      if (cur === undefined) {
        const next = { ...childrenCache.value }
        delete next[dir]
        childrenCache.value = next
      }
    }
  }

  async function ensureFiles(dir: string, force = false): Promise<void> {
    const cur = filesCache.value[dir]
    if (cur === 'loading') return // 在途
    if (cur !== undefined && !force) return // 已有缓存
    try {
      const res = await window.api.treeFiles(dir, sortKey.value, sortDesc.value, 0, 10000)
      if (res === null || res.rev < rev.value) {
        if (cur === undefined) {
          const next = { ...filesCache.value }
          delete next[dir]
          filesCache.value = next
        }
        return
      }
      rev.value = Math.max(rev.value, res.rev)
      filesCache.value = { ...filesCache.value, [dir]: res }
    } catch {
      if (cur === undefined) {
        const next = { ...filesCache.value }
        delete next[dir]
        filesCache.value = next
      }
    }
  }

  /** 重取根级与所有已展开条目：stale-while-revalidate——重取期间旧数据
   *  保持显示，响应到达后原位覆盖（避免哈希期反复闪烁加载态） */
  function refresh(): void {
    void ensureChildren(ROOT, true)
    for (const cmd of expanded.value.values()) {
      if (cmd.startsWith(AGG_PREFIX)) void ensureFiles(cmd.slice(AGG_PREFIX.length), true)
      else void ensureChildren(cmd, true)
    }
  }

  /** 树版本推进（扫描 progress / scan:done）。重取按 400ms 尾沿节流：
   *  哈希阶段组确认频繁（progress ~10Hz），避免逐事件全量失效重取 */
  let refreshTimer: number | undefined
  let pendingRev = 0
  function setRev(v: number): void {
    pendingRev = v
    if (refreshTimer !== undefined) return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined
      if (pendingRev !== rev.value) {
        rev.value = pendingRev
        refresh()
      }
    }, 400)
  }

  function toggleRow(item: TreeDirRow | TreeAggRow): void {
    const next = new Map(expanded.value)
    if (next.has(item.id)) next.delete(item.id)
    else if (item.kind === 'aggregate') {
      next.set(item.id, AGG_PREFIX + item.parent)
      void ensureFiles(item.parent)
    } else {
      next.set(item.id, item.data.path)
      void ensureChildren(item.data.path)
    }
    expanded.value = next
  }

  function reset(): void {
    expanded.value = new Map()
    refresh()
  }

  function collapseAll(): void {
    expanded.value = new Map()
  }

  /** 全部展开：懒加载下只展开已加载缓存内的条目（数据随展开逐步取回） */
  function expandAll(): void {
    const next = new Map(expanded.value)
    const visit = (dir: string, prefix: string): void => {
      const c = childrenCache.value[dir]
      if (!c || c === 'loading') return
      for (const d of c.dirs) {
        if (d.childDirs > 0 || d.fileCount > 0) {
          const id = prefix ? prefix + SEP + d.path : d.path
          next.set(id, d.path)
          void ensureChildren(d.path)
          if (d.childDirs > 0 && d.fileCount > 0) {
            next.set(id + SEP + d.path + '::files', AGG_PREFIX + d.path)
          }
          visit(d.path, id)
        }
      }
      if (c.agg && c.agg.count > 0) {
        const aggId = (prefix ? prefix + SEP : '') + dir + '::files'
        next.set(aggId, AGG_PREFIX + dir)
        if (dir !== ROOT) void ensureFiles(dir)
      }
    }
    visit(ROOT, '')
    expanded.value = next
  }

  // 扫描期间 progress 事件携带 treeRev，自动跟随
  const scan = useScanStore()
  watch(
    () => scan.progress?.treeRev ?? -1,
    (v) => {
      if (v >= 0) setRev(v)
    }
  )
  // 移除目标等不伴随 progress 的变更经 scan:rev 广播，同样跟随
  window.api.onTreeRev((p) => setRev(p.rev))
  // 初始拉取根级
  void ensureChildren(ROOT)

  // —— 摊平：把已缓存数据拼装成虚拟滚动平面行，缺失处以加载占位行补位 ——

  /** 聚合行的排序：名称排序恒排末尾；大小/重复按值并入（目录序后端已排好，稳定排序插入） */
  function buildLevel(dir: string, depth: number): Array<TreeDirRow | TreeAggRow> {
    const c = childrenCache.value[dir]
    if (!c || c === 'loading') return []
    const items: Array<TreeDirRow | TreeAggRow> = c.dirs.map((d) => ({
      kind: 'dir' as const,
      id: '',
      data: d,
      depth
    }))
    if (c.agg) {
      items.push({
        kind: 'aggregate',
        id: '',
        parent: dir,
        name: `[${c.agg.count} 个文件]`,
        size: c.agg.size,
        dupWasted: c.agg.dupWasted,
        count: c.agg.count,
        depth
      })
    }
    const dirFlag = sortDesc.value ? -1 : 1
    if (sortKey.value === 'name') {
      const agg = items.filter((i): i is TreeAggRow => i.kind === 'aggregate')
      const dirs = items.filter((i): i is TreeDirRow => i.kind === 'dir')
      dirs.sort(
        (a, b) => dirFlag * a.data.name.localeCompare(b.data.name, undefined, { numeric: true })
      )
      return [...dirs, ...agg]
    }
    const val = (i: TreeDirRow | TreeAggRow): number =>
      i.kind === 'dir'
        ? sortKey.value === 'dup'
          ? i.data.dupWasted
          : i.data.size
        : sortKey.value === 'dup'
          ? i.dupWasted
          : i.size
    return items.sort((a, b) => dirFlag * (val(a) - val(b)))
  }

  const rows = computed<TreeRow[]>(() => {
    const out: TreeRow[] = []
    const walkFiles = (parent: string, depth: number): void => {
      const f = filesCache.value[parent]
      if (!f || f === 'loading') {
        out.push({ kind: 'loading', depth })
        return
      }
      for (const fr of f.rows) {
        out.push({
          kind: 'file',
          path: fr.path,
          name: fr.name,
          size: fr.size,
          dupWasted: fr.dupWasted,
          depth
        })
      }
    }
    const walkChildren = (dir: string, prefix: string, depth: number): void => {
      const cached = childrenCache.value[dir]
      if (cached === undefined || cached === 'loading') {
        out.push({ kind: 'loading', depth })
        return
      }
      const level = buildLevel(dir, depth)
      for (const it of level) {
        if (it.kind === 'aggregate') {
          it.id = (prefix ? prefix + SEP : '') + it.parent + '::files'
          out.push(it)
          if (expanded.value.has(it.id)) walkFiles(it.parent, depth + 1)
          continue
        }
        it.id = prefix ? prefix + SEP + it.data.path : it.data.path
        out.push(it)
        if (!expanded.value.has(it.id)) continue
        if (it.data.childDirs > 0) walkChildren(it.data.path, it.id, depth + 1)
        if (it.data.childDirs === 0 && it.data.fileCount > 0) walkFiles(it.data.path, depth + 1)
      }
    }
    walkChildren(ROOT, '', 0)
    return out
  })

  /** 体积条基准：当前已加载行的全局最大（随展开范围变化，仅视觉参考） */
  const maxSize = computed(() =>
    rows.value.reduce((m, r) => {
      const s = r.kind === 'dir' ? r.data.size : r.kind === 'loading' ? 0 : r.size
      return Math.max(m, s)
    }, 0)
  )
  const maxDup = computed(() =>
    rows.value.reduce((m, r) => {
      const d =
        r.kind === 'dir'
          ? r.data.dupWasted
          : r.kind === 'file'
            ? r.dupWasted
            : r.kind === 'aggregate'
              ? r.dupWasted
              : 0
      return Math.max(m, d)
    }, 0)
  )

  return {
    expanded,
    sortKey,
    sortDesc,
    setSort,
    rev,
    setRev,
    stats,
    rows,
    maxSize,
    maxDup,
    toggleRow,
    reset,
    expandAll,
    collapseAll
  }
})
