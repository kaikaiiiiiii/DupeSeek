# Database.md — 数据持久化

## 当前实现：JSON 文件（无数据库）

工程当前**没有 SQLite**（`package.json` 无任何数据库依赖）。持久化只有一处：

- 文件：`<userData>/settings.json`（Electron `app.getPath('userData')` 下的用户数据目录）。
- 读写：`src/main/settings.ts`，进程内缓存；`app:get-settings` / `app:set-settings` IPC，写盘失败不阻断功能（下次启动回默认）。
- 结构：

```json
{
  "targets": ["D:\\Coding", "D:\\Downloads"],
  "scanDraft": {
    "targets": ["D:\\Coding", "D:\\Downloads"],
    "ignoreName": false,
    "excludeHidden": false,
    "excludeSystem": false,
    "excludeJunction": true,
    "excludeDirNames": "node_modules",
    "excludeDirPaths": "",
    "minSize": null,
    "maxSize": null,
    "extBlacklist": [],
    "extWhitelist": [],
    "scanArchives": true,
    "archiveTypes": ["zip", "7z", "rar"],
    "useEverything": true
  },
  "resumeScan": false
}
```

- `resumeScan`：提权重启后自动续扫的一次性标记，新实例消费后置回 false。
- 旧版本兼容：读取时若 `scanDraft.excludeNodeModules === false`（旧布尔开关）则把 `excludeDirNames` 置空（迁移为名称排除列表语义）。
- 主题模式不在该文件：存于渲染层 `localStorage['dupeseek-theme']`。

## 扫描结果不持久化

重复组、体积树、哈希记忆化等均为**会话内内存状态**，应用退出即丢失；下次启动恢复目标列表与扫描草稿后自动重新做增量扫描（目标变化触发同步）。不存在「扫描历史库/结果缓存」表。

## SQLite（计划，未实现）

原设计中的 SQLite 持久化（扫描结果、设置入库、快速下次访问）为后续迭代方向，当前没有任何表结构或迁移代码。引入时需要：

- 在 `docs/` 增加实际表结构与迁移策略；
- 把 `settings.ts` 的 JSON 读写替换或桥接为数据库（保持 `AppSettings` 接口不变）；
- 扫描结果入库涉及大表（条目/组/树），需评估与现有「持久会话 + 增量」内存模型的关系。

在此之前，请勿按「已有 SQLite」的假设开发或排障。
