<template>
  <VList class="vs-list" :data="items" :item-size="itemSize">
    <template #default="{ item }">
      <slot :item="item" />
    </template>
  </VList>
</template>

<script setup lang="ts">
import { VList } from 'virtua/vue'

defineProps<{
  items: unknown[]
  /** 定高条目的像素高度，行内样式必须与其一致 */
  itemSize: number
}>()
</script>

<style scoped>
.vs-list {
  width: 100%;
  height: 100%;
  overflow-y: auto;
}
</style>
