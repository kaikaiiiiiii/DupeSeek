<template>
  <svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path :d="paths[name]" fill="currentColor" />
  </svg>
</template>

<script setup lang="ts">
// Fluent 风格单色图标（filled）。MIT 授权的 Fluent UI System Icons 子集内联，
// 避免引入图标运行时依赖。
type IconName =
  | 'folder'
  | 'file'
  | 'drive'
  | 'shield'
  | 'chevron'
  | 'plus'
  | 'trash'
  | 'search'
  | 'dismiss'
  | 'box'
  | 'check'

const paths: Record<IconName, string> = {
  folder:
    'M2.5 6.5A2.5 2.5 0 0 1 5 4h3.9a2.5 2.5 0 0 1 1.77.73L12.1 6.2H19a2.5 2.5 0 0 1 2.5 2.5v8.8a2.5 2.5 0 0 1-2.5 2.5H5a2.5 2.5 0 0 1-2.5-2.5v-11Z',
  file: 'M6.5 2.5h6.4L18.5 8v11.5a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Zm6.9 2.6v3.9h3.9l-3.9-3.9Z',
  drive:
    'M4 5.5h16a2 2 0 0 1 2 2v4H2v-4a2 2 0 0 1 2-2Zm-2 8h20v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3Zm16.5 2.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z',
  shield: 'M12 2.2 4.5 5v6.2c0 4.6 3.2 8.4 7.5 10.3 4.3-1.9 7.5-5.7 7.5-10.3V5L12 2.2Z',
  chevron:
    'M8.6 4.6a1 1 0 0 1 1.4 0l6.4 6.4a1.4 1.4 0 0 1 0 2L10 19.4a1 1 0 1 1-1.4-1.4l5.5-5.5-5.5-5.5a1 1 0 0 1 0-1.4Z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  trash:
    'M9.5 3h5l.9 1.5H20V6H4V4.5h4.6L9.5 3ZM6 7.5h12l-.8 11a2 2 0 0 1-2 1.9H8.8a2 2 0 0 1-2-1.9l-.8-11Zm3.5 2v9h1.6v-9H9.5Zm3.4 0v9h1.6v-9h-1.6Z',
  search:
    'M10 2.5A7.5 7.5 0 0 1 16.08 14.52L21.58 20.02A1.1 1.1 0 0 1 20.02 21.58L14.52 16.08A7.5 7.5 0 1 1 10 2.5ZM10 4.5A5.5 5.5 0 1 0 10 16A5.5 5.5 0 1 0 10 4.5Z',
  dismiss:
    'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4 6.4 5Z',
  box: 'M3 5.5A1.5 1.5 0 0 1 4.5 4h15a1.5 1.5 0 0 1 1.5 1.5V8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 8V5.5ZM5 11.5h14v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-7Zm4.5 3a1 1 0 0 0 0 2h5a1 1 0 0 0 0-2h-5Z',
  check: 'M9.2 16.2 4.6 11.6 3.2 13l6 6L21 7.4 19.6 6 9.2 16.2Z'
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
