<template>
  <img v-if="src" class="tree-icon" :src="src" alt="" />
  <span v-else class="tree-icon tree-icon-fallback">{{ placeholder }}</span>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useIconStore } from '../stores/icons'

const props = defineProps<{
  path: string
  kind: 'dir' | 'file' | 'aggregate'
}>()

const icons = useIconStore()
onMounted(() => {
  if (props.path && props.kind !== 'aggregate') icons.request(props.path)
})

const src = computed(() => icons.cache[props.path] ?? '')
const placeholder = computed(() => (props.kind === 'dir' ? '📁' : '📄'))
</script>

<style scoped>
.tree-icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  image-rendering: auto;
}

.tree-icon-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  line-height: 1;
}
</style>
