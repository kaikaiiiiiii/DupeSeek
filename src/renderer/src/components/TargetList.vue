<template>
  <aside
    class="target-list"
    :class="{ droppable: dragOver }"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
    <div class="hint">{{ dragOver ? '松开以添加目标' : '拖入文件或目录，或点击下方按钮添加' }}</div>

    <div class="list-area">
      <VirtualScrollList v-if="targets.length > 0" :items="targets" :item-size="64">
        <template #default="{ item }">
          <div class="target-item">
            <div class="target-info">
              <div class="target-name" :title="String(item)">{{ baseName(String(item)) }}</div>
              <div class="target-path" :title="String(item)">{{ item }}</div>
            </div>
            <div class="target-actions">
              <button class="icon-btn" title="在资源管理器中显示" @click="reveal(String(item))">
                🔍
              </button>
              <button class="icon-btn danger" title="移除目标" @click="removeTarget(String(item))">
                ✕
              </button>
            </div>
          </div>
        </template>
      </VirtualScrollList>
      <div v-else class="empty">尚未添加扫描目标</div>
    </div>

    <div class="footer">
      <button class="btn primary" :disabled="busy" @click="addByDialog">添加目标</button>
      <button class="btn" :disabled="targets.length === 0 || busy" @click="clearAll">
        清空列表
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTargetStore } from '../stores/target'
import { baseName } from '../utils/format'
import VirtualScrollList from './VirtualScrollList.vue'

const targetStore = useTargetStore()
const targets = computed(() => targetStore.targets)
const dragOver = ref(false)
const busy = ref(false)

async function addByDialog(): Promise<void> {
  busy.value = true
  try {
    const picked = await window.api.selectTargets('both')
    if (picked) await targetStore.add(picked)
  } finally {
    busy.value = false
  }
}

async function onDrop(ev: DragEvent): Promise<void> {
  dragOver.value = false
  const files = ev.dataTransfer?.files
  if (!files || files.length === 0) return
  const paths = Array.from(files, (f) => window.api.pathForFile(f)).filter((p) => p !== '')
  if (paths.length > 0) await targetStore.add(paths)
}

async function removeTarget(path: string): Promise<void> {
  await targetStore.remove(path)
}

async function clearAll(): Promise<void> {
  if (window.confirm('确认清空全部扫描目标？')) await targetStore.clear()
}

async function reveal(path: string): Promise<void> {
  await window.api.reveal(path)
}
</script>

<style scoped>
.target-list {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  overflow: hidden;
}

.target-list.droppable {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.hint {
  padding: 8px 10px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}

.list-area {
  flex: 1;
  min-height: 0;
}

.empty {
  padding: 16px 10px;
  color: var(--muted);
}

.target-item {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-light);
  box-sizing: border-box;
}

.target-info {
  flex: 1;
  min-width: 0;
}

.target-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.target-path {
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.target-actions {
  display: none;
  gap: 4px;
}

.target-item:hover .target-actions {
  display: flex;
}

.footer {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--border);
}
</style>
