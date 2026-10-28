# Known Issues — 平台与文件系统差异

面向用户的事实陈述：DupeSeek 官方构建覆盖 **Windows + Linux**（release 产物：NSIS 安装包 / zip 绿色版 / AppImage / deb）。**macOS 不出包**——`build/icon.icns` 已就绪，但 CI 无 mac 构建目标，运行从未在真机验证。核心链路（枚举 → 哈希 → 分桶比对 → 重复分组 → TreeSize）为纯 Node/Electron 实现，本身跨平台一致；差异集中在二进制依赖与文件系统特性上，逐项如下。

## 各平台处理方式（定案）

### Windows
- 枚举：Everything（es.exe）优先，未运行/未收录逐目标回退 fs walk。
- RAR：内置 `UnRAR.exe`（7.30 beta 1）——WASM 清单 + crc32 元数据 + 原生解压，完整四级校验。
- 权限不足：提供 UAC 提权重扫（`app:elevate`，PowerShell RunAs + handover 交接）。
- reparse point：junction / 符号链接 / 云占位经 `/aL` 清单整树剔除（防假重复组）。

### Linux
- 枚举：fs walk（无 Everything 通道，非 NTFS 场景一致）。
- RAR：内置 `unrar/linux/x64/unrar`（7.23），四级校验与 Windows 对齐。
- 权限不足：**不做提权，计入 denied**（定案，维持现状）。
- 符号链接：回退通道静默跳过（定案，维持现状，见 KI-4）。

### macOS
- 无官方产物、未真机验证；能力设计与 Linux 对应项一致。
- RAR：内置 `unrar/mac/arm64/unrar`（7.23）/ `unrar/mac/x64/unrar`（7.12，Intel 已停止新版分发）。
- 未来出包前需补：窗口 icon 接线（现为 Linux-only 分支）、签名/公证。

## 平台差异

| 能力 | Windows | Linux | macOS |
| --- | --- | --- | --- |
| 枚举：Everything（es.exe） | ✓（NTFS 卷） | ✗ → 逐目标回退 fs walk | ✗ → 同左 |
| 枚举：fs walk 回退 | ✓ | ✓ | 未验证 |
| zip/7z 内容比对（7zip-bin） | ✓ | ✓ | 理论 ✓（7zip-bin 含 darwin 二进制） |
| RAR 列表（node-unrar-js WASM） | ✓ | ✓ | 理论 ✓ |
| RAR 解压（内置原生 unrar） | ✓ | ✓ | ✓（未真机验证） |
| UAC 提权（app:elevate） | ✓ | ✗ 见 KI-2 | ✗ |
| 打包产物 | NSIS + zip | AppImage + deb | 无 |

### KI-1 ~~Linux/mac 上 RAR 内容比对止步于元数据级~~（已解决）
三平台原生 unrar 已随应用内置（`resources/bin/unrar/`，版本与来源见该目录 README.md），`unrarExe()` 按 `platform/arch` 解析，Linux/macOS 的 RAR 内容比对升级为与 Windows 一致的完整四级校验（清单 → crc32 → 解压 headMD5 → fullMD5）。RAR **压缩**能力不在内置范围：设置页「能力检测」展示本机是否安装 WinRAR/rar（Windows 查 Program Files 常见位置 + PATH；unix 查 PATH），仅作展示、应用不做压缩。遗留注意：macGatekeeper 对未签名应用内二进制的隔离属性（xattr）需在真机构建时验证；应用本身未签名，出包时一并处理。

### KI-2 提权重扫仅 Windows
权限不足时的「提权重扫」走 PowerShell `Start-Process -Verb RunAs`（UAC）。Linux/mac 无此路径：不可读文件/目录计入 denied 计数并在结果中标注，扫描不中断。**定案：Linux/mac 不做提权，denied 即可。**

### KI-3 mac 未验证项清单
窗口 icon 仅传 Linux 分支（`src/main/index.ts`）；签名/公证未配置；unrar 已内置（x64 7.12 / arm64 7.23）但未经真机验证；`window-all-closed` 行为符合 mac 惯例（关窗不退出）。

## 文件系统一致性

| 文件系统 | 表现 |
| --- | --- |
| NTFS | 功能完整：junction/符号链接经 `/aL` 清单剔除子树（防假重复组）；硬链接按约定双计、零特判 |
| FAT32 / exFAT | 无 reparse point，剔除逻辑自然旁路；Everything 不收录非 NTFS 卷 → 自动回退 fs walk；行为与 NTFS 一致 |
| ext4 / btrfs / xfs | 回退枚举正常；EACCES 权限不足计入 denied；硬链接同样双计（`st.ino` 可用，未来精确释放量可聚合修正） |
| APFS | 未验证（无 mac 产物） |

### KI-4 回退通道静默跳过符号链接（含 Windows 目录符号链接）
fs walk 按 dirent 类型分流：符号链接条目 `isDirectory()`/`isFile()` 均为 false，**被静默跳过**——链接所指的真实内容不参与扫描。副作用是良性的：无循环穿越风险（`/a` → `b` → `/a` 类环不会死循环）、无假重复组；但用户预期里"链接也是文件"的场景会漏扫。若将来要支持，须引入 visited(inode) 集合防环。**定案：维持现状。**

### KI-5 大小写敏感性按精确匹配
L0 桶键与去重键使用精确文件名（大小写敏感比较）。NTFS 虽大小写不敏感，但同目录不能共存仅大小写不同的两个名字，跨目录同名不同大小写属不同文件、由 md5 阶梯正确裁决——无已知问题；列此条仅为固化该结论。

### 备注：虚拟路径分隔符 `::`
压缩包内条目的键为 `containerPath + '::' + entryPath`，仅做**前缀拼接**（purgeTargets 前缀剔除、分组根键），从不切分解析。Linux 合法文件名可含 `::`，不会破坏分组键的唯一性；仅列表显示时可能产生歧义观感。若未来需要从键中还原容器与条目两段，必须用 `lastIndexOf` 或记录边界而不是 `split('::')`。

## 数据层

- mtime（`st.mtimeMs` 向下取整）跨平台语义一致，仅用于保留策略（最旧/最新）。
- 体积统计口径：所有文件系统一律按路径双计（含硬链接，见 docs/DupeSeek.md 设计约定）。
