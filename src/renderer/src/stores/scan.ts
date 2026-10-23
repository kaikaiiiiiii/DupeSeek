import { defineStore } from 'pinia'
import { ref } from 'vue'
import { defaultScanDraft } from '../../../shared/defaults'
import type { ScanProgress, ScanSettings, ScanSummary } from '../../../shared/types'
import { useDupeStore } from './dupe'
import { useSettingsStore } from './settings'
import { useTargetStore } from './target'
import { useTreeSizeStore } from './treesize'
import { deepPlain } from '../utils/plain'

export type ScanStatus = 'idle' | 'scanning' | 'done' | 'error'

export const useScanStore = defineStore('scan', () => {
  const draft = ref<ScanSettings>(defaultScanDraft())
  const sessionId = ref('')
  const status = ref<ScanStatus>('idle')
  const progress = ref<ScanProgress | null>(null)
  const summary = ref<ScanSummary | null>(null)
  /** 各扫描目标的独立进度（0-100）；扫描正常结束后完成的目标保持 100 */
  const targetProgress = ref<Record<string, number>>({})
  /** 已同步到引擎的目标集合（增量 diff 的基准） */
  const syncedTargets = ref<string[]>([])
  const error = ref('')

  function initDraft(saved: ScanSettings): void {
    draft.value = { ...defaultScanDraft(), ...saved }
  }

  // 事件订阅在 store 首次实例化时注册一次。
  // sessionId 由主进程生成、经 invoke 返回值晚于事件到达，无法作为事件守卫；
  // 改为按状态放行，并在首个事件到达时收养其 sessionId（用于 scan:stop）。
  function adopt(id: string): void {
    if (sessionId.value === '') sessionId.value = id
  }

  window.api.onScanProgress((p) => {
    if (status.value !== 'scanning') return
    adopt(p.sessionId)
    progress.value = p
    if (p.targets) {
      const next = { ...targetProgress.value }
      for (const t of p.targets) next[t.path] = t.percent
      targetProgress.value = next
    }
    // 渐进体积树（约 1s 一次）：扫描期间空间分析同步生长，保留展开状态
    if (p.tree) useTreeSizeStore().setTree(p.tree, true)
  })
  window.api.onScanGroup((p) => {
    if (status.value !== 'scanning') return
    adopt(p.sessionId)
    useDupeStore().appendGroups(p.groups)
  })
  window.api.onScanDone((s) => {
    if (status.value !== 'scanning') return
    adopt(s.sessionId)
    summary.value = s
    status.value = 'done'
    syncedTargets.value = [...useTargetStore().targets]
    // 正常完成：各目标进度条保持满格；被取消的保留最后实际进度
    if (!s.canceled) {
      const next = { ...targetProgress.value }
      for (const t of syncedTargets.value) next[t] = 100
      targetProgress.value = next
    }
    useDupeStore().markScanDone()
    useTreeSizeStore().setTree(s.tree)
  })
  window.api.onScanError((p) => {
    if (status.value !== 'scanning') return
    adopt(p.sessionId)
    error.value = p.message
    status.value = 'error'
  })

  /**
   * 目标列表同步（增量）：新增目标增量扫描并与现有条目比桶；
   * 移除目标纯内存清理（无磁盘 I/O）。现有条目的哈希记忆化全部保留。
   */
  async function syncTargets(): Promise<void> {
    if (status.value === 'scanning') return
    const targets = useTargetStore().targets
    if (targets.length === 0) throw new Error('请先在左侧添加扫描目标')

    // 移除目标的乐观内存清理（引擎侧同步做同样的清理）
    const removed = syncedTargets.value.filter((t) => !targets.includes(t))
    if (removed.length > 0) useDupeStore().purgeTargets(removed)

    // 进度条：新目标归零，未变目标保留（已完成的保持满格），移除的剔除
    const next: Record<string, number> = {}
    for (const t of targets) {
      next[t] = syncedTargets.value.includes(t) ? (targetProgress.value[t] ?? 0) : 0
    }
    targetProgress.value = next

    draft.value = { ...draft.value, targets: [...targets] }
    void useSettingsStore().patch({ scanDraft: deepPlain(draft.value) })
    summary.value = null
    progress.value = null
    error.value = ''
    sessionId.value = ''
    status.value = 'scanning'
    try {
      const done = await window.api.scanSync(deepPlain(draft.value))
      if (done && typeof done === 'object') summary.value = done
      syncedTargets.value = [...targets]
      if (!summary.value?.canceled) {
        const full = { ...targetProgress.value }
        for (const t of targets) full[t] = 100
        targetProgress.value = full
      }
      status.value = 'done'
      if (Array.isArray(summary.value?.tree)) {
        useTreeSizeStore().setTree(summary.value.tree)
      }
    } catch (err) {
      status.value = 'error'
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  /** 整体重扫：清空引擎会话状态与全部结果后按当前目标全量扫描 */
  async function rescanAll(): Promise<void> {
    if (status.value === 'scanning') return
    const targets = useTargetStore().targets
    if (targets.length === 0) throw new Error('请先在左侧添加扫描目标')

    useDupeStore().reset()
    useTreeSizeStore().reset()
    syncedTargets.value = []
    targetProgress.value = {}
    draft.value = { ...draft.value, targets: [...targets] }
    void useSettingsStore().patch({ scanDraft: deepPlain(draft.value) })
    summary.value = null
    progress.value = null
    error.value = ''
    sessionId.value = ''
    status.value = 'scanning'
    try {
      const done = await window.api.scanRescan(deepPlain(draft.value))
      if (done && typeof done === 'object') summary.value = done
      syncedTargets.value = [...targets]
      if (!summary.value?.canceled) {
        const full = { ...targetProgress.value }
        for (const t of targets) full[t] = 100
        targetProgress.value = full
      }
      status.value = 'done'
      if (Array.isArray(summary.value?.tree)) {
        useTreeSizeStore().setTree(summary.value.tree)
      }
    } catch (err) {
      status.value = 'error'
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  function stop(): void {
    if (sessionId.value) window.api.scanStop(sessionId.value)
  }

  return {
    draft,
    sessionId,
    status,
    progress,
    summary,
    targetProgress,
    syncedTargets,
    error,
    initDraft,
    syncTargets,
    rescanAll,
    stop
  }
})
