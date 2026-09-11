# Store.md — Pinia 状态管理设计

> v0.1 草案（2026-09-12）。类型引用见 [DataModel.md](./DataModel.md)，通道定义见 [IPC.md](./IPC.md)。
>
> 原则：组件之间不直接传数据，一律通过 store；渲染层不持有任何 fs 状态的"私有副本"。store 只存轻量引用与大列表的不可变数组，重列表渲染交给虚拟滚动（见 DupeSeek.md）。

## 1. Store 一览

| Store | 职责 | 持久化 |
| :--- | :--- | :--- |
| `useSettingsStore` | 全局设置、Everything 可用状态 | JSON 文件（经 IPC） |
| `useTargetStore` | 扫描目标列表 | 随设置持久化（⚠️ D4） |
| `useExplorerStore` | Explorer 当前目录、导航历史、目录条目 | 否 |
| `useScanStore` | 扫描设置草稿、扫描状态机、进度 | 否 |
| `useDupeStore` | 重复组集合、筛选、选择器、清理执行 | 否（结果缓存后置） |
| `useTreeSizeStore` | 目录体积树、展开/聚焦状态 | 否 |

## 2. useSettingsStore

```ts
state: {
  settings: AppSettings        // 启动时经 app:get-settings 载入
  everything: EverythingStatus // 启动时探测一次，设置页可手动刷新
}
actions: { load(), save(patch), detectEverything() }
```

## 3. useTargetStore

```ts
state: { targets: string[] }   // 绝对路径，保持添加顺序
getters: { hasTarget(path), isEmpty }
actions: {
  add(paths: string[])   // 去重 + 存在性校验由主进程对话框保证；拖拽路径同样在此去重
  remove(path), clear()  // 清空需 UI 层二次确认（见 TargetList.md）
}
```

扫描中允许增删目标（旧 TargetList.md 明确此行为）；已开始的会话不受影响，仅影响下一次 `scan:start`。

## 4. useExplorerStore

```ts
state: {
  cwd: string
  entries: DirEntry[]
  loading: boolean
  history: string[]     // 后退/前进双栈可用 cwd 单栈 + 游标实现
  cursor: number
}
actions: { open(path), up(), back(), forward(), refresh() }
```

`open` 调 `fs:list`；目录条目在 Explorer 内用虚拟滚动渲染，不在此层做排序缓存。

## 5. useScanStore

```ts
state: {
  draft: ScanSettings        // 表单草稿；启动扫描时快照传给主进程
  sessionId: string | null
  status: 'idle' | 'scanning' | 'done' | 'error'
  progress: ScanProgress | null
  summary: ScanSummary | null
}
actions: { start(), stop(), reset() }
```

状态机：

```
idle ──start──▶ scanning ──scan:done──▶ done ──reset──▶ idle
                    │                        ▲
                    └──scan:error────────────┘（记录错误信息后复位）
scanning ──scan:stop──▶ scanning（等待 scan:done，summary.canceled=true）
```

`start` 前置校验：targets 非空；`sessionId` 每轮新生成，事件订阅侧负责丢弃过期包。

## 6. useDupeStore

```ts
state: {
  groups: DupeGroup[]                  // 由 scan:group 增量 append
  filter: { class: string; minSize: number | null; pathIncludes: string }
  keepChoice: Record<string, string>   // groupId → 保留条目的 path（手动覆盖）
  selectorRule: SelectorRule | null    // 当前应用的选择器
}
getters: {
  filteredGroups, totalWastedBytes, selectedRemovePaths
}
actions: {
  appendGroups(groups)   // 仅在 sessionId 匹配时
  applySelector(rule)    // 批量设定每组保留项（预览态）
  setKeep(groupId, path) // 手动点选，约束见下
  runClean(type)         // 组装 CleanAction → clean:run；成功后从 groups 移除已处理条目
}
```

**选择器规则 SelectorRule**（DupeList 的核心交互，先给最小集）：

```ts
interface SelectorRule {
  keep: 'oldest' | 'newest' | 'shortestPath' | 'longestPath' | 'first'
}
```

**选择一致性约束**：每个 DupeGroup 必须**恰好保留 1 个条目**。`applySelector` 重置所有手动覆盖；`setKeep` 只改单组；`runClean` 前校验约束，不满足则 reject 并定位到未满足的组。

**压缩包条目清理限制**：delete 对压缩包内条目无意义（只能整包删除），DupeList 中此类条目置灰、不进入 removePaths；扫描结果里它仍然参与判重与展示。

## 7. useTreeSizeStore

```ts
state: {
  root: TreeNode | null   // { name, path, size(聚合), dupWasted, children[] }
  expanded: Set<string>   // path 集合
}
actions: { buildFromGroups() 或 buildFromScanMeta(), toggle(path), focus(path) }
```

树数据来源于扫描会话的目录聚合统计（主进程在 listing 阶段顺带产出，避免渲染层重算）。

## 8. 模块位置与命名

- `src/renderer/src/stores/` 下每 store 一个文件：`settings.ts`、`target.ts`、`explorer.ts`、`scan.ts`、`dupe.ts`、`treesize.ts`。
- 一律 `defineStore('xxx', () => { ... })` setup 风格，类型使用 interface（见 Agents.local.md）。
