<template>
  <div class="list-area">
    <VirtualScrollList v-if="treesize.rows.length > 0" :items="treesize.rows" :item-size="28">
      <template #default="{ item }">
        <div
          class="tree-row"
          :class="{ branch: (item as TreeRow).node.children.length > 0 }"
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
    <div v-else class="empty">暂无数据——先到「扫描」页运行一次扫描</div>
  </div>
</template>

<script setup lang="ts">
import { useTreeSizeStore, type TreeRow } from '../stores/treesize'
import { formatBytes } from '../utils/format'
import VirtualScrollList from './VirtualScrollList.vue'

const treesize = useTreeSizeStore()
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
