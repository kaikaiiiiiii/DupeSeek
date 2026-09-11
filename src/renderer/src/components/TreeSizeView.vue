<template>
  <div class="treesize">
    <div class="toolbar">
      <span class="stat">
        {{ treesize.dirCount }} 个目录 · 总大小 {{ formatBytes(treesize.totalSize) }} · 重复占用
        <span :class="{ dup: treesize.totalDup > 0 }">{{ formatBytes(treesize.totalDup) }}</span>
      </span>
      <button
        class="btn small"
        :disabled="treesize.tree.length === 0"
        @click="treesize.expandAll()"
      >
        全部展开
      </button>
      <button
        class="btn small"
        :disabled="treesize.expanded.size === 0"
        @click="treesize.collapseAll()"
      >
        全部收起
      </button>
    </div>

    <TreeList />
  </div>
</template>

<script setup lang="ts">
import { useTreeSizeStore } from '../stores/treesize'
import { formatBytes } from '../utils/format'
import TreeList from './TreeList.vue'

const treesize = useTreeSizeStore()
</script>

<style scoped>
.treesize {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.stat {
  flex: 1;
  color: var(--muted);
}

.dup {
  color: var(--danger);
  font-weight: 600;
}
</style>
