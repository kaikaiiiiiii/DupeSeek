<template>
  <Teleport to="body">
    <div v-if="open" class="ctx-layer" @click="emit('close')" @contextmenu.prevent="emit('close')">
      <div ref="menuEl" class="ctx-menu" :style="posStyle">
        <button
          v-for="it in items"
          :key="it.id"
          class="ctx-item"
          :class="{ danger: it.danger, disabled: it.disabled }"
          :disabled="it.disabled"
          @click.stop="pick(it.id)"
        >
          {{ it.label }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export interface ContextMenuItem {
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
}

const props = defineProps<{
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{ select: [id: string]; close: [] }>()

const menuEl = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  async (v) => {
    if (v) {
      window.addEventListener('keydown', onKey)
      pos.value = { x: props.x, y: props.y }
      // 视口边缘收敛：先原位渲染再按实测尺寸回拉
      await nextTick()
      const el = menuEl.value
      if (el) {
        const r = el.getBoundingClientRect()
        pos.value = {
          x: Math.min(props.x, window.innerWidth - r.width - 8),
          y: Math.min(props.y, window.innerHeight - r.height - 8)
        }
      }
    } else {
      window.removeEventListener('keydown', onKey)
    }
  }
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const posStyle = computed(() => ({ left: `${pos.value.x}px`, top: `${pos.value.y}px` }))

function pick(id: string): void {
  emit('select', id)
  emit('close')
}
</script>

<style scoped>
/* 透明点击拦截层（无暗色遮罩，上下文菜单不吸收注意力） */
.ctx-layer {
  position: fixed;
  inset: 0;
  z-index: 1100;
}

.ctx-menu {
  position: fixed;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.ctx-item {
  border: none;
  background: transparent;
  font: inherit;
  text-align: left;
  padding: 7px 12px;
  border-radius: 4px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.ctx-item:hover:not(.disabled) {
  background: var(--hover-bg);
}

.ctx-item.danger {
  color: var(--danger);
}

.ctx-item.disabled {
  color: var(--muted);
  cursor: default;
  opacity: 0.6;
}
</style>
