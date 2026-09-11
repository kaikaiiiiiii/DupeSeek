<template>
  <div class="app-root">
    <aside class="app-left">
      <TargetList />
    </aside>
    <div class="app-right">
      <nav class="tab-bar">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-btn"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>
      <div class="tab-content">
        <KeepAlive>
          <component :is="current" />
        </KeepAlive>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import DupeList from './components/DupeList.vue'
import ExplorerView from './components/ExplorerView.vue'
import ScanView from './components/ScanView.vue'
import TargetList from './components/TargetList.vue'
import TreeSizeView from './components/TreeSizeView.vue'
import { useDupeStore } from './stores/dupe'
import { useScanStore } from './stores/scan'
import { useSettingsStore } from './stores/settings'
import { useTargetStore } from './stores/target'

const tabs = [
  { id: 'explorer', label: '浏览', component: ExplorerView },
  { id: 'scan', label: '扫描', component: ScanView },
  { id: 'dupes', label: '清理', component: DupeList },
  { id: 'treesize', label: '空间分析', component: TreeSizeView }
] as const

type TabId = (typeof tabs)[number]['id']

const activeTab = ref<TabId>('explorer')
const current = computed(
  () => tabs.find((t) => t.id === activeTab.value)?.component ?? ExplorerView
)

onMounted(async () => {
  const settings = await useSettingsStore().load()
  useTargetStore().init(settings.targets)
  useScanStore().initDraft(settings.scanDraft)
  useDupeStore().reset()

  // 提权重启后的自动续扫：消费一次性标记，切到扫描页并重扫
  if (settings.resumeScan) {
    await useSettingsStore().patch({ resumeScan: false })
    activeTab.value = 'scan'
    try {
      await useScanStore().start()
    } catch {
      // 目标为空等启动错误已在扫描页展示
    }
  }
})
</script>

<style scoped>
.app-root {
  width: 100%;
  height: 100%;
  display: flex;
  gap: 10px;
}

.app-left {
  flex: 0 0 280px;
  min-width: 220px;
}

.app-right {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.tab-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.tab-btn {
  padding: 8px 20px;
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: var(--hover-bg);
  cursor: pointer;
}

.tab-btn.active {
  background: var(--bg);
  font-weight: 600;
  box-shadow: inset 0 2px 0 var(--accent);
}

.tab-content {
  flex: 1;
  min-height: 0;
}
</style>
