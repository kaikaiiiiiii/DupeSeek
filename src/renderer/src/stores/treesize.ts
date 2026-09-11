import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ScanTreeNode } from '../../../shared/types'

export interface TreeRow {
  node: ScanTreeNode
  depth: number
}

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

  /** 按展开状态把树摊平成定高行，交给虚拟滚动 */
  const rows = computed<TreeRow[]>(() => {
    const out: TreeRow[] = []
    const flatten = (nodes: ScanTreeNode[], depth: number): void => {
      for (const n of nodes) {
        out.push({ node: n, depth })
        if (n.children.length > 0 && expanded.value.has(n.path)) flatten(n.children, depth + 1)
      }
    }
    flatten(tree.value, 0)
    return out
  })

  function setTree(t: ScanTreeNode[]): void {
    tree.value = t
    expanded.value = new Set()
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
    rows,
    setTree,
    toggle,
    reset,
    expandAll,
    collapseAll
  }
})
