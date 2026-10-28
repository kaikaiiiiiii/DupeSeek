<template>
  <div class="list-area">
    <template v-if="treesize.rows.length > 0">
      <div class="tree-header">
        <span class="dir-name">名称</span>
        <span class="dir-size">大小</span>
        <span class="dir-dup">重复占用</span>
      </div>
      <div class="tree-scroll">
        <VirtualScrollList :items="treesize.rows" :item-size="28">
          <template #default="{ item }">
            <div
              class="tree-row"
              :class="{ branch: (item as TreeRow).node.children.length > 0 }"
              :style="barStyle(item as TreeRow)"
              @click="treesize.toggle((item as TreeRow).node.path)"
            >
              <span v-for="i in (item as TreeRow).depth" :key="i" class="indent-gap"></span>
              <span class="disclosure">
                {{
                  (item as TreeRow).node.children.length > 0
                    ? treesize.expanded.has((item as TreeRow).node.path)
                      ? '▾'
                      : '▸'
                    : ''
                }}
              </span>
              <span class="dir-icon">📁</span>
              <span class="dir-name" :title="(item as TreeRow).node.path">{{
                (item as TreeRow).node.name
              }}</span>
              <span class="dir-size">{{ formatBytes((item as TreeRow).node.size) }}</span>
              <span class="dir-dup" :class="{ dup: (item as TreeRow).node.dupWasted > 0 }">
                {{
                  (item as TreeRow).node.dupWasted > 0
                    ? formatBytes((item as TreeRow).node.dupWasted)
                    : '—'
                }}
              </span>
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

const treesize = useTreeSizeStore()
const scan = useScanStore()

/** 与 .tree-row 的 padding 及 .indent-gap 宽度保持一致 */
const INDENT = 16

/** 体积条：左缘对齐所在层级缩进；100% 基准 = 名称列内可用宽度（不跨列）。
 *  重复条：洋红，限于重复占用列（固定 110px），按该层最大重复等比例 */
function barStyle(row: TreeRow): Record<string, string> {
  const max = treesize.maxSizeByDepth.get(row.depth) ?? 0
  const maxDup = treesize.maxDupByDepth.get(row.depth) ?? 0
  return {
    '--bar-indent': `${row.depth * INDENT}px`,
    '--bar-ratio': max > 0 ? (row.node.size / max).toFixed(4) : '0',
    '--dup-ratio': maxDup > 0 ? (row.node.dupWasted / maxDup).toFixed(4) : '0'
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

/* 表头：与数据行共用列类名（.dir-name/.dir-size/.dir-dup），保证列对齐 */
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

/* 体积条（黄）：左缘对齐所在层级缩进；宽度按名称列内可用宽度等比例，
 * 230px = 左右 padding 20 + 大小列 100 + 重复占用列 110，保证 100% 不跨出名称列 */
.tree-row::before {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: calc(10px + var(--bar-indent, 0px));
  width: calc((100% - 230px - var(--bar-indent, 0px)) * var(--bar-ratio, 0));
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

.dir-icon {
  flex-shrink: 0;
  margin-right: 6px;
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

.empty {
  padding: 16px;
  color: var(--muted);
}
</style>
