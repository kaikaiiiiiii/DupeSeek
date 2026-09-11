<template>
  <div class="treesize">
    <div class="toolbar">
      <span class="stat">
        {{ treesize.dirCount }} 个目录 · 总大小 {{ formatBytes(treesize.totalSize) }} · 重复占用
        <span :class="{ dup: treesize.totalDup > 0 }">{{ formatBytes(treesize.totalDup) }}</span>
      </span>
      <div class="mode-toggle">
        <button
          class="btn small"
          :class="{ primary: mode === 'treemap' }"
          @click="mode = 'treemap'"
        >
          矩形图
        </button>
        <button class="btn small" :class="{ primary: mode === 'list' }" @click="mode = 'list'">
          树形
        </button>
      </div>
      <template v-if="mode === 'list'">
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
      </template>
    </div>

    <div v-if="treesize.tree.length === 0" class="empty">暂无数据——先到「扫描」页运行一次扫描</div>
    <TreemapChart v-else-if="mode === 'treemap'" :tree="treesize.tree" />
    <TreeList v-else />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useTreeSizeStore } from '../stores/treesize'
import { formatBytes } from '../utils/format'
import TreemapChart from './TreemapChart.vue'
import TreeList from './TreeList.vue'

const treesize = useTreeSizeStore()
const mode = ref<'treemap' | 'list'>('treemap')
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

.mode-toggle {
  display: flex;
}

.mode-toggle .btn:first-child {
  border-radius: 4px 0 0 4px;
}

.mode-toggle .btn:last-child {
  border-radius: 0 4px 4px 0;
}

.empty {
  padding: 16px;
  color: var(--muted);
}
</style>
