<template>
  <div class="list-area">
    <VirtualScrollList v-if="treesize.rows.length > 0" :items="treesize.rows" :item-size="28">
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
const ROW_PAD = 10
const INDENT = 16

/** TreeSize 风格体积条：左缘对齐所在层级缩进，宽度按当前最大体积等比例 */
function barStyle(row: TreeRow): Record<string, string> {
  const pct = treesize.maxSize > 0 ? ((row.node.size / treesize.maxSize) * 100).toFixed(2) : '0.00'
  return { '--bar-left': `${ROW_PAD + row.depth * INDENT}px`, '--bar-w': `${pct}%` }
}
</script>

<style scoped>
.list-area {
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

/* 体积条：黄底，长度为该行体积占当前可见最大体积的比例 */
.tree-row::before {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: var(--bar-left, 10px);
  width: var(--bar-w, 0%);
  background: var(--size-bar);
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
