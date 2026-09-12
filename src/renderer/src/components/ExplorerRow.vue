<template>
  <div
    class="dir-row"
    :class="{ active }"
    draggable="true"
    :title="entry.isDir ? '拖到左侧加入扫描列表；单击进入目录' : '拖到左侧加入扫描列表'"
    @dragstart="onDragStart"
  >
    <span
      class="entry-main"
      :class="{ nav: entry.isDir }"
      :title="entry.isDir ? '点击进入目录' : '点击选中 / 取消'"
      @click="entry.isDir ? emit('open') : emit('toggle')"
    >
      <span class="entry-icon">{{ entry.isDir ? '📁' : '📄' }}</span>
      <span class="entry-name">{{ entry.name }}</span>
    </span>
    <span class="entry-meta" title="点击选中 / 取消" @click="emit('toggle')">
      <span class="entry-mtime">{{ formatTime(entry.mtime) }}</span>
      <span class="entry-class">{{ entry.class || '—' }}</span>
      <span class="entry-size">{{ entry.isDir ? '' : formatBytes(entry.size) }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import type { DirEntry } from '../../../shared/types'
import { formatBytes, formatTime } from '../utils/format'

const props = defineProps<{
  entry: DirEntry
  active: boolean
}>()

const emit = defineEmits<{
  open: []
  toggle: []
}>()

/** 应用内拖拽：TargetList 按此 MIME 类型识别（区别于系统文件拖放） */
function onDragStart(ev: DragEvent): void {
  ev.dataTransfer?.setData('application/x-dupeseek-path', props.entry.path)
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy'
}
</script>

<style scoped>
.dir-row {
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-light);
  box-sizing: border-box;
}

.dir-row:hover {
  background: var(--hover-bg);
}

.dir-row.active {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}

/* 左侧名称区：进入目录 */
.entry-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.entry-main.nav:hover .entry-name {
  color: var(--accent);
  text-decoration: underline;
}

.entry-icon {
  flex-shrink: 0;
}

.entry-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 右侧属性区：切换选中 */
.entry-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.entry-meta:hover {
  opacity: 0.75;
}

.entry-mtime,
.entry-size {
  color: var(--muted);
  font-size: 12px;
  text-align: right;
}

.entry-mtime {
  width: 140px;
}

.entry-size {
  width: 80px;
}

.entry-class {
  color: var(--muted);
  font-size: 12px;
  width: 60px;
}
</style>
