# Relations.md — 目录关系视图（Phase 1）

> 2026-11 新增。两个标签页「关系气泡」「关系捆绑」共用同一份后端聚合数据
> （`graph:relations`）。当前阶段（Phase 1）以**目录**为展示单元；数据契约按
> "展示单元"抽象，后续可替换为「块」（位置组 × 内容类），见文末「Phase 2」。

## 目标

现有去重软件把重复文件摊成一张巨大列表，目录只是路径字符串。本视图回答：

> **这个目录和哪些目录共享大量重复内容、大概能回收多少？**

目录是最强的结构信息，但不是硬划分单位：同一目录可以出现在多条关系里
（如桌面/下载这类中枢目录），关系可以横跨多个盘符。视图只表达**观测到的
共享结构**（内容等价 + 所在目录），**不推断用户行为、不表达时间/新旧语义**。

## 数据模型

单位：**展示单元** = 目标根（depth 0）或目标下指定深度的目录。Phase 1 即
"目录"；压缩包内条目按**容器所在目录**参与关系（包视为特殊目录的简化，后续
可升级为独立单元）。

对每个已确认重复组（内容等价类，`knownGroups`）：

- 把成员实例映射到展示单元（深度超过阈值的上卷到该层祖先）；
- 组内出现 ≥2 个单元时，两两累加：
  - `sharedFiles += min(两侧副本数)`；
  - `sharedBytes += min(两侧副本数) × 内容类大小`；
- 空文件组（字节 0）不产生边；单组位置数 > 32 视为噪声大组跳过
  （`truncatedGroups` 计数返回）。

**无向边**：只表示共享强度，不带方向、不表示"谁是原件"。

回包 `GraphRelationsReply`：

```ts
interface GraphNode {
  id: string        // 目录绝对路径（与体积树同口径）
  name: string
  parentId: string  // 父单元路径；目标根为 ''
  depth: number     // 相对目标根层级；目标根为 0
  bytes: number     // 目录（含子孙）聚合字节，体积树口径
  reclaim: number   // 目录（含子孙）重复副本占用字节，体积树口径
  hasChildren: boolean
}

interface GraphEdge {
  source: string    // 单元路径
  target: string
  sharedBytes: number
  sharedFiles: number
}

interface GraphRelationsReply {
  rev: number            // 体积树版本号，变化即失效前端缓存
  nodes: GraphNode[]     // 边端点 + 祖先链（用于拼树）
  edges: GraphEdge[]     // 已按 sharedBytes 过滤/排序，上限 20000
  truncatedGroups: number
}
```

查询：`graph:relations(maxDepth, minSharedBytes)`。`maxDepth` 夹在 0–6；
`minSharedBytes` 过滤边。计算在主进程按会话实时聚合，不落盘、不阻塞扫描主流程。

## 两个视图

### 关系气泡（`RelationForceView.vue`）

- 力导向布局（`d3-force`），**同步预迭代后一次性渲染**（无逐帧抖动）；
  数据/尺寸变化时重建；
- 节点 = 有关系的目录：面积 ∝ 目录体积（sqrt），角标/摘要显示体积与可回收；
- 边 = 共享重复内容：粗细 ∝ `sharedBytes`（log 缩放），无向；
- 上限 220 个节点（按体积取 Top），避免毛球；
- 交互：悬停高亮邻居、点击选中查看摘要；
- 默认展示深度 1（目标根 + 一级目录），阈值 1 MB。

### 关系捆绑（`RelationBundleView.vue`）

- 径向目录树（`d3-hierarchy` 的 `cluster`）+ 关系连线沿祖先路径捆绑
  （`d3-shape` 的 `curveBundle`），适合看"目录族"之间的结构；
- 叶子 = 关系端点目录（可含祖先树）；标签按体积取 Top（上限 90）；
- 端点上限 180、边上限 420（超限按体积/共享字节取 Top）；
- 默认展示深度 3，阈值 1 MB。

两个视图共享缓存：`useGraphStore` 按 `(maxDepth, minSharedBytes)` 缓存回包，
扫描版本（`scan:rev` / `progress.treeRev` → `useTreeSizeStore.rev`）推进后
以 500ms 防抖强刷。

**尺寸与刷新策略**：

- 画布用 `ResizeObserver` 量测 `.canvas-host`，窗口/布局尺寸变化时同步更新
  `viewBox` 并重新布局（不做等比缩放糊弄）；KeepAlive 切回时补一次量测。
- **扫描期间不自动重算关系**：关系聚合需要遍历整个会话，扫描期 rev 频繁推进
  会造成明显卡顿；扫描完成后（`status: scanning → done`）自动补一次。展示深度 /
  最小共享字节切换与「刷新布局」按钮随时可用。
- 扫描进行中且尚无可用数据时，占位提示为「扫描进行中，完成后自动生成目录关系」。

## Phase 1 已知限制

- 只有目录粒度，没有「块」（位置组 × 内容类）聚类；
- 压缩包内条目归到容器所在目录，尚未把压缩包作为独立单元；
- 无方向/新旧语义（刻意为之：避免从痕迹推断行为）；
- 不支持下钻、拖拽、缩放、右键菜单（Phase 1 只做视觉探索）；
- 不单独持久化，视图参数仅存于组件内；扫描结果改变时自动刷新。

## Phase 2（待定）

- 展示单元可替换为「块」：由共现结构规则（精确位置签名 → 频繁位置组）生成，
  允许重叠、可多归属；
- 届时画布只消费 `GraphNode`/`GraphEdge` 抽象，视图层更换 Provider 即可，
  不必推翻 `graph:relations` 向前端暴露的节点/边形状；
- 块模型的判定规则、目录角色等仍在讨论中，尚未定论，不在仓库内沉淀。
