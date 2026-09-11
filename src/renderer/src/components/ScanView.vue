<template>
  <div class="scan-view">
    <div class="form-card">
      <div class="form-title">扫描选项</div>

      <label class="check-row"
        ><input v-model="scan.draft.ignoreName" type="checkbox" /> 忽略文件名（仅按大小分组）</label
      >
      <label class="check-row"
        ><input v-model="scan.draft.excludeHidden" type="checkbox" /> 排除隐藏文件</label
      >
      <label class="check-row"
        ><input v-model="scan.draft.excludeSystem" type="checkbox" /> 排除系统文件</label
      >
      <label class="check-row"
        ><input v-model="scan.draft.excludeJunction" type="checkbox" /> 排除 junction /
        链接目录（防循环）</label
      >
      <label class="check-row"
        ><input v-model="scan.draft.scanArchives" type="checkbox" /> 扫描压缩包内文件
        （zip/7z/rar，仅查重，不改动压缩包）</label
      >

      <div class="size-row">
        <label class="check-row"><input v-model="useMin" type="checkbox" /> 排除小于</label>
        <input
          v-model.number="minVal"
          class="input num"
          type="number"
          min="0"
          :disabled="!useMin"
        />
        <select v-model="minUnit" class="input" :disabled="!useMin">
          <option value="KB">KB</option>
          <option value="MB">MB</option>
          <option value="GB">GB</option>
        </select>
      </div>
      <div class="size-row">
        <label class="check-row"><input v-model="useMax" type="checkbox" /> 排除大于</label>
        <input
          v-model.number="maxVal"
          class="input num"
          type="number"
          min="0"
          :disabled="!useMax"
        />
        <select v-model="maxUnit" class="input" :disabled="!useMax">
          <option value="KB">KB</option>
          <option value="MB">MB</option>
          <option value="GB">GB</option>
        </select>
      </div>

      <div class="text-row">
        <label class="text-label">扩展名黑名单</label>
        <input v-model="blacklistText" class="input grow" placeholder="如 exe,dll（逗号分隔）" />
      </div>
      <div class="text-row">
        <label class="text-label">扩展名白名单</label>
        <input v-model="whitelistText" class="input grow" placeholder="留空表示不限制" />
      </div>
    </div>

    <div class="run-card">
      <div class="run-row">
        <button
          v-if="scan.status !== 'scanning'"
          class="btn primary"
          :disabled="targets.length === 0"
          @click="startScan"
        >
          开始扫描（{{ targets.length }} 个目标）
        </button>
        <button v-else class="btn danger" @click="scan.stop()">停止扫描</button>
      </div>

      <div v-if="scan.status === 'scanning' && scan.progress" class="progress-area">
        <progress class="bar" :value="scan.progress.percent" max="100"></progress>
        <div class="progress-meta">
          <span
            >{{ phaseLabel(scan.progress.phase) }} · {{ scan.progress.percent.toFixed(0) }}%</span
          >
          <span class="elapsed" title="本次扫描已用时">⏱ {{ elapsedLabel }}</span>
          <span
            >{{ scan.progress.filesFound }} 个候选 · 已哈希
            {{ formatBytes(scan.progress.bytesHashed) }}</span
          >
        </div>
        <div v-if="scan.progress.denied > 0" class="elevate-box">
          <span class="elevate-text">
            有 {{ scan.progress.denied }} 个文件或目录需要管理员权限才能读取，本次结果可能不完整。
          </span>
          <button class="btn small primary" :disabled="elevating" @click="elevate">
            以管理员身份重启并重新扫描
          </button>
          <span v-if="elevateMsg" class="elevate-msg">{{ elevateMsg }}</span>
        </div>
        <div class="current-path" :title="scan.progress.currentPath">
          {{ scan.progress.currentPath }}
        </div>
      </div>

      <div v-if="scan.status === 'done' && scan.summary" class="summary">
        完成：{{ scan.summary.filesFound }} 个文件，{{ scan.summary.dupeGroups }} 组重复， 可释放
        {{ formatBytes(scan.summary.wastedBytes) }}，耗时
        {{ (scan.summary.durationMs / 1000).toFixed(1) }} 秒
        <span v-if="scan.summary.canceled">（已取消）</span>
        <span v-if="scan.summary.errors > 0">，{{ scan.summary.errors }} 项读取失败</span>
        <span v-if="scan.summary.denied > 0">，其中 {{ scan.summary.denied }} 项权限不足</span>
      </div>
      <div v-if="scan.status === 'error'" class="summary error">{{ scan.error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ScanPhase } from '../../../shared/types'
import { useScanStore } from '../stores/scan'
import { useTargetStore } from '../stores/target'
import { formatBytes, formatDuration } from '../utils/format'

const scan = useScanStore()
const targets = computed(() => useTargetStore().targets)

// 扫描计时：基于起始时间戳计算，切 Tab（KeepAlive）期间照常走表
const elapsedMs = ref(0)
const elapsedLabel = computed(() => formatDuration(elapsedMs.value))
let startedAt = 0
let timer: ReturnType<typeof setInterval> | undefined

watch(
  () => scan.status,
  (status) => {
    clearInterval(timer)
    if (status === 'scanning') {
      startedAt = Date.now()
      elapsedMs.value = 0
      timer = setInterval(() => {
        elapsedMs.value = Date.now() - startedAt
      }, 500)
    }
  }
)

onBeforeUnmount(() => clearInterval(timer))

type SizeUnit = 'KB' | 'MB' | 'GB'
const UNIT_BYTES: Record<SizeUnit, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }

const useMin = ref(false)
const useMax = ref(false)
const minVal = ref<number | null>(null)
const maxVal = ref<number | null>(null)
const minUnit = ref<SizeUnit>('MB')
const maxUnit = ref<SizeUnit>('GB')
const blacklistText = ref('')
const whitelistText = ref('')

const elevating = ref(false)
const elevateMsg = ref('')

/** 请求 UAC 提权：成功后主进程会保存续扫标记并退出，由管理员实例自动重扫 */
async function elevate(): Promise<void> {
  elevating.value = true
  elevateMsg.value = ''
  try {
    const ok = await window.api.elevate()
    elevateMsg.value = ok
      ? '已获得授权，正在以管理员身份重启…'
      : '未获得授权（UAC 被取消或被系统策略拒绝）'
  } catch {
    elevateMsg.value = '提权请求失败'
  } finally {
    elevating.value = false
  }
}

onMounted(() => {
  const d = scan.draft
  if (d.minSize !== null) {
    useMin.value = true
    minVal.value = Math.round(d.minSize / UNIT_BYTES.MB)
    minUnit.value = 'MB'
  }
  if (d.maxSize !== null) {
    useMax.value = true
    maxVal.value = Math.round(d.maxSize / UNIT_BYTES.GB)
    maxUnit.value = 'GB'
  }
  blacklistText.value = d.extBlacklist.join(',')
  whitelistText.value = d.extWhitelist.join(',')
})

function parseExtList(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((s) => s.trim().replace(/^\./, '').toLowerCase())
    .filter((s) => s !== '')
}

function toBytes(enabled: boolean, val: number | null, unit: SizeUnit): number | null {
  if (!enabled || val === null || val < 0) return null
  return Math.round(val * UNIT_BYTES[unit])
}

function phaseLabel(phase: ScanPhase): string {
  switch (phase) {
    case 'listing':
      return '正在枚举文件'
    case 'hashing':
      return '正在比对哈希'
    case 'finalizing':
      return '正在收尾'
  }
}

async function startScan(): Promise<void> {
  scan.draft.minSize = toBytes(useMin.value, minVal.value, minUnit.value)
  scan.draft.maxSize = toBytes(useMax.value, maxVal.value, maxUnit.value)
  scan.draft.extBlacklist = parseExtList(blacklistText.value)
  scan.draft.extWhitelist = parseExtList(whitelistText.value)
  try {
    await scan.start()
  } catch {
    // 错误已写入 scan.error 展示
  }
}
</script>

<style scoped>
.scan-view {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.form-card,
.run-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  padding: 12px;
}

.form-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  cursor: pointer;
}

.size-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 4px 20px;
}

.input.num {
  width: 90px;
}

.text-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 4px 20px;
}

.text-label {
  width: 96px;
  color: var(--muted);
}

.run-row {
  display: flex;
  gap: 8px;
}

.progress-area {
  margin-top: 10px;
}

.bar {
  width: 100%;
  height: 14px;
}

.progress-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  color: var(--muted);
}

.elapsed {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.current-path {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.elevate-box {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--danger);
  border-radius: 4px;
}

.elevate-text {
  flex: 1;
  color: var(--danger);
}

.elevate-msg {
  color: var(--muted);
  white-space: nowrap;
}

.summary {
  margin-top: 10px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--hover-bg);
}

.summary.error {
  color: var(--danger);
  background: none;
  border: 1px solid var(--danger);
}
</style>
