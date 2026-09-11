import { defineStore } from 'pinia'
import { ref } from 'vue'
import { defaultScanDraft } from '../../../shared/defaults'
import type { ScanProgress, ScanSettings, ScanSummary } from '../../../shared/types'
import { useDupeStore } from './dupe'
import { useTargetStore } from './target'
import { deepPlain } from '../utils/plain'

export type ScanStatus = 'idle' | 'scanning' | 'done' | 'error'

export const useScanStore = defineStore('scan', () => {
  const draft = ref<ScanSettings>(defaultScanDraft())
  const sessionId = ref('')
  const status = ref<ScanStatus>('idle')
  const progress = ref<ScanProgress | null>(null)
  const summary = ref<ScanSummary | null>(null)
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
    useDupeStore().markScanDone()
  })
  window.api.onScanError((p) => {
    if (status.value !== 'scanning') return
    adopt(p.sessionId)
    error.value = p.message
    status.value = 'error'
  })

  async function start(): Promise<void> {
    if (status.value === 'scanning') return
    const targets = useTargetStore().targets
    if (targets.length === 0) throw new Error('请先在左侧添加扫描目标')
    draft.value = { ...draft.value, targets: [...targets] }
    useDupeStore().reset()
    summary.value = null
    progress.value = null
    error.value = ''
    sessionId.value = ''
    status.value = 'scanning'
    try {
      sessionId.value = await window.api.scanStart(deepPlain(draft.value))
    } catch (err) {
      status.value = 'error'
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  function stop(): void {
    if (sessionId.value) window.api.scanStop(sessionId.value)
  }

  return { draft, sessionId, status, progress, summary, error, initDraft, start, stop }
})
