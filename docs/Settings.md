# Settings.md — 软件设置视图

软件设置（`SettingsView.vue`）位于主界面右侧功能区，Tabs 标签为「软件设置」（见 [Tabs.md](./Tabs.md)）。页面为两张卡片，均可滚动。

## 扫描卡片

- `使用本机 Everything 加快扫描`（`useEverything`，默认开）：勾选时若 Everything 正在运行则用其索引枚举文件（未运行自动回退常规遍历）；取消则始终常规遍历。改动**即时保存**，对下一次扫描/同步生效，不打断进行中的扫描。
- `解析压缩包内容（zip/7z/rar）`（`scanArchives`，默认开）：勾选时压缩包内文件参与查重（压缩包本身始终作为普通文件参与）；取消时压缩包视作普通文件，只比对包文件本身。同样即时保存、下一轮生效。

## 能力检测卡片

- `主题`：下拉选择 `跟随系统 / 亮色 / 暗色`。主题模式存于渲染层 `localStorage['dupeseek-theme']`，切换立即应用；选择「跟随系统」时监听系统主题变化。Win11 下同时同步标题栏按钮配色（`app:overlay-theme`）。
- `RAR 内容读取（内置 unrar）`：显示可用/不可用（附带路径 title）；对应 `AppCapabilities.rar.bundledExtract`，即随应用分发的原生 unrar。
- `RAR 压缩（本机 WinRAR / rar）`：显示已安装/未检测到；对应 `AppCapabilities.rar.compress`，仅做存在性检测，**应用本身不提供压缩功能**，未检测到不影响扫描。
- 能力检测在进入设置页时调用一次 `app:capabilities`。

## 持久化

- 应用设置（目标列表 `targets`、扫描草稿 `scanDraft`、提权续扫标记 `resumeScan`）由主进程保存在用户数据目录的 **`settings.json`**（JSON 文件），经 `app:get-settings` / `app:set-settings` 读写；每次 `patch` 合并保存并返回全量。
- **当前没有 SQLite**（旧设计已废弃，见 [Database.md](./Database.md)）。
- 旧版本布尔开关 `excludeNodeModules` 在启动读取时自动迁移：曾关闭该开关的用户 `excludeDirNames` 置空。
- 写盘失败不阻断功能（下次启动回默认值）。
