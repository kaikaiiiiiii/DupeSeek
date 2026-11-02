<template>
  <Teleport to="body">
    <div v-if="open" class="scrim" @click.self="emit('cancel')">
      <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
        <div class="dlg-title">{{ title }}</div>
        <div class="dlg-body">{{ message }}</div>
        <div class="dlg-actions">
          <button class="btn" @click="emit('cancel')">{{ cancelText }}</button>
          <button
            ref="confirmBtn"
            class="btn"
            :class="danger ? 'danger' : 'primary'"
            @click="emit('confirm')"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    /** 危险动作：确认按钮用 danger 配色 */
    danger?: boolean
  }>(),
  { confirmText: '确认', cancelText: '取消', danger: false }
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const confirmBtn = ref<HTMLButtonElement | null>(null)

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') emit('cancel')
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      window.addEventListener('keydown', onKey)
      void nextTick(() => confirmBtn.value?.focus())
    } else {
      window.removeEventListener('keydown', onKey)
    }
  }
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
/* 遮罩与对话框表面分层出自 vendor/fluentui-web-components/src/dialog/dialog.styles.css
 * （::backdrop 的 colorBackgroundOverlay 遮罩 + 中性表面 + 阴影），色值走本工程令牌 */
.scrim {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  min-width: 360px;
  max-width: 480px;
  padding: 20px 24px;
}

.dlg-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 10px;
}

.dlg-body {
  line-height: 1.6;
}

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
</style>
