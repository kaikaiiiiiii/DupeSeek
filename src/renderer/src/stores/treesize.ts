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
  path: string
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

/**
 * 空间分析视图的拉取式模型：树的权威数据在后端，前端只保存
 * 已展开路径的子级/文件缓存并拼装成虚拟滚动平面行。
 * 树版本（rev）随扫描 progress 事件推进，变化即失效缓存重取。
 */
export const useTreeSizeStore = defineStore('treesize', () => {
  const expanded = ref<Set<string>>(new Set())
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

  async function ensureChildren(dir: string): Promise<void> {
    if (childrenCache.value[dir] !== undefined) return
    childrenCache.value = { ...childrenCache.value, [dir]: 'loading' }
    try {
      const res =
        dir === ROOT
          ? await window.api.treeRoots(sortKey.value, sortDesc.value)
          : await window.api.treeChildren(dir, sortKey.value, sortDesc.value)
      if (res === null || res.rev !== rev.value) {
        // 过期响应：丢弃，等下一次 refresh 重取
        const next = { ...childrenCache.value }
        delete next[dir]
        childrenCache.value = next
        return
      }
      childrenCache.value = { ...childrenCache.value, [dir]: res }
    } catch {
      const next = { ...childrenCache.value }
      delete next[dir]
      childrenCache.value = next
    }
  }

  async function ensureFiles(dir: string): Promise<void> {
    if (filesCache.value[dir] !== undefined) return
    filesCache.value = { ...filesCache.value, [dir]: 'loading' }
    try {
      const res = await window.api.treeFiles(dir, sortKey.value, sortDesc.value, 0, 10000)
      if (res === null || res.rev !== rev.value) {
        const next = { ...filesCache.value }
        delete next[dir]
        filesCache.value = next
        return
      }
      filesCache.value = { ...filesCache.value, [dir]: res }
    } catch {
      const next = { ...filesCache.value }
      delete next[dir]
      filesCache.value = next
    }
  }

  function invalidate(): void {
    childrenCache.value = {}
    filesCache.value = {}
  }

  /** 重取根级与所有已展开路径 */
  function refresh(): void {
    invalidate()
    void ensureChildren(ROOT)
    for (const p of expanded.value) {
      if (p.endsWith('::files')) void ensureFiles(p.slice(0, -'::files'.length))
      else void ensureChildren(p)
    }
  }

  /** 树版本推进（扫描 progress / scan:done），变化即失效重取 */
  function setRev(v: number): void {
    if (v === rev.value) return
    rev.value = v
    refresh()
  }

  function toggle(path: string): void {
    const next = new Set(expanded.value)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (path.endsWith('::files')) void ensureFiles(path.slice(0, -'::files'.length))
      else void ensureChildren(path)
    }
    expanded.value = next
  }

  function reset(): void {
    expanded.value = new Set()
    refresh()
  }

  function collapseAll(): void {
    expanded.value = new Set()
  }

  /** 全部展开：懒加载下只展开已加载缓存内的目录（数据随展开逐步取回） */
  function expandAll(): void {
    const next = new Set(expanded.value)
    for (const [dir, c] of Object.entries(childrenCache.value)) {
      if (!c || c === 'loading') continue
      for (const d of c.dirs) {
        if (d.childDirs > 0 || d.fileCount > 0) {
          next.add(d.path)
          void ensureChildren(d.path)
          if (d.childDirs > 0 && d.fileCount > 0) next.add(d.path + '::files')
        }
      }
      if (c.agg && c.agg.count > 0) {
        next.add(dir + '::files')
        if (dir !== ROOT) void ensureFiles(dir)
      }
    }
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
  // 初始拉取根级
  void ensureChildren(ROOT)

  // —— 摊平：把已缓存数据拼装成虚拟滚动平面行，缺失处以加载占位行补位 ——

  /** 聚合行的排序：名称排序恒排末尾；大小/重复按值并入（目录序后端已排好，稳定排序插入聚合） */
  function buildLevel(dir: string, depth: number): Array<TreeDirRow | TreeAggRow> {
    const c = childrenCache.value[dir]
    if (!c || c === 'loading') return []
    const items: Array<TreeDirRow | TreeAggRow> = c.dirs.map((d) => ({
      kind: 'dir' as const,
      data: d,
      depth
    }))
    if (c.agg) {
      items.push({
        kind: 'aggregate',
        path: dir + '::files',
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
    const walkChildren = (dir: string, depth: number): void => {
      const cached = childrenCache.value[dir]
      if (cached === undefined || cached === 'loading') {
        out.push({ kind: 'loading', depth })
        return
      }
      const level = buildLevel(dir, depth)
      for (const it of level) {
        out.push(it)
        if (it.kind === 'aggregate') {
          if (expanded.value.has(it.path)) walkFiles(it.parent, depth + 1)
          continue
        }
        if (!expanded.value.has(it.data.path)) continue
        if (it.data.childDirs > 0) walkChildren(it.data.path, depth + 1)
        if (it.data.childDirs === 0 && it.data.fileCount > 0) walkFiles(it.data.path, depth + 1)
      }
    }
    walkChildren(ROOT, 0)
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
    toggle,
    reset,
    expandAll,
    collapseAll
  }
})
