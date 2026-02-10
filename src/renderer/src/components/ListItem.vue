<script setup lang="ts">
const props = defineProps<{
  item: string
  index: number
}>()

const emit = defineEmits<{
  remove: [index: number]
}>()

const handleRemove = () => {
  emit('remove', props.index)
}
</script>

<template>
  <div class="list-item">
    <span class="item-text">{{ item }}</span>
    <button class="remove-btn" @click="handleRemove">-</button>
  </div>
</template>

<style scoped>
.list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #eee;
  height: 50px;
  box-sizing: border-box;
}

.item-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove-btn {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px solid #dc3545;
  background: #fff;
  color: #dc3545;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  margin-left: 8px;
  flex-shrink: 0;
}

.remove-btn:hover {
  background: #dc3545;
  color: #fff;
}
</style>