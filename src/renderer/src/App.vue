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
import { computed, onMounted, ref, watch } from 'vue'
import DupeList from './components/DupeList.vue'
import ScanView from './components/ScanView.vue'
import SettingsView from './components/SettingsView.vue'
import TargetList from './components/TargetList.vue'
import TreeSizeView from './components/TreeSizeView.vue'
import { useDupeStore } from './stores/dupe'
import { useScanStore } from './stores/scan'
import { useSettingsStore } from './stores/settings'
import { useTargetStore } from './stores/target'

const tabs = [
  { id: 'treesize', label: '空间分析', component: TreeSizeView },
  { id: 'scan', label: '扫描参数', component: ScanView },
  { id: 'dupes', label: '清理规则', component: DupeList },
  { id: 'settings', label: '软件设置', component: SettingsView }
] as const

type TabId = (typeof tabs)[number]['id']

const activeTab = ref<TabId>('treesize')
const current = computed(
  () => tabs.find((t) => t.id === activeTab.value)?.component ?? TreeSizeView
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

// 目标列表变化（启动恢复 / 添加 / 删除）→ 自动开始扫描；正在扫描时不重复触发
watch(
  () => useTargetStore().targets,
  async (targets) => {
    const scan = useScanStore()
    if (targets.length === 0 || scan.status === 'scanning') return
    activeTab.value = 'scan'
    try {
      await scan.start()
    } catch {
      // 启动错误已在扫描页展示
    }
  }
)
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
