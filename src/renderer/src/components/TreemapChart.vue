<template>
  <div class="treemap">
    <div class="crumbs">
      <button class="crumb" :class="{ current: stack.length === 0 }" @click="drillTo(-1)">
        全部目标
      </button>
      <template v-for="(node, i) in stack" :key="node.path">
        <span class="sep">›</span>
        <button class="crumb" :class="{ current: i === stack.length - 1 }" @click="drillTo(i)">
          {{ node.name }}
        </button>
      </template>
    </div>

    <div ref="box" class="map-box">
      <svg v-if="tiles.length > 0" :width="size.w" :height="size.h" class="map-svg">
        <defs>
          <clipPath v-for="(t, i) in tiles" :id="clipId(i)" :key="t.node.path">
            <rect :x="t.x" :y="t.y" :width="t.w" :height="t.h" />
          </clipPath>
        </defs>
        <g
          v-for="(t, i) in tiles"
          :key="t.node.path"
          :clip-path="`url(#${clipId(i)})`"
          class="tile-g"
          @click="openTile(t.node)"
        >
          <title>{{ titleOf(t.node) }}</title>
          <rect
            class="tile"
            :class="heatClass(t.node)"
            :x="t.x"
            :y="t.y"
            :width="Math.max(0, t.w - 1)"
            :height="Math.max(0, t.h - 1)"
          />
          <text v-if="t.w >= 56 && t.h >= 30" class="tile-name" :x="t.x + 6" :y="t.y + 15">
            {{ t.node.name }}
          </text>
          <text v-if="t.w >= 72 && t.h >= 46" class="tile-size" :x="t.x + 6" :y="t.y + 31">
            {{ sizeLabel(t.node) }}
          </text>
        </g>
      </svg>
      <div v-else class="empty">该层级无可视化数据</div>
    </div>

    <div class="legend">
      <span class="legend-item"><span class="swatch heat-0"></span>无重复</span>
      <span class="legend-item"><span class="swatch heat-1"></span>&lt;2%</span>
      <span class="legend-item"><span class="swatch heat-2"></span>2–5%</span>
      <span class="legend-item"><span class="swatch heat-3"></span>5–10%</span>
      <span class="legend-item"><span class="swatch heat-4"></span>≥10%</span>
      <span class="legend-tip">色块按目录内重复占比着色，点击可下钻</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ScanTreeNode } from '../../../shared/types'
import { formatBytes } from '../utils/format'

const props = defineProps<{ tree: ScanTreeNode[] }>()

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Tile {
  node: ScanTreeNode
  x: number
  y: number
  w: number
  h: number
}

/** 聚合阈值：小于总量的 0.4% 归入"其他"，避免碎片瓦片 */
const MIN_SHARE = 0.004
const AGGREGATE_OVER = 14

const uid = Math.random().toString(36).slice(2)
const stack = ref<ScanTreeNode[]>([])
const box = ref<HTMLDivElement | null>(null)
const size = ref({ w: 0, h: 0 })
let ro: ResizeObserver | undefined

watch(
  () => props.tree,
  (t) => {
    stack.value = t.length === 1 ? [t[0]] : []
  },
  { immediate: true }
)

onMounted(() => {
  if (!box.value) return
  ro = new ResizeObserver((entries) => {
    const r = entries[0].contentRect
    size.value = { w: Math.floor(r.width), h: Math.floor(r.height) }
  })
  ro.observe(box.value)
})

onBeforeUnmount(() => ro?.disconnect())

const focusedChildren = computed<ScanTreeNode[]>(() =>
  stack.value.length === 0 ? props.tree : (stack.value[stack.value.length - 1]?.children ?? [])
)

const itemsForLayout = computed<ScanTreeNode[]>(() => {
  const kids = focusedChildren.value.filter((k) => k.size > 0)
  if (kids.length <= AGGREGATE_OVER) return kids
  const total = kids.reduce((s, k) => s + k.size, 0)
  const kept: ScanTreeNode[] = []
  let restSize = 0
  let restDup = 0
  let restCount = 0
  for (const k of kids) {
    if (k.size >= total * MIN_SHARE) kept.push(k)
    else {
      restSize += k.size
      restDup += k.dupWasted
      restCount++
    }
  }
  if (restCount > 0) {
    const base =
      stack.value.length > 0 ? (stack.value[stack.value.length - 1] as ScanTreeNode).path : '_root'
    kept.push({
      name: `其他 ${restCount} 项`,
      path: `${base}#rest`,
      size: restSize,
      dupWasted: restDup,
      children: []
    })
  }
  return kept
})

/** squarified 布局（Bruls et al.）：面积∝size，长宽比尽量接近 1 */
const tiles = computed<Tile[]>(() => {
  const items = itemsForLayout.value
  const rect = { x: 0, y: 0, w: size.value.w, h: size.value.h }
  if (items.length === 0 || rect.w <= 1 || rect.h <= 1) return []
  const total = items.reduce((s, n) => s + n.size, 0)
  if (total <= 0) return []
  let pending = items.map((n) => ({ node: n, area: (n.size / total) * rect.w * rect.h }))
  let remain: Rect = { ...rect }
  const out: Tile[] = []

  while (pending.length > 0 && remain.w > 0.5 && remain.h > 0.5) {
    const vertical = remain.w >= remain.h
    const side = vertical ? remain.h : remain.w
    // 行条带 = pending 的前缀；在长宽比开始变差前尽量多装
    let idx = 0
    let rowArea = 0
    let best = Infinity
    while (idx < pending.length) {
      const candArea = rowArea + pending[idx].area
      const t = candArea / side
      let worst = 0
      for (let j = 0; j <= idx; j++) {
        const len = pending[j].area / t
        worst = Math.max(worst, t / len, len / t)
      }
      if (idx > 0 && worst > best + 1e-9) break
      best = worst
      rowArea = candArea
      idx++
    }
    const t = rowArea / side
    let offset = vertical ? remain.y : remain.x
    for (let j = 0; j < idx; j++) {
      const it = pending[j]
      const len = it.area / t
      out.push(
        vertical
          ? { node: it.node, x: remain.x, y: offset, w: t, h: len }
          : { node: it.node, x: offset, y: remain.y, w: len, h: t }
      )
      offset += len
    }
    remain = vertical
      ? { x: remain.x + t, y: remain.y, w: remain.w - t, h: remain.h }
      : { x: remain.x, y: remain.y + t, w: remain.w, h: remain.h - t }
    pending = pending.slice(idx)
  }
  return out
})

function openTile(node: ScanTreeNode): void {
  if (node.children.length > 0) stack.value = [...stack.value, node]
}

function drillTo(i: number): void {
  stack.value = i < 0 ? [] : stack.value.slice(0, i + 1)
}

function heatClass(node: ScanTreeNode): string {
  if (node.size <= 0) return 'heat-0'
  const ratio = node.dupWasted / node.size
  if (ratio <= 0) return 'heat-0'
  if (ratio < 0.02) return 'heat-1'
  if (ratio < 0.05) return 'heat-2'
  if (ratio < 0.1) return 'heat-3'
  return 'heat-4'
}

function titleOf(node: ScanTreeNode): string {
  const parts = [`${node.name}（${formatBytes(node.size)}）`]
  if (node.dupWasted > 0) parts.push(`重复 ${formatBytes(node.dupWasted)}`)
  if (node.children.length > 0) parts.push(`${node.children.length} 个子目录，点击下钻`)
  return parts.join('，')
}

function sizeLabel(node: ScanTreeNode): string {
  return node.dupWasted > 0
    ? `${formatBytes(node.size)} · 重复 ${formatBytes(node.dupWasted)}`
    : formatBytes(node.size)
}

function clipId(i: number): string {
  return `tm-${uid}-${i}`
}
</script>

<style scoped>
.treemap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  overflow: hidden;
  white-space: nowrap;
}

.crumb {
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
  padding: 2px 4px;
}

.crumb.current {
  color: var(--text);
  font-weight: 600;
}

.sep {
  color: var(--muted);
}

.map-box {
  flex: 1;
  min-height: 0;
  padding: 0 10px 6px;
}

.map-svg {
  display: block;
  background: var(--hover-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.tile {
  stroke: var(--bg);
  stroke-width: 1;
}

.tile-g {
  cursor: pointer;
}

.tile-g:hover .tile {
  stroke: var(--accent);
  stroke-width: 2;
}

.tile-name {
  font-size: 11px;
  font-weight: 600;
  fill: var(--text);
}

.tile-size {
  font-size: 10px;
  fill: var(--muted);
}

.legend {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 10px 8px;
  color: var(--muted);
  font-size: 12px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.swatch {
  width: 12px;
  height: 12px;
  border: 1px solid var(--border);
  display: inline-block;
}

.swatch.heat-0 {
  background: #dfe5ec;
}

.swatch.heat-1 {
  background: #f2e2b8;
}

.swatch.heat-2 {
  background: #f0b988;
}

.swatch.heat-3 {
  background: #e88b64;
}

.swatch.heat-4 {
  background: #d9534f;
}

.legend-tip {
  margin-left: auto;
}

.empty {
  padding: 16px;
  color: var(--muted);
}
</style>
