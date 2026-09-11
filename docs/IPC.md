# IPC.md — 前后端 IPC 通信协议

> v0.2（2026-09-12）。类型引用见 [DataModel.md](./DataModel.md)，实现在 `src/main/ipc.ts` 与 `src/preload/index.ts`。
>
> **实现状态**：基础通道全部落地（dialog/fs/scan/clean/settings + 四个 scan 事件）。`everything:detect` 与 Everything 枚举加速为后续迭代，未实现。

## 1. 约定

- Channel 命名：`域:动作`（如 `scan:start`）。
- 请求/响应使用 `ipcMain.handle` + `ipcRenderer.invoke`；**成功返回数据，失败 reject `Error`**（message 为用户可读的中文原因），渲染层统一 catch 后入 toast。
- 主进程主动推送使用 `webContents.send`，渲染层在 preload 中封装为 `on*` 订阅函数，**返回取消订阅的 cleanup 函数**，组件卸载时必须调用。
- 所有 payload 类型定义在 `src/shared/types.ts`，preload 的类型声明在 `src/preload/index.d.ts`。

## 2. Renderer → Main（invoke）

| Channel | 入参 | 返回 | 说明 |
| :--- | :--- | :--- | :--- |
| `dialog:select-targets` | `{ kind: 'dir' \| 'file' \| 'both' }` | `string[] \| null` | 系统多选对话框；取消返回 null |
| `fs:list` | `path: string` | `DirEntry[]` | Explorer 目录列表；无权限等错误 reject（目录不空但不可读返回 []） |
| `fs:places` | — | `{ favorites: FavoriteItem[]; drives: FavoriteItem[] }` | 预置目录（桌面/文档/下载/用户目录）+ 盘符列表 |
| `fs:reveal` | `path: string` | `void` | 在系统资源管理器中显示该条目（TargetList 放大镜图标） |
| `scan:start` | `ScanSettings` | `sessionId: string` | 异步启动扫描会话；进度经事件回流。设置非法（如 targets 为空）reject |
| `scan:stop` | `sessionId: string` | `void` | 协作式取消：主进程尽快停止，已算出的结果照常回流 |
| `everything:detect` | — | `EverythingStatus` | 检测 Everything 是否可用 |
| `clean:run` | `CleanAction` | `CleanReport` | 执行删除/硬链接/合并移动；执行前由渲染层负责确认弹窗 |
| `app:get-settings` | — | `AppSettings` | 全局设置（含上次的目标列表 ⚠️ D4） |
| `app:set-settings` | `Partial<AppSettings>` | `AppSettings` | 合并保存；设置先落 JSON 文件，SQLite 后置 |
| `app:elevate` | — | `boolean` | 请求 UAC 提权并以管理员重启：保存 `resumeScan` 标记 → `Start-Process -Verb RunAs` 拉起管理员实例 → 成功后旧实例退出；用户取消 UAC 返回 false。`AppSettings.resumeScan` 为一次性续扫标记，新实例消费后自动重扫 |

## 3. Main → Renderer（send 事件）

| Channel | Payload | 说明 |
| :--- | :--- | :--- |
| `scan:progress` | `ScanProgress` | 节流推送（约 100ms 一条），Scan 页渲染进度条与当前路径 |
| `scan:group` | `{ sessionId: string; groups: DupeGroup[] }` | **增量批量**推送已确认的重复组；主进程按"每 50 组或每 500ms"攒批，避免渲染层抖动 |
| `scan:done` | `ScanSummary` | 扫描结束（含被取消的收尾） |
| `scan:error` | `{ sessionId: string; message: string }` | 扫描异常终止；随后仍会发 `scan:done` 以复位状态机 |

事件均携带 `sessionId`，渲染层收到**过期 sessionId** 的事件必须丢弃（防止上一轮扫描的残包污染新一轮）。

## 4. Everything 集成说明（已实现）

- Everything 只影响主进程内部的**枚举阶段**（代替递归 fs.walk 获取文件/目录清单），对渲染层完全透明，不单开 IPC channel。
- **通道**：es.exe（voidtools 官方 CLI，随应用分发在 `resources/bin/`，经 IPC 消息与运行中的 Everything 通信，无需 HTTP 服务）。定位顺序：打包资源 → 开发目录 → Everything 安装目录。
- **查询**：每个目标目录两次调用——`-path <目标> -a-d-L` 取文件、`-path <目标> -ad-L` 取目录（均排除 reparse point，对应 walk 的 junction 排除），布局为 `-full-path-and-name -size -date-modified -size-format 1 -date-format 3`，经 `-export-json` 落临时文件（UTF-8 BOM）后解析。
- **回退（逐目标）**：es.exe 缺失、Everything 未运行、查询失败，或"目标目录非空但 Everything 返回 0 条"（未收录，如非 NTFS 卷）时，该目标回退 fs.walk；其余目标不受影响。
- 枚举结果与 fs.walk 输出**结构完全一致**（FileEntry 的 meta 部分），过滤规则（隐藏/系统/扩展名/大小）与比对阶梯不感知数据来源。
- 约束：Everything 只收录 NTFS 卷；junction 排除依赖 `attributes:L`，Everything 索引延迟（约秒级）对新建文件生效。

## 5. preload 暴露面（`window.api`）

```ts
interface DupeSeekApi {
  selectTargets(kind: 'dir' | 'file' | 'both'): Promise<string[] | null>
  listDir(path: string): Promise<DirEntry[]>
  places(): Promise<{ favorites: FavoriteItem[]; drives: FavoriteItem[] }>
  reveal(path: string): Promise<void>
  pathForFile(file: File): string
  scanStart(settings: ScanSettings): Promise<string>
  scanStop(sessionId: string): void
  cleanRun(action: CleanAction): Promise<CleanReport>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  onScanProgress(cb: (p: ScanProgress) => void): () => void
  onScanGroup(cb: (p: { sessionId: string; groups: DupeGroup[] }) => void): () => void
  onScanDone(cb: (s: ScanSummary) => void): () => void
  onScanError(cb: (p: { sessionId: string; message: string }) => void): () => void
}
```
