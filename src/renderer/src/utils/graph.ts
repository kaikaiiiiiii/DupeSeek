// 关系视图（力导向气泡 / 层次边捆绑）共用的尺度工具。
// 聚合在主进程完成（graph:relations），这里只负责视觉映射。

/** 节点半径：面积 ∝ 字节数（sqrt 缩放） */
export function nodeRadius(bytes: number, maxBytes: number): number {
  if (maxBytes <= 0) return 6
  const t = Math.sqrt(Math.max(0, Math.min(1, bytes / maxBytes)))
  return 4 + 22 * t
}

/** 边宽：共享字节按 log 缩放，1KB 以下保持细线 */
export function edgeWidth(sharedBytes: number): number {
  const w = Math.log10(1 + Math.max(0, sharedBytes) / 1024) * 1.2
  return Math.max(0.6, Math.min(7, w))
}

/** 截断过长的目录名（标签用） */
export function shortName(name: string, max = 16): string {
  return name.length <= max ? name : name.slice(0, max - 1) + '…'
}
