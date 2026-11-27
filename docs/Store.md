# Store.md — Pinia 状态管理设计

> v0.4（2026-11-26）。类型引用见 [DataModel.md](./DataModel.md)，通道定义见 [IPC.md](./IPC.md)。实现在 `src/renderer/src/stores/`。
>
> 原则：组件之间不直接传数据，一律通过 store；渲染层不持有文件系统的「私有副本」，体积树与重复组的权威数据在主进程。大列表渲染交给虚拟滚动（virtua VList，封装见 `components/VirtualScrollList.vue`）。事件订阅在 store **首次实例化**（首次 `useXxxStore()`）时注册一次（应用单页常驻，不做卸载清理）。

## 1. Store 一览

| Store              | 文件            | 职责                                             | 持久化                         |
| :----------------- | :-------------- | :----------------------------------------------- | :----------------------------- |
| `useSettingsStore` | `settings.ts`   | 应用设置（目标列表、扫描草稿）的读写封装          | `settings.json`（经主进程 IPC） |
| `useTargetStore`   | `target.ts`     | 扫描目标列表、增删清空                            | 随设置的 `targets`             |
| `useScanStore`     | `scan.ts`       | 扫描草稿、状态机、进度、目标增量同步、分支刷新    | 草稿随设置持久化               |
| `useDupeStore`     | `dupe.ts`       | 重复组集合、筛选、勾选集、范围规则、清理执行      | 否（会话内）                   |
| `useTreeSizeStore` | `treesize.ts`   | 体积树拉取式缓存、展开状态、平面行装配、排序      | 否（会话内）                   |
| `useGraphStore`    | `graph.ts`      | 目录关系图回包缓存（按深度/阈值分键）、加载态与错误 | 否（会话内）                  |
| `useIconStore`     | `icons.ts`      | 行内系统图标的请求合批与缓存                      | 否（主进程另有缓存）           |
| `useUiStore`       | `ui.ts`         | 界面级状态：当前标签页（跨组件跳转）              | 否                             |

全部使用 `defineStore('xxx', () => { ... })` setup 风格，类型使用 interface（见 Agents.local.md）。

## 2. useSettingsStore

```ts
state: { settings: AppSettings | null }
actions: {
  load(): Promise<AppSettings>        // app:get-settings，启动时调用一次
  patch(p: Partial<AppSettings>)      // app:set-settings 合并保存，返回全量并回写 state
}
```

主题模式**不**在此 store：保存在渲染层 `localStorage['dupeseek-theme']`（`system | light | dark`），由 `utils/theme.ts` 管理。

## 3. useTargetStore

```ts
state: { targets: string[] }          // 绝对路径，保持添加顺序
actions: {
  init(list: string[])                // 启动恢复
  add(paths: string[]): Promise<number> // 精确字符串去重，返回新增数量；有新增即持久化
  remove(path: string)                // 从列表移除并持久化（不删文件）
  clear()                             // 清空并持久化
}
```

目标增删本身不直接触发扫描：`App.vue` 监听 `targets` 变化后调用 `useScanStore().syncTargets()`（见 §5）。重复路径由本 store 去重；嵌套目标（父/子目录同时存在）由引擎负责路径级去重与归属。

## 4. useTreeSizeStore

```ts
state: {
  expanded: Map<string, string>   // 位置 ID → 取数指令（目录路径 / AGG_PREFIX+父目录）
  sortKey: 'name' | 'size' | 'dup'
  sortDesc: boolean
  rev: number                     // 已应用到的树版本
  childrenCache: Record<string, TreeChildrenReply | 'loading'>
  filesCache: Record<string, TreeFilesReply | 'loading'>
}
getters/computed: stats、rows（虚拟滚动平面行）、maxSize、maxDup
actions: ensureChildren(dir, force?)、ensureFiles(dir, force?)、refresh()、
         setRev(v)、setSort(key)、toggleRow(row)、reset()、expandAll()、collapseAll()
```

- 拉取式：前端不持有全量树，只在展开时请求 `tree:roots` / `tree:children` / `tree:files`，缓存**曾展开过**的路径（内存 O(曾展开)；`reset()`/`collapseAll()` 不释放缓存，见 TreeSize.md「已知限制」）。
- `setRev` 做 400ms 尾沿节流：rev 变化后只重取已展开路径，旧数据保留显示（stale-while-revalidate，避免哈希期闪烁）。
- 响应 `rev < 当前 rev` 视为过期丢弃；展开状态按「位置 ID」记键（同一路径作为嵌套目标根行与父级子行时是两个独立 UI 条目，数据缓存仍按路径共享）。
- 订阅：`scan.progress.treeRev` 变化（仅扫描中）与 `onTreeRev` 广播（移除目标/分支刷新等）都汇入 `setRev`。初始化时立即拉取根级。
- 平面行规则：目录行 → 展开后取子目录 + 可选聚合行 `[n 个文件]`（目录同时有子目录与直属文件时）；无子目录的目录展开后直接列直属文件；子级数据在途时插入定高 `loading` 占位行。

## 5. useScanStore

```ts
state: {
  draft: ScanSettings              // 表单草稿；同步/扫描时快照传给主进程
  sessionId: string                // '' 为哨兵，首个事件到达时收养
  status: 'idle' | 'scanning' | 'done' | 'error'
  progress: ScanProgress | null
  summary: ScanSummary | null
  targetProgress: Record<string, number> // 各目标独立进度 0-100
  syncedTargets: string[]          // 已同步到引擎的目标集合（增量 diff 基准）
  pendingSync: boolean             // 扫描/刷新期间的目标变化：结束后补一轮同步
  refreshing: boolean              // 分支刷新进行中（不进扫描状态机）
  error: string
}
actions: initDraft(saved)、syncTargets()、rescanAll()、refreshBranch(path)、stop()
```

- **事件订阅（store 首次实例化时注册）**：
  - `onScanProgress`：仅 `status === 'scanning'` 消费，更新 `progress` 与 `targetProgress`；
  - `onScanGroup`：`status === 'scanning' || refreshing` 时 `dupe.appendGroups(groups)`；
  - `onScanDone`：仅扫描中消费，落 `summary`、`status = 'done'`、`syncedTargets` 对齐、完成目标进度置 100、`treesize.setRev(summary.treeRev)`；
  - `onScanError`：仅扫描中消费（当前主进程不发送该事件）。
- **目标增量同步**：`App.vue` watch `targets` → `syncTargets()`。扫描中或刷新中只置 `pendingSync = true`；正常路径为「移除目标乐观内存清理（`dupe.purgeTargets`）→ 归零/保留进度 → 持久化草稿 → `scan:sync` → 落 summary/rev → `maybePendingSync()`」。空目标且从未同步过（`syncedTargets` 为空）时直接返回，避免启动时产生 0 汇总噪音；清空全部目标时把引擎同步为空并清空 summary。
- **整体重扫**：`rescanAll()` 先清空 dupe/treesize/syncedTargets 再 `scan:rescan`；无目标时 reject「请先在左侧添加扫描目标」（扫描页展示）。
- **分支刷新**：`refreshBranch(path)` 要求非扫描/非刷新状态；`refreshBranch` IPC 期间 `refreshing = true`，完成后 `dupe.pruneUnderPath(path)` + `treesize.setRev(report.treeRev)`。**已知缺口**：未消费 `pendingSync`、刷新错误被调用方静默捕获、刷新后重复组的收敛不完整（见 docs/Cleanup.md「已知缺口」）。
- 状态机：

```
idle ──syncTargets/rescanAll──▶ scanning ──scan:done / invoke 返回──▶ done ──下一次同步──▶ scanning
                                    │
                                    └──invoke reject──▶ error ──下一次同步──▶ scanning
scanning ──scan:stop──▶ scanning（等待 scan:done，summary.canceled = true）
```

## 6. useDupeStore

```ts
state: {
  groups: DupeGroupView[]        // DupeGroup + 会话内自增 id（仅渲染 key/折叠用）
  checked: Set<string>           // 待清理勾选集（路径）；压缩包内条目永不进入
  scopeRule: ScopeRule | null    // 当前生效的范围规则；null = 纯手动勾选
  filter: { class, minSize, pathIncludes }
  lastReport: CleanReport | null
}
getters/computed: totalWasted、checkedCount、visibleGroups
actions: appendGroups(groups)、purgeTargets(prefixes)、markScanDone()、
         isChecked(path)、toggleChecked(path)、applyScopeRule(rule)、clearScopeRule()、
         pruneUnderPath(prefix)、applyKeepRule(rule)、planClean()、runClean()、reset()
```

- 组同步：按 `key` 幂等——同 key 整组替换（成员可能增加），组 id 保持稳定；每次变更后 `syncChecked()` 对齐勾选集。
- 筛选：`visibleGroups` = 扩展名（大小写不敏感，命中任一条目）/ 最小体积（组大小）/ 路径包含（子串）过滤；**注意**选择器与清理计划只作用于可见组，勾选集本身跨全部组。
- 勾选模型：勾选 = 待清理（删除候选）。`applyScopeRule` 按规则重算勾选集；`applyKeepRule`（每组保留 first/oldest/newest/shortestPath 之一）自动反勾同组其余普通条目并清除范围规则。
- 清理计划 `planClean()`：遍历可见组，「范围外存活才删」——一组内全部普通条目都被勾选时整组跳过（`skippedGroups` 供确认弹窗预告），其余勾选项进入 `removePaths`、未勾选普通条目进入 `keepPaths`。
- `runClean()`：`clean:run` 删除进回收站；成功项从组中移除、失败项保留，组不足 2 个成员解散；`lastReport` 供页面展示。
- `pruneUnderPath(prefix)`：分支刷新后仅从勾选集剔除该前缀路径（不修正组列表——已知缺口）。
- `markScanDone()` 目前空实现（预留扩展点）。

## 7. useIconStore

```ts
state: { cache: Record<path, dataURL> }
actions: request(path)   // 120ms 合批 → app:file-icons；失败保持占位
```

只挂载可见行时请求（`TreeIcon` onMounted 触发），未展开/不可见路径不产生开销；主进程侧还有 path → 图标缓存。

## 8. useGraphStore

```ts
state: {
  cache: Record<'depth:minSharedBytes', GraphRelationsReply>
  loading: Set<string>          // 在途查询键
  errors: Record<string, string>
}
getters/computed: 无（视图自行按当前参数取值）
actions: replyOf(depth, minBytes)、loadingOf(depth, minBytes)、errorOf(depth, minBytes)、
         load(depth, minBytes, force?)
```

- 供「关系气泡」「关系捆绑」两个视图共用：数据由主进程 `graph:relations` 实时聚合，
  渲染层只缓存回包，不持有重复内容明细；不同深度/阈值各自分键缓存。
- 会话数据变化（`scan:rev` / 扫描进度 treeRev → `useTreeSizeStore.rev`）时，视图在
  500ms 防抖后以 `force = true` 重取；查询在途时重复调用直接忽略。
- 视图参数（深度、最小共享字节）保存在组件本地，不进入 store、不持久化。

## 9. useUiStore

```ts
state: { activeTab: 'treesize' | 'relation-force' | 'relation-bundle' | 'scan' | 'dupes' | 'settings' }
actions: setActiveTab(tab)
```

界面级状态不进入数据模型；跨组件跳转（如空间分析右键「清理该位置重复文件」→ 清理规则页）通过它完成。`App.vue` 的 Tab 栏与内容区都读它，切换组件用 `<KeepAlive>` 保活。

## 10. 跨 store 依赖与初始化

- `scan.ts` 依赖 `treesize`（setRev）、`dupe`（appendGroups）、`target`、`settings`；`treesize.ts` 依赖 `scan`（progress 的 treeRev）。二者相互引用，靠 Pinia 延迟实例化规避循环依赖。
- `App.vue` 启动顺序：`initTheme()` → `settings.load()` → `target.init(settings.targets)` → `scan.initDraft(settings.scanDraft)` → `dupe.reset()` →（若 `resumeScan` 则 `rescanAll()`）。`target.init` 触发的 watch 会让已恢复的目标自动开始增量同步。
