// 无头诊断用的 electron 桩 + nodeWorker 工厂：
// electron 仅提供 engine 依赖链需要的最小面；?nodeWorker 导出
// worker_threads 工厂，指向随诊断包一同产出的 hash.worker.js。
import { Worker } from 'node:worker_threads'

export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getResourcesPath: () => process.cwd()
}
export const shell = { showItemInFolder: () => {} }

export default function createNodeWorker(options) {
  return new Worker(new URL('./hash.worker.js', import.meta.url), options)
}
