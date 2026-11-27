import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { GraphRelationsReply } from '../../../shared/types'

export function graphQueryKey(maxDepth: number, minSharedBytes: number): string {
  return `${maxDepth}:${minSharedBytes}`
}

/**
 * 目录关系图数据缓存（两个关系视图共用）：按「展示深度 + 最小共享字节」缓存，
 * 扫描版本推进时由视图强制刷新。聚合在主进程完成（graph:relations），
 * 渲染层不持有重复内容明细。见 docs/Relations.md。
 */
export const useGraphStore = defineStore('graph', () => {
  const cache = ref<Record<string, GraphRelationsReply>>({})
  const loading = ref<Set<string>>(new Set())
  const errors = ref<Record<string, string>>({})

  function replyOf(maxDepth: number, minSharedBytes: number): GraphRelationsReply | null {
    return cache.value[graphQueryKey(maxDepth, minSharedBytes)] ?? null
  }

  function loadingOf(maxDepth: number, minSharedBytes: number): boolean {
    return loading.value.has(graphQueryKey(maxDepth, minSharedBytes))
  }

  function errorOf(maxDepth: number, minSharedBytes: number): string {
    return errors.value[graphQueryKey(maxDepth, minSharedBytes)] ?? ''
  }

  async function load(maxDepth: number, minSharedBytes: number, force = false): Promise<void> {
    const key = graphQueryKey(maxDepth, minSharedBytes)
    if (loading.value.has(key)) return
    if (cache.value[key] !== undefined && !force) return
    loading.value = new Set(loading.value).add(key)
    try {
      const res = await window.api.graphRelations(maxDepth, minSharedBytes)
      cache.value = { ...cache.value, [key]: res }
      errors.value = { ...errors.value, [key]: '' }
    } catch (err) {
      errors.value = {
        ...errors.value,
        [key]: err instanceof Error ? err.message : String(err)
      }
    } finally {
      const next = new Set(loading.value)
      next.delete(key)
      loading.value = next
    }
  }

  return { cache, loading, errors, replyOf, loadingOf, errorOf, load }
})
