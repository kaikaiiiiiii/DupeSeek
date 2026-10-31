<template>
  <svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path :d="paths[name]" fill="currentColor" />
  </svg>
</template>

<script setup lang="ts">
// Fluent 风格单色图标（filled）。MIT 授权的 Fluent UI System Icons 子集内联，
// 避免引入图标运行时依赖。
type IconName = 'folder' | 'file' | 'drive' | 'shield' | 'chevron' | 'plus' | 'trash'

const paths: Record<IconName, string> = {
  folder:
    'M2.5 6.5A2.5 2.5 0 0 1 5 4h3.9a2.5 2.5 0 0 1 1.77.73L12.1 6.2H19a2.5 2.5 0 0 1 2.5 2.5v8.8a2.5 2.5 0 0 1-2.5 2.5H5a2.5 2.5 0 0 1-2.5-2.5v-11Z',
  file: 'M6.5 2.5h6.4L18.5 8v11.5a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Zm6.9 2.6v3.9h3.9l-3.9-3.9Z',
  drive: 'M4 5.5h16a2 2 0 0 1 2 2v4H2v-4a2 2 0 0 1 2-2Zm-2 8h20v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3Zm16.5 2.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z',
  shield: 'M12 2.2 4.5 5v6.2c0 4.6 3.2 8.4 7.5 10.3 4.3-1.9 7.5-5.7 7.5-10.3V5L12 2.2Z',
  chevron: 'M8.6 4.6a1 1 0 0 1 1.4 0l6.4 6.4a1.4 1.4 0 0 1 0 2L10 19.4a1 1 0 1 1-1.4-1.4l5.5-5.5-5.5-5.5a1 1 0 0 1 0-1.4Z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  trash: 'M9.5 3h5l.9 1.5H20V6H4V4.5h4.6L9.5 3ZM6 7.5h12l-.8 11a2 2 0 0 1-2 1.9H8.8a2 2 0 0 1-2-1.9l-.8-11Zm3.5 2v9h1.6v-9H9.5Zm3.4 0v9h1.6v-9h-1.6Z'
}

defineProps<{ name: IconName }>()
</script>

<style scoped>
.app-icon {
  width: 1em;
  height: 1em;
  display: inline-block;
  vertical-align: -0.125em;
}
</style>
