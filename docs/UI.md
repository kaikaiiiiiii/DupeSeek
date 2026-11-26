# UI.md — 整体界面与视觉实现

视觉规范以 AGENTS.md「视觉设计」为准（Fluent 2 / Win11 设计语言）；本文件描述**当前实现**。样式令牌集中在 `src/renderer/src/assets/main.css`。

## 窗口

- 默认 1200×800，最小 900×600；无菜单栏（`autoHideMenuBar`）。
- Windows：`titleBarStyle: 'hidden'` + 透明 `titleBarOverlay`（按钮符号色随主题，高 36px），由应用自绘 36px 标题栏（显示 `DupeSeek` 文字，`-webkit-app-region: drag`，右侧留出系统按钮位）。
- Win11（`os.release()` 主版本 > 10，或 build ≥ 10.0.22621）：追加 `backgroundMaterial: 'mica'` 与透明底色，窗口透出 Mica 质感；`window.api.mica === true` 时渲染层给 `<html>` 加 `.mica` 类供组件做透明染色（`html.mica` 下页面底色改半透明）。
- 非 Windows：原生系统边框；Linux 传入窗口 icon；mac 不出包、未真机验证（见 [KnownIssues.md](./KnownIssues.md)）。
- 单实例：第二次启动聚焦已有窗口；提权重启经 `--handover-pid` 等旧进程退出后再取锁。

## 整体布局

```
┌──────────────────────────────────────────────┐
│ 标题栏（Windows，自绘 36px）                  │
├───────────────┬──────────────────────────────┤
│ TargetList    │ Tab 栏（空间分析/扫描参数/   │
│ 280px 窗格    │ 清理规则/软件设置）          │
│（右侧竖分隔线）├──────────────────────────────┤
│               │ 当前 Tab 内容（KeepAlive）    │
└───────────────┴──────────────────────────────┘
```

- `app-shell` 纵向：标题栏（仅 Windows）+ `app-root`。
- `app-root` 横向 flex，`gap: 10px`，`padding: 0 14px 14px`（面板不贴窗口左/右/底边缘）；左栏固定 `flex: 0 0 280px`，右栏自适应。
- Tab 栏：Fluent pivot 风格——透明按钮、悬停 `--hover-bg`、激活态强调色加粗 + 底部 3px 圆角短下划线；内容区 `<KeepAlive>` 保活（切换不丢滚动与展开状态）。
- 各功能页面统一卡片容器：边框 `--border`、圆角 `--radius`（8px）、背景 `--bg`。

## 主题与令牌

- 亮/暗双主题：`:root` 为亮色，`[data-theme='dark']` 覆盖暗色；默认跟随系统（`prefers-color-scheme`），设置页可手动切换（`system / light / dark`，存 `localStorage['dupeseek-theme']`）。
- 首帧防闪：`public/theme-boot.js` 在模块脚本前同步设置 `data-theme` 与 `.mica` 类。
- 主要令牌：`--bg / --surface / --surface-hover / --surface-alt / --hover-bg / --border / --border-light / --text / --muted / --accent / --accent-fg / --accent-soft / --danger / --danger-soft / --ok / --info-bg / --info-bd / --scrim / --radius / --shadow`。
- 强调色：亮色 `#0067c0`、暗色 `#4cc2ff`（Win11 系统蓝）；语义色跟随 Fluent。
- 圆角：容器 8px（`--radius`），行内控件 4px。组件内不硬编码明暗色值，一律走令牌。
- 字体栈：`'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei'`；不引入打包字体。

## 视觉元素与状态

- 图标：界面功能图标为 `AppIcon.vue` 内联 Fluent 风格单色 SVG（`folder/file/drive/shield/chevron/plus/trash/search/dismiss/box/check`），**不用 emoji**；目录/文件内容图标走主进程图标服务：文件用 `getFileIcon`（large 32px 源），目录优先读 desktop.ini 自定义图标（仅 `IconResource`/`IconFile` 指向图片文件时），否则用内置文件夹图标（本 Electron 版本 `getFileIcon` 对目录返回「存储设备」，盘根除外——盘根保留 `getFileIcon` 的盘符图标）。批量接口单次最多 64 条，主进程缓存上限 20000。
- 列表三态：悬停 / 选中 / 聚焦齐备；全局焦点环仅键盘导航时显示（`:focus-visible`）。
- 加载：体积树子级在途用骨架行（shimmer），不用纯文字；统计弹窗显示「统计中…」。
- 提示：提权、范围规则等用彩边 info-bar（着色背景 + 图标 + 动作）；错误用危险色底 info-bar。
- 数字对齐：大小/进度等用 `font-variant-numeric: tabular-nums`。
- 虚拟滚动：TargetList 格子 70px、体积树行 34px、清理页行 30px，行高必须与 CSS 一致。

## 公共交互组件

- `ConfirmDialog.vue`：应用内 Fluent 对话框（Teleport + 遮罩 `--scrim`，Esc 取消，确认键聚焦，危险操作 danger 样式）；清空目标、删除重复文件两处使用。
- `ContextMenu.vue`：通用右键菜单（Teleport + 透明拦截层、视口边缘收敛、Esc 关闭，`select/close` 事件），空间分析行使用。
- `StatsPanel.vue`：分支统计弹窗（560px，最大 `100vw - 48px`；四项指标 + ≤10 柱 k-means 直方图；Esc/按钮关闭）。

## 样式参考库

`vendor/fluentui-web-components/`（组件 CSS 与结构）与 `vendor/fluentui-tokens/`（设计 token 值，亮/暗主题在 `src/alias/`）是 Fluent UI Web Components v3 源码快照，**仅作阅读摘抄**：禁止运行时 import、禁止修改；摘抄时在目标文件注释注明出处（组件名 + token 名）。
