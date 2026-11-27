<template>
  <div class="graph-view">
    <div class="toolbar">
      <span class="stat">{{ summaryText }}</span>
      <label class="field">
        展示深度
        <select v-model.number="depth" class="input field-select">
          <option :value="2">二级目录</option>
          <option :value="3">三级目录</option>
          <option :value="4">四级目录</option>
        </select>
      </label>
      <label class="field">
        最小共享
        <select v-model.number="minMB" class="input field-select">
          <option :value="0.1">0.1 MB</option>
          <option :value="1">1 MB</option>
          <option :value="10">10 MB</option>
          <option :value="100">100 MB</option>
          <option :value="1024">1 GB</option>
        </select>
      </label>
      <button class="btn small" :disabled="loading" @click="reload">刷新布局</button>
    </div>

    <div ref="hostEl" class="canvas-host">
      <div v-if="showPlaceholder" class="hint-block">
        <template v-if="loading && reply === null">
          <span class="skeleton line w60"></span>
          <span class="skeleton line w40"></span>
        </template>
        <template v-else>{{ placeholderText }}</template>
      </div>

      <svg
        v-else
        class="graph-svg"
        :viewBox="`0 0 ${viewW} ${viewH}`"
        role="img"
        aria-label="目录层次边捆绑图"
      >
        <g class="edges">
          <path
            v-for="e in bundleEdges"
            :key="e.key"
            :d="e.d"
            :stroke-width="e.width"
            :class="{ hot: isHot(e), dim: isDim(e) }"
          />
        </g>
        <g class="nodes">
          <g
            v-for="n in placedNodes"
            :key="n.id"
            class="node"
            :class="{ dim: nodeDim(n) }"
            @mouseenter="hoverId = n.id"
            @mouseleave="hoverId = ''"
            @click="select(n.id)"
          >
            <circle
              :cx="n.px"
              :cy="n.py"
              :r="n.r"
              :class="{ active: selectedId === n.id, leaf: n.isEndpoint }"
            />
            <text
              v-if="n.label"
              :x="n.px"
              :y="n.py"
              :transform="`rotate(${n.labelRotate} ${n.px} ${n.py})`"
              :text-anchor="n.labelAnchor"
              dx="6"
              dy="3"
            >
              {{ shortName(n.name, 12) }}
            </text>
          </g>
        </g>
      </svg>

      <div v-if="focus" class="inspect">
        <div class="inspect-name" :title="focus.id">{{ focus.name }}</div>
        <div class="inspect-path" :title="focus.id">{{ focus.id }}</div>
        <div class="inspect-row">
          <span>体积</span><b>{{ formatBytes(focus.bytes) }}</b> <span>可回收</span
          ><b>{{ formatBytes(focus.reclaim) }}</b>
        </div>
      </div>
    </div>

    <div class="legend">
      <span>叶子 = 目录，连线沿目录树捆绑</span>
      <span>连线粗细 = 共享重复内容字节</span>
      <span class="muted">无向右图：仅表示共享强度，不推断时间/行为</span>
      <span v-if="reply && reply.truncatedGroups > 0" class="warn">
        已跳过 {{ reply.truncatedGroups }} 个噪声内容组
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cluster, hierarchy, type HierarchyPointNode } from 'd3-hierarchy'
import { curveBundle, line } from 'd3-shape'
import type { GraphEdge, GraphNode } from '../../../shared/types'
import { useGraphStore } from '../stores/graph'
import { useScanStore } from '../stores/scan'
import { useTreeSizeStore } from '../stores/treesize'
import { edgeWidth, shortName } from '../utils/graph'
import { formatBytes } from '../utils/format'

interface TreeDatum {
  id: string
  name: string
  bytes: number
  reclaim: number
  isEndpoint: boolean
  children: TreeDatum[]
}

interface PlacedNode {
  id: string
  name: string
  px: number
  py: number
  r: number
  isEndpoint: boolean
  label: boolean
  labelRotate: number
  labelAnchor: 'start' | 'end'
}

interface BundleEdge {
  key: string
  d: string
  width: number
  source: string
  target: string
}

const ROOT_ID = '\u0000root'
/** 关系端点上限：超出按体积取 Top，保证图可读 */
const MAX_ENDPOINTS = 180
/** 关系边上限：超出按共享字节取 Top */
const MAX_EDGES = 420
/** 静态标签上限：按体积取 Top，避免标签互相覆盖 */
const MAX_LABELS = 90

const graph = useGraphStore()
const treesize = useTreeSizeStore()
const scan = useScanStore()

const depth = ref(3)
const minMB = ref(1)
const hostEl = ref<HTMLElement | null>(null)
const viewW = ref(880)
const viewH = ref(560)
const placedNodes = ref<PlacedNode[]>([])
const bundleEdges = ref<BundleEdge[]>([])
const hoverId = ref('')
const selectedId = ref('')

const minBytes = computed(() => Math.round(minMB.value * 1024 * 1024))
const reply = computed(() => graph.replyOf(depth.value, minBytes.value))
const loading = computed(() => graph.loadingOf(depth.value, minBytes.value))
const error = computed(() => graph.errorOf(depth.value, minBytes.value))

const showPlaceholder = computed(() => {
  if (error.value) return true
  if (reply.value === null) return true
  if (reply.value.edges.length === 0) return true
  return placedNodes.value.length <= 1
})

const placeholderText = computed(() => {
  if (error.value) return error.value
  if (scan.status === 'scanning') return '扫描进行中，完成后自动生成目录关系'
  if (reply.value === null) return loading.value ? '' : '尚无扫描数据'
  if (reply.value.edges.length === 0) return '当前扫描结果中没有达到阈值的目录关系'
  return '当前阈值下没有可展示的目录关系'
})

const summaryText = computed(() => {
  const r = reply.value
  if (r === null) return '目录层次关系'
  return `${placedNodes.value.length} 个目录 · ${bundleEdges.value.length} 条关系`
})

const focus = computed(() => {
  const id = selectedId.value || hoverId.value
  if (!id) return null
  return reply.value?.nodes.find((n) => n.id === id) ?? null
})

const incident = computed<Record<string, GraphEdge[]>>(() => {
  const map: Record<string, GraphEdge[]> = {}
  for (const e of reply.value?.edges ?? []) {
    ;(map[e.source] ??= []).push(e)
    ;(map[e.target] ??= []).push(e)
  }
  return map
})

function isHot(e: BundleEdge): boolean {
  if (!hoverId.value) return false
  return e.source === hoverId.value || e.target === hoverId.value
}

function isDim(e: BundleEdge): boolean {
  return hoverId.value !== '' && !isHot(e)
}

function nodeDim(n: PlacedNode): boolean {
  const h = hoverId.value
  if (!h || n.id === h) return false
  const links = incident.value[h] ?? []
  return !links.some((e) => e.source === n.id || e.target === n.id)
}

function select(id: string): void {
  selectedId.value = selectedId.value === id ? '' : id
}

/** 由回包构建目录树并做径向捆绑布局（静态一次性计算） */
function layout(): void {
  const data = reply.value
  placedNodes.value = []
  bundleEdges.value = []
  if (!data || data.edges.length === 0) return

  const byId = new Map<string, GraphNode>(data.nodes.map((n) => [n.id, n]))
  const endpointSet = new Set<string>()
  for (const e of data.edges) {
    endpointSet.add(e.source)
    endpointSet.add(e.target)
  }
  // 端点上限：按体积取 Top
  if (endpointSet.size > MAX_ENDPOINTS) {
    const sorted = [...endpointSet]
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => n !== undefined)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, MAX_ENDPOINTS)
    endpointSet.clear()
    for (const n of sorted) endpointSet.add(n.id)
  }

  // 端点 + 祖先链一起进树
  const included = new Set<string>()
  for (const id of endpointSet) {
    let cur = byId.get(id)
    while (cur !== undefined) {
      included.add(cur.id)
      cur = cur.parentId && byId.has(cur.parentId) ? byId.get(cur.parentId) : undefined
    }
  }

  const childrenOf = new Map<string, string[]>()
  const roots: string[] = []
  for (const id of included) {
    const n = byId.get(id)
    if (!n) continue
    if (n.parentId !== '' && included.has(n.parentId)) {
      const arr = childrenOf.get(n.parentId)
      if (arr) arr.push(id)
      else childrenOf.set(n.parentId, [id])
    } else {
      roots.push(id)
    }
  }
  const build = (id: string): TreeDatum => {
    const n = byId.get(id) as GraphNode
    const kids = (childrenOf.get(id) ?? []).map(build).sort((a, b) => b.bytes - a.bytes)
    return {
      id,
      name: n.name,
      bytes: n.bytes,
      reclaim: n.reclaim,
      isEndpoint: endpointSet.has(id),
      children: kids
    }
  }
  const datums = roots.map(build).sort((a, b) => b.bytes - a.bytes)
  if (datums.length === 0) return
  const totalBytes = datums.reduce((sum, n) => sum + n.bytes, 0)
  const totalReclaim = datums.reduce((sum, n) => sum + n.reclaim, 0)
  const virtualRoot: TreeDatum = {
    id: ROOT_ID,
    name: '全部目标',
    bytes: totalBytes,
    reclaim: totalReclaim,
    isEndpoint: false,
    children: datums
  }

  const cx = viewW.value / 2
  const cy = viewH.value / 2
  const radius = Math.max(120, Math.min(viewW.value, viewH.value) / 2 - 104)
  const laid = cluster<TreeDatum>().size([Math.PI * 2, radius])(hierarchy(virtualRoot))
  const maxEndpointBytes = Math.max(1, ...[...endpointSet].map((id) => byId.get(id)?.bytes ?? 0))

  // 标签配额：按体积取 Top 的端点
  const labelIds = new Set(
    [...endpointSet]
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => n !== undefined)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, MAX_LABELS)
      .map((n) => n.id)
  )

  const placed: PlacedNode[] = []
  laid.each((node: HierarchyPointNode<TreeDatum>) => {
    if (node.data.id === ROOT_ID) return
    const angle = node.x
    const dist = node.y
    const px = cx + Math.cos(angle) * dist
    const py = cy + Math.sin(angle) * dist
    const isEndpoint = node.data.isEndpoint
    const r = isEndpoint ? 3 + 7 * Math.sqrt(Math.min(1, node.data.bytes / maxEndpointBytes)) : 2.6
    const deg = (angle * 180) / Math.PI
    let labelRotate = deg
    let labelAnchor: 'start' | 'end' = 'start'
    if (deg > 90 || deg < -90) {
      labelRotate = deg + 180
      labelAnchor = 'end'
    }
    placed.push({
      id: node.data.id,
      name: node.data.name,
      px,
      py,
      r,
      isEndpoint,
      label: isEndpoint && labelIds.has(node.data.id),
      labelRotate,
      labelAnchor
    })
  })

  // 关系边：用 d3 曲线沿目录树捆绑
  const layoutMap = new Map<string, HierarchyPointNode<TreeDatum>>()
  laid.each((node: HierarchyPointNode<TreeDatum>) => {
    if (node.data.id !== ROOT_ID) layoutMap.set(node.data.id, node)
  })
  const lineGen = line<HierarchyPointNode<TreeDatum>>()
    .curve(curveBundle.beta(0.85))
    .x((d) => cx + Math.cos(d.x) * d.y)
    .y((d) => cy + Math.sin(d.x) * d.y)

  const edgesOut: BundleEdge[] = []
  for (const e of data.edges) {
    if (!endpointSet.has(e.source) || !endpointSet.has(e.target)) continue
    const a = layoutMap.get(e.source)
    const b = layoutMap.get(e.target)
    if (!a || !b) continue
    const pathNodes = a.path(b) as HierarchyPointNode<TreeDatum>[]
    const d = lineGen(pathNodes)
    if (!d) continue
    edgesOut.push({
      key: `${e.source}\u0000${e.target}`,
      d,
      width: edgeWidth(e.sharedBytes),
      source: e.source,
      target: e.target
    })
  }
  edgesOut.sort((x, y) => y.width - x.width)
  bundleEdges.value = edgesOut.slice(0, MAX_EDGES)
  placedNodes.value = placed
  selectedId.value = ''
  hoverId.value = ''
}

let timer: number | undefined
let resizeObserver: ResizeObserver | null = null

async function refresh(force: boolean): Promise<void> {
  await graph.load(depth.value, minBytes.value, force)
  layout()
}

function reload(): void {
  void refresh(true)
}

function scheduleReload(): void {
  // 扫描期间不自动聚合：关系聚合需遍历整个会话，扫描期 rev 频繁推进会造成明显卡顿；
  // 扫描结束后由 scan.status 监听统一补一次（参数切换/手动刷新不受影响）
  if (scan.status === 'scanning') return
  if (timer !== undefined) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = undefined
    void refresh(true)
  }, 500)
}

function measure(): void {
  const el = hostEl.value
  if (!el) return
  const w = Math.max(1, el.clientWidth)
  const h = Math.max(1, el.clientHeight)
  if (w === viewW.value && h === viewH.value) return
  viewW.value = w
  viewH.value = h
  if (reply.value) layout()
}

watch([depth, minMB], () => void refresh(false))
watch(
  () => treesize.rev,
  () => scheduleReload()
)
// 扫描结束后补一次聚合：扫描期间不做自动刷新（成本随会话增长，会拖慢主进程）
watch(
  () => scan.status,
  (status, prev) => {
    if (status === 'done' && prev === 'scanning') scheduleReload()
  }
)
// KeepAlive 切回时元素尺寸可能已变化，补一次量测
onActivated(() => measure())

onMounted(() => {
  measure()
  resizeObserver = new ResizeObserver(() => measure())
  if (hostEl.value) resizeObserver.observe(hostEl.value)
  void refresh(false)
})

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearTimeout(timer)
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<style scoped>
.graph-view {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.stat {
  flex: 1;
  min-width: 0;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  white-space: nowrap;
}

.field-select {
  padding: 2px 6px;
}

.canvas-host {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.graph-svg {
  display: block;
  width: 100%;
  height: 100%;
}

.edges path {
  fill: none;
  stroke: var(--accent);
  stroke-opacity: 0.25;
  stroke-linecap: round;
  transition: stroke-opacity 0.12s ease;
}

.edges path.hot {
  stroke-opacity: 0.85;
}

.edges path.dim {
  stroke-opacity: 0.06;
}

.node {
  cursor: pointer;
}

.node circle {
  fill: var(--accent);
  fill-opacity: 0.2;
  stroke: var(--accent);
  stroke-width: 1;
}

.node circle.leaf {
  fill-opacity: 0.28;
}

.node:hover circle,
.node circle.active {
  fill-opacity: 0.6;
}

.node.dim {
  opacity: 0.3;
}

.node text {
  fill: var(--muted);
  font-size: 11px;
  pointer-events: none;
  user-select: none;
}

.hint-block {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--muted);
  padding: 24px;
  text-align: center;
}

.skeleton.line {
  height: 10px;
  border-radius: 5px;
}

.w60 {
  width: 60%;
}

.w40 {
  width: 40%;
}

.inspect {
  position: absolute;
  left: 12px;
  bottom: 12px;
  max-width: 420px;
  padding: 8px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: var(--shadow);
  font-size: 12px;
}

.inspect-name {
  font-weight: 600;
  margin-bottom: 2px;
}

.inspect-path {
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.inspect-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  color: var(--muted);
}

.inspect-row b {
  color: var(--text);
  margin-right: 4px;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}

.legend .muted {
  opacity: 0.8;
}

.warn {
  color: var(--danger);
}
</style>
