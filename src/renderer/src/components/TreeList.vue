<template>
  <div class="list-area" :style="colVars">
    <template v-if="treesize.rows.length > 0">
      <div class="tree-header">
        <span class="dir-name sortable" @click="treesize.setSort('name')">
          名称{{ indicator('name') }}
        </span>
        <span class="dir-size sortable" @click="treesize.setSort('size')">
          大小{{ indicator('size') }}
          <span class="col-resize" @mousedown="startResize($event, 'size')" @click.stop></span>
        </span>
        <span class="dir-dup sortable" @click="treesize.setSort('dup')">
          重复占用{{ indicator('dup') }}
          <span class="col-resize" @mousedown="startResize($event, 'dup')" @click.stop></span>
        </span>
      </div>
      <div class="tree-scroll">
        <VirtualScrollList :items="treesize.rows" :item-size="34">
          <template #default="{ item }">
            <div
              class="tree-row"
              :class="{ branch: view(item as TreeRow).expandable }"
              :style="barStyle(item as TreeRow)"
              @click="onRowClick(item as TreeRow)"
            >
              <span v-for="i in view(item as TreeRow).depth" :key="i" class="indent-gap"></span>
              <span class="disclosure">{{ view(item as TreeRow).arrow }}</span>
              <TreeIcon
                :path="view(item as TreeRow).iconPath"
                :kind="view(item as TreeRow).iconKind"
              />
              <span class="inline-size">{{ view(item as TreeRow).sizeText }}</span>
              <span class="dir-name" :title="view(item as TreeRow).fullPath">{{
                view(item as TreeRow).name
              }}</span>
              <span class="dir-size">{{ view(item as TreeRow).sizeText }}</span>
              <span class="dir-dup" :class="{ dup: view(item as TreeRow).dupOn }">{{
                view(item as TreeRow).dupText
              }}</span>
            </div>
          </template>
        </VirtualScrollList>
      </div>
    </template>
    <div v-else class="empty">
      {{
        scan.status === 'scanning'
          ? '正在扫描，体积树将在扫描完成后生成…'
          : '左侧添加扫描目标后自动开始分析'
      }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useScanStore } from '../stores/scan'
import { useTreeSizeStore, type TreeRow } from '../stores/treesize'
import { formatBytes } from '../utils/format'
import VirtualScrollList from './VirtualScrollList.vue'
import TreeIcon from './TreeIcon.vue'

const treesize = useTreeSizeStore()
const scan = useScanStore()

/** 与 .indent-gap 宽度保持一致 */
const INDENT = 16

// —— 列宽（可拖拽调整）：CSS 变量统一驱动列、表头与体积条几何 ——
const sizeW = ref(100)
const dupW = ref(110)
const colVars = computed(() => ({
  '--col-size': `${sizeW.value}px`,
  '--col-dup': `${dupW.value}px`
}))

const COL_MIN = 60
const COL_MAX = 320

/** 表头右缘拖拽手柄：按住横向移动调整列宽 */
function startResize(ev: MouseEvent, which: 'size' | 'dup'): void {
  ev.preventDefault()
  ev.stopPropagation()
  const startX = ev.clientX
  const startW = which === 'size' ? sizeW.value : dupW.value
  const onMove = (mv: MouseEvent): void => {
    const w = Math.min(COL_MAX, Math.max(COL_MIN, startW + mv.clientX - startX))
    if (which === 'size') sizeW.value = w
    else dupW.value = w
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

interface RowView {
  depth: number
  /** '>' 收起 / '∨' 展开 / '' 不可展开 */
  arrow: string
  iconKind: 'dir' | 'file' | 'aggregate'
  iconPath: string
  sizeText: string
  name: string
  fullPath: string
  dupText: string
  dupOn: boolean
  expandable: boolean
}

function view(item: TreeRow): RowView {
  if (item.kind === 'loading') {
    return {
      depth: item.depth,
      arrow: '',
      iconKind: 'file',
      iconPath: '',
      sizeText: '',
      name: '加载中…',
      fullPath: '',
      dupText: '—',
      dupOn: false,
      expandable: false
    }
  }
  if (item.kind === 'dir') {
    const d = item.data
    const expandable = d.childDirs > 0 || d.fileCount > 0
    return {
      depth: item.depth,
      arrow: expandable ? (treesize.expanded.has(item.id) ? '∨' : '>') : '',
      iconKind: 'dir',
      iconPath: d.path,
      sizeText: formatBytes(d.size),
      name: d.name,
      fullPath: d.path,
      dupText: d.dupWasted > 0 ? formatBytes(d.dupWasted) : '—',
      dupOn: d.dupWasted > 0,
      expandable
    }
  }
  if (item.kind === 'aggregate') {
    return {
      depth: item.depth,
      arrow: treesize.expanded.has(item.id) ? '∨' : '>',
      iconKind: 'aggregate',
      iconPath: '',
      sizeText: formatBytes(item.size),
      name: item.name,
      fullPath: item.name,
      dupText: item.dupWasted > 0 ? formatBytes(item.dupWasted) : '—',
      dupOn: item.dupWasted > 0,
      expandable: true
    }
  }
  return {
    depth: item.depth,
    arrow: '',
    iconKind: 'file',
    iconPath: item.path,
    sizeText: formatBytes(item.size),
    name: item.name,
    fullPath: item.path,
    dupText: item.dupWasted > 0 ? formatBytes(item.dupWasted) : '—',
    dupOn: item.dupWasted > 0,
    expandable: false
  }
}

/** 表头排序指示符：当前排序列显示方向箭头 */
function indicator(key: 'name' | 'size' | 'dup'): string {
  if (treesize.sortKey !== key) return ''
  return treesize.sortDesc ? ' ↓' : ' ↑'
}

function onRowClick(item: TreeRow): void {
  if (item.kind === 'dir' && view(item).expandable) treesize.toggleRow(item)
  else if (item.kind === 'aggregate') treesize.toggleRow(item)
}

/** 体积条：左缘对齐所在层级缩进；100% 基准 = 全局最大体积（名称列内可用宽度，
 *  不跨列）。重复条：洋红，限于重复占用列（固定 110px），按全局最大重复等比例 */
function barStyle(item: TreeRow): Record<string, string> {
  const size = item.kind === 'loading' ? 0 : item.kind === 'dir' ? item.data.size : item.size
  const dup =
    item.kind === 'dir' ? item.data.dupWasted : item.kind === 'loading' ? 0 : item.dupWasted
  return {
    '--bar-indent': `${item.depth * INDENT}px`,
    '--bar-ratio': treesize.maxSize > 0 ? (size / treesize.maxSize).toFixed(4) : '0',
    '--dup-ratio': treesize.maxDup > 0 && dup > 0 ? (dup / treesize.maxDup).toFixed(4) : '0'
  }
}
</script>

<style scoped>
.list-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 表头：与数据行共用列类名（.dir-name/.dir-dup），保证列对齐 */
.tree-header {
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--hover-bg);
  color: var(--muted);
  font-size: 12px;
  user-select: none;
  flex-shrink: 0;
}

.tree-scroll {
  flex: 1;
  min-height: 0;
}

.tree-row {
  height: 34px;
  font-size: 14px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-light);
  box-sizing: border-box;
  user-select: none;
  position: relative;
}

/* 体积条（黄）：左缘在图标之后（10 padding + 14 disclosure + 24 icon + 8 margin，
 * 外侧各留 2px 空隙）；宽度按名称列内可用宽度等比例，
 * 74px = 58 左缘 + 2 右侧空隙 + 4 间隙 + 10 右 padding，列宽用变量与拖拽联动，
 * 保证 100% 不跨出名称列 */
.tree-row::before {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: calc(58px + var(--bar-indent, 0px));
  width: calc(
    (100% - 74px - var(--col-size, 100px) - var(--col-dup, 110px) - var(--bar-indent, 0px)) *
      var(--bar-ratio, 0)
  );
  background: var(--size-bar);
  border-radius: 4px;
  z-index: 0;
  pointer-events: none;
}

/* 重复条（洋红）：限于重复占用列内并左右各留 3px 空隙，宽度按全局最大重复等比例 */
.tree-row::after {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: calc(100% - var(--col-dup, 110px) - 7px);
  width: calc((var(--col-dup, 110px) - 6px) * var(--dup-ratio, 0));
  background: var(--dup-bar);
  border-radius: 4px;
  z-index: 0;
  pointer-events: none;
}

/* 行内容抬到体积条之上 */
.tree-row > * {
  position: relative;
  z-index: 1;
}

.tree-row:hover {
  background: var(--hover-bg);
}

.tree-row.branch {
  cursor: pointer;
}

.indent-gap {
  display: inline-block;
  width: 16px;
  flex-shrink: 0;
}

.disclosure {
  width: 14px;
  flex-shrink: 0;
  color: var(--muted);
}

/* 图标与行内体积之间的间距；.tree-icon 定义在 TreeIcon.vue */
.tree-icon {
  margin-right: 8px;
}

.inline-size {
  width: 64px;
  flex-shrink: 0;
  text-align: right;
  margin-right: 8px;
  color: var(--muted);
}

.dir-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dir-size {
  width: var(--col-size, 100px);
  flex-shrink: 0;
  text-align: right;
  color: var(--muted);
}

.dir-dup {
  width: var(--col-dup, 110px);
  flex-shrink: 0;
  text-align: right;
  color: var(--muted);
}

/* 表头右缘的列宽拖拽手柄 */
.tree-header .dir-size,
.tree-header .dir-dup {
  position: relative;
}

.col-resize {
  position: absolute;
  top: 0;
  right: -4px;
  bottom: 0;
  width: 9px;
  cursor: col-resize;
}

.col-resize::after {
  content: '';
  position: absolute;
  top: 7px;
  bottom: 7px;
  left: 4px;
  width: 1px;
  background: transparent;
}

.col-resize:hover::after {
  background: var(--border);
}

.sortable {
  cursor: pointer;
}

.sortable:hover {
  color: var(--text);
}

.dup {
  color: var(--danger);
  font-weight: 600;
}

.tree-row .loading-text {
  color: var(--muted);
}

.empty {
  padding: 16px;
  color: var(--muted);
}
</style>
