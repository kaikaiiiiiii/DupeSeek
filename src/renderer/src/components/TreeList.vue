<template>
  <div class="list-area">
    <template v-if="treesize.rows.length > 0">
      <div class="tree-header">
        <span class="dir-name sortable" @click="treesize.setSort('name')">
          名称{{ indicator('name') }}
        </span>
        <span class="dir-size sortable" @click="treesize.setSort('size')">
          大小{{ indicator('size') }}
        </span>
        <span class="dir-dup sortable" @click="treesize.setSort('dup')">
          重复占用{{ indicator('dup') }}
        </span>
      </div>
      <div class="tree-scroll">
        <VirtualScrollList :items="treesize.rows" :item-size="28">
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
import { useScanStore } from '../stores/scan'
import { useTreeSizeStore, type TreeRow } from '../stores/treesize'
import { formatBytes } from '../utils/format'
import VirtualScrollList from './VirtualScrollList.vue'
import TreeIcon from './TreeIcon.vue'

const treesize = useTreeSizeStore()
const scan = useScanStore()

/** 与 .indent-gap 宽度保持一致 */
const INDENT = 16

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
  if (item.kind === 'dir') {
    const n = item.node
    const expandable = n.children.length > 0 || n.files.length > 0
    return {
      depth: item.depth,
      arrow: expandable ? (treesize.expanded.has(n.path) ? '∨' : '>') : '',
      iconKind: 'dir',
      iconPath: n.path,
      sizeText: formatBytes(n.size),
      name: n.name,
      fullPath: n.path,
      dupText: n.dupWasted > 0 ? formatBytes(n.dupWasted) : '—',
      dupOn: n.dupWasted > 0,
      expandable
    }
  }
  if (item.kind === 'aggregate') {
    return {
      depth: item.depth,
      arrow: treesize.expanded.has(item.path) ? '∨' : '>',
      iconKind: 'aggregate',
      iconPath: item.path,
      sizeText: formatBytes(item.size),
      name: item.name,
      fullPath: item.name,
      dupText: '—',
      dupOn: false,
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
  if (item.kind === 'dir' && view(item).expandable) treesize.toggle(item.node.path)
  else if (item.kind === 'aggregate') treesize.toggle(item.path)
}

/** 体积条：左缘对齐所在层级缩进；100% 基准 = 全局最大体积（名称列内可用宽度，
 *  不跨列）。重复条：洋红，限于重复占用列（固定 110px），按全局最大重复等比例 */
function barStyle(item: TreeRow): Record<string, string> {
  const size = item.kind === 'dir' ? item.node.size : item.size
  const dup = item.kind === 'dir' ? item.node.dupWasted : item.kind === 'file' ? item.dupWasted : 0
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
  height: 28px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-light);
  box-sizing: border-box;
  user-select: none;
  position: relative;
}

/* 体积条（黄）：左缘在图标之后（10 padding + 14 disclosure + 16 icon + 6 margin）；
 * 宽度按名称列内可用宽度等比例，270px = 46 + 4 间隙 + 大小列 100 + 重复占用列 110
 * + 右 padding 10，保证 100% 不跨出名称列 */
.tree-row::before {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: calc(46px + var(--bar-indent, 0px));
  width: calc((100% - 270px - var(--bar-indent, 0px)) * var(--bar-ratio, 0));
  background: var(--size-bar);
  border-radius: 2px;
  z-index: 0;
  pointer-events: none;
}

/* 重复条（洋红）：限于重复占用列内，左缘 = 100% - 120px（列起点 10+110） */
.tree-row::after {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: calc(100% - 120px);
  width: calc(110px * var(--dup-ratio, 0));
  background: var(--dup-bar);
  border-radius: 2px;
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
  margin-right: 6px;
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
  width: 100px;
  flex-shrink: 0;
  text-align: right;
  color: var(--muted);
}

.dir-dup {
  width: 110px;
  flex-shrink: 0;
  text-align: right;
  color: var(--muted);
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

.empty {
  padding: 16px;
  color: var(--muted);
}
</style>
