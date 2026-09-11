/**
 * contextBridge 传参走 V8 结构化克隆，遇到 Vue 响应式 Proxy 会抛
 * "An object could not be cloned"。调用 window.api 前必须把参数拍平成纯 JSON。
 * toRaw 是浅转换（嵌套子对象仍是代理），这里用 JSON 往返做深度拍平；
 * IPC 契约本身就是纯 JSON，语义无损。
 */
export function deepPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
