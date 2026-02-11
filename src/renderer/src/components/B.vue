<script setup lang="ts">
/*
数据：

   * 组件用于展示一个字符串数组 list: [string]。
   * 字符串数组在组件创建时为空数组，后续由 ipcRenderer 监听 'file-list' 事件获得并更新到 list 上。

外观与逻辑：
   
   * 组件本身的宽度和高度为 100%，只受父组件的约束。
   * 列表的每一项是一个子组件，子组件的描述由本组件传入。  
   * 列表的每一项，除了显示字符串以外，右侧还有一个 [ checkbox ]，点击时切换钩选。
   
要求：
   
   * 列表内的每一个单项需要有一个独立的子组件。因此你需要给我两个vue 组件的代码，一个是这个组件自子，一个是用于列表单项的子组件。
   * 我写了什么要求什么你就以最小的代码量实现，切勿自作主张添加多余的设计和代码，我还得费劲地去删，折磨你也折磨我。

环境状况：

  * 组件使用 <script setup lang="ts"> 和 <styple scoped>。
  * 组件会逐步完善，目前处于原型阶段，后续会优化，目前只实现组件间的组织和基本的互动演示。
  * CSS 修饰美化也会在后续逐步添加，目前只需要最基本的样式即可。

*/
import { onMounted, ref } from 'vue'
import FileListItem from './FileListItem.vue'

const list = ref<string[]>([])

onMounted(() => {
  window.electron.ipcRenderer.on('scan-result', (_, files: string[]) => {
    console.log('files', files)
    list.value = files
  })
})
</script>

<template>
  <p>文件列表</p>
  <div class="file-list">
    <FileListItem v-for="file in list" :key="file" :file="file" />
  </div>
</template>

<style scoped>
.file-list {
  width: 100%;
  height: 100%;
}
</style>