import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ScanTreeNode, TreeNodeFile } from '../../../shared/types'

export interface TreeDirRow {
  kind: 'dir'
  node: ScanTreeNode
  depth: number
}

export interface TreeFileRow {
  kind: 'file'
  path: string
  name: string
  size: number
  depth: number
}

/** 目录含子目录又有直属文件时的虚拟聚合条目（[n 个文件]） */
export interface TreeAggRow {
  kind: 'aggregate'
  path: string
  name: string
  size: number
  count: number
  depth: number
}

export type TreeRow = TreeDirRow | TreeFileRow | TreeAggRow

export type SortKey = 'name' | 'size' | 'dup'

/** 摊平层级内的一个待排序条目：子目录 / 直属文件 / 文件聚合 */
type Entry =
  | { t: 'dir'; node: ScanTreeNode }
  | { t: 'file'; file: TreeNodeFile }
  | { t: 'agg'; path: string; name: string; size: number; count: number; node: ScanTreeNode }

export const useTreeSizeStore = defineStore('treesize', () => {
  const tree = ref<ScanTreeNode[]>([])
  const expanded = ref<Set<string>>(new Set())

  const totalSize = computed(() => tree.value.reduce((sum, n) => sum + n.size, 0))
  const totalDup = computed(() => tree.value.reduce((sum, n) => sum + n.dupWasted, 0))
  const dirCount = computed(() => {
    let count = 0
    const walk = (nodes: ScanTreeNode[]): void => {
      for (const n of nodes) {
        count++
        walk(n.children)
      }
    }
    walk(tree.value)
    return count
  })

  /** 可见行中的全局最大体积，作为体积条的 100% 基准——
   *  所有目录按同一尺度缩放，子目录条长之和自然等于父目录条长 */
  const maxSize = computed(() =>
    rows.value.reduce((m, r) => Math.max(m, r.kind === 'dir' ? r.node.size : r.size), 0)
  )

  /** 可见行中的全局最大重复占用，作为重复条的 100% 基准 */
  const maxDup = computed(() =>
    rows.value.reduce((m, r) => Math.max(m, r.kind === 'dir' ? r.node.dupWasted : 0), 0)
  )

  /** 表头排序状态：默认按大小降序 */
  const sortKey = ref<SortKey>('size')
  const sortDesc = ref(true)

  /** 点击表头：同键翻转方向；换键用自然方向（名称升序，大小/重复降序） */
  function setSort(key: SortKey): void {
    if (sortKey.value === key) sortDesc.value = !sortDesc.value
    else {
      sortKey.value = key
      sortDesc.value = key !== 'name'
    }
  }

  const entryName = (e: Entry): string =>
    e.t === 'dir' ? e.node.name : e.t === 'file' ? e.file.name : e.name
  const entrySize = (e: Entry): number =>
    e.t === 'dir' ? e.node.size : e.t === 'file' ? e.file.size : e.size
  const entryDup = (e: Entry): number => (e.t === 'dir' ? e.node.dupWasted : 0)

  function cmpEntries(a: Entry, b: Entry): number {
    // 名称排序时 [n 个文件] 聚合条目恒排该层末尾
    if (sortKey.value === 'name' && (a.t === 'agg') !== (b.t === 'agg')) {
      return a.t === 'agg' ? 1 : -1
    }
    const dir = sortDesc.value ? -1 : 1
    if (sortKey.value === 'name') {
      return dir * entryName(a).localeCompare(entryName(b), undefined, { numeric: true })
    }
    if (sortKey.value === 'dup') return dir * (entryDup(a) - entryDup(b))
    return dir * (entrySize(a) - entrySize(b))
  }

  function cmpFiles(a: TreeNodeFile, b: TreeNodeFile): number {
    const dir = sortDesc.value ? -1 : 1
    if (sortKey.value === 'name') {
      return dir * a.name.localeCompare(b.name, undefined, { numeric: true })
    }
    return dir * (a.size - b.size)
  }

  /** 一个已展开目录层级内的条目：子目录 + （逐文件 或 [n 个文件] 聚合） */
  const entriesOf = (n: ScanTreeNode): Entry[] => {
    const entries: Entry[] = n.children.map((node) => ({ t: 'dir', node }))
    if (n.children.length === 0) {
      for (const file of n.files) entries.push({ t: 'file', file })
    } else if (n.files.length > 0) {
      entries.push({
        t: 'agg',
        node: n,
        path: n.path + '::files',
        name: `[${n.files.length} 个文件]`,
        size: n.files.reduce((s, f) => s + f.size, 0),
        count: n.files.length
      })
    }
    return entries
  }

  /** 按展开状态与排序键把树摊平成定高行；聚合条目可再展开为逐文件条目 */
  const rows = computed<TreeRow[]>(() => {
    const out: TreeRow[] = []
    const walkLevel = (n: ScanTreeNode, depth: number): void => {
      for (const e of entriesOf(n).sort(cmpEntries)) {
        if (e.t === 'dir') {
          out.push({ kind: 'dir', node: e.node, depth })
          if (expanded.value.has(e.node.path)) walkLevel(e.node, depth + 1)
        } else if (e.t === 'file') {
          out.push({
            kind: 'file',
            path: e.file.path,
            name: e.file.name,
            size: e.file.size,
            depth
          })
        } else {
          out.push({
            kind: 'aggregate',
            path: e.path,
            name: e.name,
            size: e.size,
            count: e.count,
            depth
          })
          if (expanded.value.has(e.path)) {
            for (const f of [...e.node.files].sort(cmpFiles)) {
              out.push({
                kind: 'file',
                path: f.path,
                name: f.name,
                size: f.size,
                depth: depth + 1
              })
            }
          }
        }
      }
    }
    for (const root of [...tree.value].sort((a, b) =>
      cmpEntries({ t: 'dir', node: a }, { t: 'dir', node: b })
    )) {
      out.push({ kind: 'dir', node: root, depth: 0 })
      if (expanded.value.has(root.path)) walkLevel(root, 1)
    }
    return out
  })

  function setTree(t: ScanTreeNode[], keepExpanded = false): void {
    tree.value = t
    // 渐进更新（扫描中每秒一次）保留展开状态；整树替换（新一轮扫描）重置
    if (!keepExpanded) expanded.value = new Set()
  }

  function toggle(path: string): void {
    const next = new Set(expanded.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expanded.value = next
  }

  function reset(): void {
    tree.value = []
    expanded.value = new Set()
  }

  function expandAll(): void {
    const next = new Set<string>()
    const walk = (nodes: ScanTreeNode[]): void => {
      for (const n of nodes) {
        if (n.children.length > 0 || n.files.length > 0) {
          next.add(n.path)
          // 既有子目录又有文件的目录，「全部展开」同时展开文件聚合
          if (n.children.length > 0 && n.files.length > 0) next.add(n.path + '::files')
          walk(n.children)
        }
      }
    }
    walk(tree.value)
    expanded.value = next
  }

  function collapseAll(): void {
    expanded.value = new Set()
  }

  return {
    tree,
    expanded,
    sortKey,
    sortDesc,
    setSort,
    totalSize,
    totalDup,
    dirCount,
    maxSize,
    maxDup,
    rows,
    setTree,
    toggle,
    reset,
    expandAll,
    collapseAll
  }
})
