import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ScanTreeNode } from '../../../shared/types'

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

  /** 按展开状态把树摊平成定高行，交给虚拟滚动。
   *  文件展示规则：展开无子目录的目录逐个列出文件；既有子目录又有文件的，
   *  文件合并为 `[n 个文件]` 虚拟条目与子目录并列 */
  const rows = computed<TreeRow[]>(() => {
    const out: TreeRow[] = []
    const flatten = (nodes: ScanTreeNode[], depth: number): void => {
      for (const n of nodes) {
        out.push({ kind: 'dir', node: n, depth })
        if (!expanded.value.has(n.path)) continue
        flatten(n.children, depth + 1)
        if (n.children.length === 0) {
          for (const f of n.files) {
            out.push({ kind: 'file', path: f.path, name: f.name, size: f.size, depth: depth + 1 })
          }
        } else if (n.files.length > 0) {
          const size = n.files.reduce((s, f) => s + f.size, 0)
          out.push({
            kind: 'aggregate',
            path: n.path + '::files',
            name: `[${n.files.length} 个文件]`,
            size,
            count: n.files.length,
            depth: depth + 1
          })
        }
      }
    }
    flatten(tree.value, 0)
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
        if (n.children.length > 0) {
          next.add(n.path)
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
