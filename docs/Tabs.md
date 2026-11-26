# Tabs.md — 标签页切换

主界面右侧为「顶部标签页 + 对应功能界面」结构；左侧 TargetList 常驻显示，不受切换影响。

| 显示文字 | 功能界面组件 | 职责 |
| --- | --- | --- |
| 空间分析 | `TreeSizeView.vue` | 体积树、分支统计、行右键菜单（默认标签页） |
| 扫描参数 | `ScanView.vue` | 扫描选项、进度、提权提示、扫描汇总 |
| 清理规则 | `DupeList.vue` | 重复组列表、筛选、勾选待清理与删除 |
| 软件设置 | `SettingsView.vue` | Everything/压缩包开关、主题、RAR 能力检测 |

## 实现要点

- 标签页状态在 `useUiStore().activeTab`（`'treesize' | 'scan' | 'dupes' | 'settings'`），不是 `App.vue` 的局部 `ref`；任何组件（如空间分析右键「清理该位置重复文件」）可通过 `ui.setActiveTab('dupes')` 完成跨页面跳转。
- `App.vue` 根据 `activeTab` 从 `tabs` 常量中取组件，内容区用 `<KeepAlive>` 包裹：切换标签页不销毁组件，扫描计时、滚动位置、树展开状态得以保留。
- 标签栏为 Fluent pivot 风格：透明按钮、悬停 `--hover-bg`、激活态强调色加粗 + 底部 3px 圆角短下划线。
- 原「浏览」标签页已移除：添加/删除扫描目标由左侧 TargetList 的对话框、拖拽与悬停操作完成；空间分析置于首位。
