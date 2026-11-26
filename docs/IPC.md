# IPC.md — 前后端 IPC 通信协议

> v0.4（2026-11-26）。类型引用见 [DataModel.md](./DataModel.md)，实现在 `src/main/ipc.ts` 与 `src/preload/index.ts`，契约类型在 `src/shared/types.ts` 的 `DupeSeekApi`。
>
> **实现状态**：全部下列通道均已落地。`scan:error` 事件仅保留订阅端（主进程当前不发送，异常经 invoke reject 上报，见 §4）。

## 1. 约定

- Channel 命名：`域:动作`（如 `scan:start` → 实际为 `scan:sync`/`scan:rescan`）。
- 请求/响应使用 `ipcMain.handle` + `ipcRenderer.invoke`；成功返回数据，失败 reject `Error`（message 为中文可读原因）。渲染层统一 catch：扫描相关错误写入 `useScanStore.error` 并在扫描页展示。
- 主进程主动推送使用 `webContents.send`，preload 封装为 `on*` 订阅函数并返回取消订阅的 cleanup 函数。**实际用法**：各 store 在模块加载时注册一次订阅、运行期不取消（应用单页常驻，无卸载场景）。
- 参数经 preload 的统一 `plainJson()` 拍平（Vue 响应式 Proxy 不能直接过 contextBridge）。
- payload 类型全部定义在 `src/shared/types.ts`，preload 类型声明在 `src/preload/index.d.ts`。

## 2. Renderer → Main（invoke / send）

| Channel | 入参 | 返回 | 说明 |
| :--- | :--- | :--- | :--- |
| `dialog:select-targets` | `kind: 'dir' \| 'file' \| 'both'`（位置参数，非对象） | `string[] \| null` | 系统多选对话框；取消返回 null |
| `fs:reveal` | `path: string` | `void` | 在资源管理器中定位（`shell.showItemInFolder`），TargetList 放大镜 |
| `fs:open-path` | `path: string, kind: 'dir' \| 'file'` | `void` | 空间分析右键「在资源管理器中打开」：目录 `shell.openPath`，文件定位所在文件夹 |
| `scan:sync` | `ScanSettings` | `ScanSummary` | 目标列表增量同步：diff 目标集合——新增枚举+触碰桶比较，移除纯内存清理；**`targets` 为空 = 清空会话全部目标**（不再 reject）。实现中 `running` 时 reject「已有扫描任务在进行中」 |
| `scan:rescan` | `ScanSettings` | `ScanSummary` | 清空引擎会话（条目/组/树）后按当前目标全量重扫；`running` 时 reject |
| `scan:refresh-branch` | `ScanSettings, path: string` | `RefreshBranchReport` | 单独重遍历某子树并与会话比对，不改变目标列表；按传入的扫描参数（当前草稿）执行。`running` 时 reject；路径不在任何已同步目标内、或位于排除目录内时 reject |
| `scan:stop` | **send**：`sessionId: string` | — | 协作式取消；主进程 handler 忽略入参，置 `canceled`，已算结果照常回流 |
| `clean:run` | `CleanAction` | `CleanReport` | 执行删除（进回收站）；确认弹窗由渲染层负责 |
| `app:elevate` | — | `boolean` | UAC 提权重启：保存 `resumeScan` 标记 → `Start-Process -Verb RunAs` 拉起管理员实例（`--handover-pid` 交接：新实例轮询等旧进程退出后再取单实例锁）→ 旧实例退出。用户取消返回 false |
| `app:get-settings` | — | `AppSettings` | 读取 `settings.json`（含上次目标列表与扫描草稿） |
| `app:set-settings` | `Partial<AppSettings>` | `AppSettings` | 合并保存并返回全量；写盘失败不阻断（下次启动回默认） |
| `app:capabilities` | — | `AppCapabilities` | RAR 能力检测：内置 unrar 是否存在 + 本机 WinRAR/rar 是否存在（仅检测展示） |
| `app:file-icons` | `paths: string[]` | `Record<string, string>` | 批量取系统图标（dataURL，主进程带缓存；支持 desktop.ini 自定义图标） |
| `app:overlay-theme` | `dark: boolean` | `void` | 同步 Win11 标题栏按钮配色（仅 win32 且启用 overlay 时生效，失败静默） |
| `tree:roots` | `sortKey: TreeSortKey, desc: boolean` | `TreeChildrenReply` | 体积树根级行（每个已同步目标一行，含全局 stats） |
| `tree:children` | `dir: string, sortKey, desc` | `TreeChildrenReply \| null` | 某目录的子目录行 + 直属文件聚合；目录不存在返回 null |
| `tree:files` | `dir, sortKey, desc, offset, limit` | `TreeFilesReply \| null` | 某目录直属文件分页；目录不存在返回 null |
| `tree:stats` | `path: string` | `BranchStats \| null` | 分支统计（右键「统计数据」）；`容器::` 合成节点或不在树中返回 null |

## 3. Main → Renderer（send 事件）

| Channel | Payload | 说明 |
| :--- | :--- | :--- |
| `scan:progress` | `ScanProgress` | 约 100ms 节流的进度（含 `treeRev`、`denied`、各目标进度）；渲染层仅在 `status === 'scanning'` 时消费 |
| `scan:rev` | `{ rev: number }` | 独立的体积树版本广播：移除目标/分支刷新等**不伴随 progress** 的变更；渲染层 400ms 尾沿节流后按需重取已展开路径 |
| `scan:group` | `{ sessionId; groups: DupeGroup[] }` | 已确认重复组的增量推送，按「每 50 组或每 500ms」攒批；渲染层按 key 幂等整组替换（`scan:group` 在「扫描中」或「分支刷新中」放行） |
| `scan:done` | `ScanSummary` | 每次 `scan:sync` / `scan:rescan` 收尾（含被取消的收尾）；渲染层状态机随之落 `done` |
| `scan:error` | `{ sessionId; message }` | **预留通道**：主进程当前无发送点。扫描异常经 invoke reject 返回，渲染层在 catch 中写 `error` 状态 |

## 4. 事件守卫（与旧文档不同，按实现）

- `sessionId` 由主进程每次同步/重扫新生成，**晚于**事件到达，因此渲染层**不**用它过滤过期包；改为：
  - `scan:progress` / `scan:done` / `scan:error`：仅 `status === 'scanning'` 时消费；
  - `scan:group`：`status === 'scanning'` **或** `refreshing === true`（分支刷新期状态机保持 `done`）时消费；
  - 首次收到事件时「收养」其 `sessionId` 供 `scan:stop` 使用；
  - 体积树响应按 `rev` 比较（小于当前版本的回复丢弃）。
- `scan:stop` 是 send 而非 invoke：不等待主进程应答，停止结果通过 `scan:done`（`canceled: true`）体现。

## 5. Everything 集成（主进程内部，无 IPC 通道）

- Everything 只影响主进程的**枚举阶段**，对渲染层完全透明。
- 通道：随应用分发的 `es.exe`（`resources/bin/es.exe`，开发态取项目根 `resources`；另探测 Program Files 下的 Everything 安装），经其 IPC 与运行中的 Everything 通信，无需 HTTP 服务。
- 每目标 **3 次**查询：`-path <目标> /a-d`（文件）、`/ad`（目录）、`/aL`（reparse 清单），布局为 `-full-path-and-name -size -date-modified -size-format 1 -date-format 3`，`-export-json` 落临时文件后由 worker 线程解析（文件可达数百 MB，避免阻塞主进程）。
- 回退（逐目标）：es.exe 缺失、Everything 未运行、查询失败，或「目标目录非空但返回 0 条」（未收录，如非 NTFS 卷）时，该目标回退 fs walk；其余目标不受影响。
- 一致性：枚举结果与 fs walk 输出结构一致（FileEntry 的 meta 部分），过滤规则（hidden/system/扩展名/大小/排除目录）在两个通道分别实现、语义对齐。

## 6. preload 暴露面（`window.api`，即 `DupeSeekApi`）

```ts
interface DupeSeekApi {
  // 环境
  platform: string
  mica: boolean
  pathForFile(file: File): string

  // 对话框 / 文件系统
  selectTargets(kind: 'dir' | 'file' | 'both'): Promise<string[] | null>
  reveal(path: string): Promise<void>
  openPath(path: string, kind: 'dir' | 'file'): Promise<void>

  // 扫描
  scanSync(settings: ScanSettings): Promise<ScanSummary>
  scanRescan(settings: ScanSettings): Promise<ScanSummary>
  refreshBranch(settings: ScanSettings, path: string): Promise<RefreshBranchReport>
  scanStop(sessionId: string): void

  // 清理 / 设置 / 能力 / 图标 / 主题
  cleanRun(action: CleanAction): Promise<CleanReport>
  elevate(): Promise<boolean>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  capabilities(): Promise<AppCapabilities>
  fileIcons(paths: string[]): Promise<Record<string, string>>
  setOverlayTheme(dark: boolean): Promise<void>

  // 体积树
  treeRoots(sortKey: TreeSortKey, desc: boolean): Promise<TreeChildrenReply>
  treeChildren(dir: string, sortKey: TreeSortKey, desc: boolean): Promise<TreeChildrenReply | null>
  treeFiles(dir: string, sortKey: TreeSortKey, desc: boolean, offset: number, limit: number): Promise<TreeFilesReply | null>
  treeStats(path: string): Promise<BranchStats | null>

  // 事件（返回取消订阅函数）
  onScanProgress(cb: (p: ScanProgress) => void): () => void
  onScanGroup(cb: (p: { sessionId: string; groups: DupeGroup[] }) => void): () => void
  onScanDone(cb: (s: ScanSummary) => void): () => void
  onScanError(cb: (p: { sessionId: string; message: string }) => void): () => void
  onTreeRev(cb: (p: { rev: number }) => void): () => void
}
```

另经 contextBridge 暴露 `window.electron`（来自 `@electron-toolkit/preload`）。
