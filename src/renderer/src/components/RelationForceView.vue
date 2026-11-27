<template>
  <div class="graph-view">
    <div class="toolbar">
      <span class="stat">{{ summaryText }}</span>
      <label class="field">
        展示深度
        <select v-model.number="depth" class="input field-select">
          <option :value="1">一级目录</option>
          <option :value="2">二级目录</option>
          <option :value="3">三级目录</option>
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
        aria-label="目录关系气泡图"
      >
        <g class="edges">
          <line
            v-for="e in drawnLinks"
            :key="e.key"
            :x1="pos(e.edge.source).x"
            :y1="pos(e.edge.source).y"
            :x2="pos(e.edge.target).x"
            :y2="pos(e.edge.target).y"
            :stroke-width="e.width"
            :class="{ hot: isEdgeHot(e), dim: edgeDim(e) }"
          />
        </g>
        <g class="nodes">
          <g
            v-for="n in drawnNodes"
            :key="n.id"
            class="node"
            :class="{ dim: nodeDim(n) }"
            @mouseenter="hoverId = n.id"
            @mouseleave="hoverId = ''"
            @click="select(n.id)"
          >
            <circle
              :cx="pos(n.id).x"
              :cy="pos(n.id).y"
              :r="n.dr"
              :class="{ active: selectedId === n.id }"
            />
            <text v-if="n.label" :x="pos(n.id).x" :y="pos(n.id).y + n.dr + 13" text-anchor="middle">
              {{ shortName(n.node.name) }}
            </text>
          </g>
        </g>
      </svg>

      <div v-if="focus" class="inspect">
        <div class="inspect-name" :title="focus.node.id">{{ focus.node.name }}</div>
        <div class="inspect-path" :title="focus.node.id">{{ focus.node.id }}</div>
        <div class="inspect-row">
          <span>体积</span><b>{{ formatBytes(focus.node.bytes) }}</b> <span>可回收</span
          ><b>{{ formatBytes(focus.node.reclaim) }}</b> <span>关系</span
          ><b>{{ focus.degree }} 个目录</b>
        </div>
      </div>
    </div>

    <div class="legend">
      <span>气泡面积 = 目录体积</span>
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
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import type { GraphEdge, GraphNode } from '../../../shared/types'
import { useGraphStore } from '../stores/graph'
import { useScanStore } from '../stores/scan'
import { useTreeSizeStore } from '../stores/treesize'
import { edgeWidth, nodeRadius, shortName } from '../utils/graph'
import { formatBytes } from '../utils/format'

interface SimNode extends SimulationNodeDatum {
  id: string
  node: GraphNode
  /** 布局半径（collide/碰撞用） */
  r: number
  /** 显示半径（视口自适应缩放后） */
  dr: number
  degree: number
  /** 是否显示静态标签（按体积取 Top） */
  label: boolean
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  key: string
  width: number
  edge: GraphEdge
}

interface Point {
  x: number
  y: number
}

/** 力导向视图的节点上限：超出按体积取 Top，避免变成毛球 */
const MAX_FORCE_NODES = 220
/** 力导向视图的边上限：超出按共享字节取 Top，避免渲染/布局卡死 */
const MAX_FORCE_LINKS = 600
/** 预迭代数：同步跑完布局再一次性渲染，避免逐帧重排 */
const TICKS = 200

const graph = useGraphStore()
const treesize = useTreeSizeStore()
const scan = useScanStore()

const depth = ref(1)
const minMB = ref(1)
const hostEl = ref<HTMLElement | null>(null)
const viewW = ref(880)
const viewH = ref(560)
const nodes = ref<SimNode[]>([])
const links = ref<SimLink[]>([])
const positions = ref<Record<string, Point>>({})
const hoverId = ref('')
const selectedId = ref('')

const minBytes = computed(() => Math.round(minMB.value * 1024 * 1024))
const reply = computed(() => graph.replyOf(depth.value, minBytes.value))
const loading = computed(() => graph.loadingOf(depth.value, minBytes.value))
const error = computed(() => graph.errorOf(depth.value, minBytes.value))
const drawnNodes = computed(() => nodes.value)
const drawnLinks = computed(() => links.value)

const showPlaceholder = computed(() => {
  if (error.value) return true
  if (reply.value === null) return true
  if (reply.value.edges.length === 0) return true
  return drawnNodes.value.length === 0
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
  if (r === null) return '目录关系'
  const shown = drawnNodes.value.length
  const total = r.nodes.length
  return `显示 ${shown} / ${total} 个目录 · ${drawnLinks.value.length} 条关系`
})

const focus = computed(() => {
  const id = selectedId.value || hoverId.value
  if (!id) return null
  const node = nodes.value.find((n) => n.id === id)
  if (!node) return null
  return { node: node.node, degree: node.degree }
})

function pos(id: string): Point {
  return positions.value[id] ?? { x: 0, y: 0 }
}

function nodeDim(n: SimNode): boolean {
  if (!hoverId.value) return false
  if (n.id === hoverId.value) return false
  return !isNeighbor(n.id)
}

function isNeighbor(id: string): boolean {
  const h = hoverId.value
  if (!h) return false
  for (const e of reply.value?.edges ?? []) {
    if (e.source === h && e.target === id) return true
    if (e.target === h && e.source === id) return true
  }
  return false
}

function isEdgeHot(e: SimLink): boolean {
  if (!hoverId.value) return false
  return e.edge.source === hoverId.value || e.edge.target === hoverId.value
}

function edgeDim(e: SimLink): boolean {
  if (!hoverId.value) return false
  return !isEdgeHot(e)
}

function select(id: string): void {
  selectedId.value = selectedId.value === id ? '' : id
}

/** 同步跑完力导向布局后一次性写入坐标（数据变化/尺寸变化时重建） */
function layout(): void {
  const sim = simRef.value
  if (sim) {
    sim.stop()
    simRef.value = null
  }
  const data = reply.value
  if (!data || data.edges.length === 0) {
    nodes.value = []
    links.value = []
    positions.value = {}
    return
  }

  const maxBytes = data.nodes.reduce((m, n) => Math.max(m, n.bytes), 0)
  let degree = new Map<string, number>()
  const degreeOfEdges = (edges: GraphEdge[]): Map<string, number> => {
    const map = new Map<string, number>()
    for (const e of edges) {
      map.set(e.source, (map.get(e.source) ?? 0) + 1)
      map.set(e.target, (map.get(e.target) ?? 0) + 1)
    }
    return map
  }
  degree = degreeOfEdges(data.edges)
  let shown = data.nodes.filter((n) => (degree.get(n.id) ?? 0) > 0)
  if (shown.length > MAX_FORCE_NODES) {
    shown = [...shown].sort((a, b) => b.bytes - a.bytes).slice(0, MAX_FORCE_NODES)
  }
  let ids = new Set(shown.map((n) => n.id))
  let shownEdges = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  if (shownEdges.length > MAX_FORCE_LINKS) {
    shownEdges = [...shownEdges]
      .sort((a, b) => b.sharedBytes - a.sharedBytes)
      .slice(0, MAX_FORCE_LINKS)
  }
  // 截断后重算度数，剔除因边上限而变孤立的节点
  degree = degreeOfEdges(shownEdges)
  shown = shown.filter((n) => (degree.get(n.id) ?? 0) > 0)
  ids = new Set(shown.map((n) => n.id))
  shownEdges = shownEdges.filter((e) => ids.has(e.source) && ids.has(e.target))

  const cx = viewW.value / 2
  const cy = viewH.value / 2
  const simNodes: SimNode[] = shown.map((n, i) => {
    const angle = i * 2.399963
    const radius = 36 + 15 * Math.sqrt(i)
    return {
      id: n.id,
      node: n,
      r: nodeRadius(n.bytes, maxBytes),
      dr: 0,
      degree: degree.get(n.id) ?? 0,
      label: false,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    }
  })
  const byId = new Map(simNodes.map((n) => [n.id, n]))
  const simLinks: SimLink[] = shownEdges.map((e) => ({
    source: byId.get(e.source) as SimNode,
    target: byId.get(e.target) as SimNode,
    key: `${e.source}\u0000${e.target}`,
    width: edgeWidth(e.sharedBytes),
    edge: e
  }))

  const simulation = forceSimulation<SimNode, SimLink>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance(96)
        .strength(0.16)
    )
    .force('charge', forceManyBody<SimNode>().strength(-260).distanceMax(700))
    .force('center', forceCenter(cx, cy))
    .force(
      'collide',
      forceCollide<SimNode>().radius((d) => d.r + 5)
    )
    .force('x', forceX<SimNode>(cx).strength(0.02))
    .force('y', forceY<SimNode>(cy).strength(0.02))
    .stop()

  simRef.value = simulation
  for (let i = 0; i < TICKS; i++) simulation.tick()

  // 视口自适应：整体缩放/居中到画布内（含节点半径），避免边角节点被裁切
  const pad = 40
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of simNodes) {
    const x = n.x ?? cx
    const y = n.y ?? cy
    minX = Math.min(minX, x - n.r)
    maxX = Math.max(maxX, x + n.r)
    minY = Math.min(minY, y - n.r)
    maxY = Math.max(maxY, y + n.r)
  }
  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const scale = Math.max(
    0.3,
    Math.min(
      1.6,
      Math.max(40, viewW.value - pad * 2) / bw,
      Math.max(40, viewH.value - pad * 2) / bh
    )
  )
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2
  const labelIds = new Set(
    [...simNodes]
      .sort((a, b) => b.node.bytes - a.node.bytes)
      .slice(0, 14)
      .map((n) => n.id)
  )
  const next: Record<string, Point> = {}
  for (const n of simNodes) {
    n.dr = Math.max(2.5, n.r * scale)
    n.label = labelIds.has(n.id)
    next[n.id] = {
      x: ((n.x ?? cx) - midX) * scale + viewW.value / 2,
      y: ((n.y ?? cy) - midY) * scale + viewH.value / 2
    }
  }

  nodes.value = simNodes
  links.value = simLinks
  positions.value = next
  selectedId.value = ''
  hoverId.value = ''
}

const simRef = ref<Simulation<SimNode, SimLink> | null>(null)
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
  simRef.value?.stop()
  simRef.value = null
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

.edges line {
  stroke: var(--accent);
  stroke-opacity: 0.22;
  stroke-linecap: round;
  transition: stroke-opacity 0.12s ease;
}

.edges line.hot {
  stroke-opacity: 0.85;
}

.edges line.dim {
  stroke-opacity: 0.06;
}

.node {
  cursor: pointer;
}

.node circle {
  fill: var(--accent);
  fill-opacity: 0.16;
  stroke: var(--accent);
  stroke-width: 1.2;
  transition:
    fill-opacity 0.12s ease,
    stroke-opacity 0.12s ease;
}

.node:hover circle,
.node circle.active {
  fill-opacity: 0.42;
}

.node.dim {
  opacity: 0.28;
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
