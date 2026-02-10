<script setup lang="ts">

/*

请帮我写一个 vue3 组件：

* 这个组件是整个应用的入口，会在 main.ts 中注册后挂载到 #app dom 上，因此组件本身会 100% 填充整个屏幕。
* 组件是白色色背景的容器，有 8 px 的内边距。
* 组件内分为上下两部分，上部是标签栏，下面是主内容区域。

标签栏：

* 宽度为 100%，高度为 48px。
* 背景色为白色。
* 边框为 1px 灰色。
* 垂直居中。
* 添加 16px 的内边距。
* 添加 8px 的间距。
* 内部有若干个按钮。

标签栏的按钮：

* 左对齐，按钮之间有 8px 的间距。
* 宽度为 120px。
* 垂直居中。
* 添加 10px 的内边距。
* 添加 16px 的外边距。

主内容区域：

* 一个填充剩余空间的区域，根据标签栏的激活状态显示不同的组件。
* 主内容区域的组件会在后续逐渐添加，目前以 A.vue，B.vue，C.vue，D.vue 占位。

组件特性：

* 组件使用 <script setup lang="ts"> 和 <styple scoped>。
* 组件是整个界面的框架，后续会往里添加各个功能组件，因此目前不需要添加任何内容。
* CSS 修饰美化也会在后续逐步添加，目前只需要最基本的样式即可。
* 切勿自作主张添加多余代码，我还得费劲地去删，折磨你也折磨我。
*/

import { ref, computed } from 'vue'
import A from './components/A.vue'
import B from './components/B.vue'
import C from './components/C.vue'
import D from './components/D.vue'

// 标签栏配置
const tabs = [
  { id: 'A', label: 'A', component: A },
  { id: 'B', label: 'B', component: B },
  { id: 'C', label: 'C', component: C },
  { id: 'D', label: 'D', component: D }
]

// 当前激活的标签
const activeTab = ref('A')

// 动态组件
const CurrentComponent = computed(() => {
  const tab = tabs.find(t => t.id === activeTab.value)
  return tab ? tab.component : A
})
</script>

<template>
  <div class="app-container">
    <!-- 标签栏 -->
    <div class="tab-bar">
      <button v-for="tab in tabs" :key="tab.id" class="tab-button" :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id">
        {{ tab.label }}
      </button>
    </div>

    <!-- 主内容区域 -->
    <div class="main-content">
      <KeepAlive>
        <component :is="CurrentComponent" />
      </KeepAlive>
    </div>
  </div>
</template>

<style scoped>
.app-container {
  width: 100vw;
  height: 100vh;
  padding: 8px;
  background-color: white;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.tab-bar {
  width: 100%;
  height: 48px;
  background-color: white;
  border: 1px solid #ccc;
  display: flex;
  align-items: center;
  padding: 16px;
  gap: 8px;
  box-sizing: border-box;
}

.tab-button {
  width: 120px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  margin: 16px;
  cursor: pointer;
}

.main-content {
  flex: 1;
  overflow: auto;
  margin-top: 8px;
  box-sizing: border-box;
}
</style>