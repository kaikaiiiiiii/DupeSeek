<script setup lang="ts">
/*

   这个组件是一个类似于 todo 列表的 “文件目录列表”。

数据：

  * 需要维护一个字符串数组，用于存储目录路径。
  * 数组项会通过本组件的顶部 input 框输入或互动方式得到。
  * 字符串数组的每一项会分发给一个子组件用于展示。

外观与逻辑：

  * 组件本身的宽度和高度为 100%，只受父组件的约束。
  * 顶部是一个 input 输入框，输入框内最左边有个圆角矩形 btn，内有一个+号。宽度为 100%。
  * [+]号 btn 点击时，打开浏览器内置的 “浏览本地文件/目录" 对话框，选择一个目录，将目录路径作为参数传递给列表。
  * 中部是一个列表，项数不定，当项数超过组件高度时，出现滚动条并可上下滑动。
  * 列表的每一项是一个子组件，子组件的描述由本组件传入。  
  * 列表的每一项，除了显示字符串以外，右侧还有一个 (-) btn，点击时删除该项。

组件特性：

* 组件使用 <script setup lang="ts"> 和 <styple scoped>。
* 组件会逐步完善，目前处于原型阶段，后续会优化，目前只实现组件间的组织和基本的互动演示。
* CSS 修饰美化也会在后续逐步添加，目前只需要最基本的样式即可。

*/
import { toRaw, ref } from 'vue'

const directoryList = ref<string[]>([])

const handleAddClick = async () => {
  const path = await (window as any).api.selectDirectory()

  if (path && !directoryList.value.includes(path)) {
    directoryList.value.push(path)
  }
}

const scandir = (): void => {
  const raw = toRaw(directoryList.value)
  console.log(raw)
  window.electron.ipcRenderer.send('scan-dir', raw)
}


const sendPing = (): void => window.electron.ipcRenderer.send('ping')

const removeItem = (index: number) => {
  directoryList.value.splice(index, 1)
}
</script>

<template>
  <div class="directory-list">
    <div class="input-container">
      <button class="add-btn" @click="handleAddClick">+</button>
    </div>

    <div class="list-container">
      <div v-for="(item, index) in directoryList" :key="item" class="list-item">
        <span class="item-text">{{ item }}</span>
        <button class="remove-btn" @click="removeItem(index)">-</button>
      </div>
    </div>
    <div class="button-container">
      <button class="scan-folder" @click="scandir">SCAN</button>
      <button class="scan-folder" @click="sendPing">Ping</button>
    </div>
  </div>
</template>


<style scoped>
.directory-list {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.input-container {
  display: flex;
  width: 100%;
  border-bottom: 1px solid #ddd;
}

.add-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: #f0f0f0;
  border-radius: 4px;
  cursor: pointer;
  margin: 5px;
}

.add-btn:hover {
  background: #e0e0e0;
}

.input-container input {
  flex: 1;
  border: none;
  padding: 10px;
  outline: none;
}

.list-container {
  flex: 1;
  overflow-y: auto;
}

.list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px;
  border-bottom: 1px solid #eee;
}

.item-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: #ff6b6b;
  color: white;
  border-radius: 4px;
  cursor: pointer;
}

.remove-btn:hover {
  background: #ff5252;
}
</style>