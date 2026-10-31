<template>
  <img v-if="src" class="tree-icon" :src="src" alt="" />
  <AppIcon v-else class="tree-icon tree-icon-fb" :name="kind === 'dir' ? 'folder' : 'file'" />
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'
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
</script>

<style scoped>
.tree-icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  image-rendering: auto;
}

.tree-icon-fb {
  color: var(--muted);
}
</style>
