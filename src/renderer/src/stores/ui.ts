import { defineStore } from 'pinia'
import { ref } from 'vue'

export type TabId =
  | 'treesize'
  | 'relation-force'
  | 'relation-bundle'
  | 'scan'
  | 'dupes'
  | 'settings'

/** 界面级状态（标签页切换等），与数据模型无关；跨组件跳转（如右键菜单 → 清理规则）经此 */
export const useUiStore = defineStore('ui', () => {
  const activeTab = ref<TabId>('treesize')

  function setActiveTab(t: TabId): void {
    activeTab.value = t
  }

  return { activeTab, setActiveTab }
})
