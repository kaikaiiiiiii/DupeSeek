# 随应用分发的 unrar

作为各平台读取 RAR 包内容的默认能力（只解压读取，不做压缩）。
由 `src/main/scan/archives.ts` 的 `unrarExe()` 按平台与架构解析：

| 文件 | 平台 | 版本 | 来源 |
| --- | --- | --- | --- |
| `../../UnRAR.exe` | Windows（x86，兼容 x64） | 7.30 beta 1 | rarlab |
| `linux/x64/unrar` | Linux x64 | 7.23 | https://www.rarlab.com/rar/rarlinux-x64-723.tar.gz |
| `mac/arm64/unrar` | macOS Apple Silicon | 7.23 | https://www.rarlab.com/rar/rarmacos-arm-723.tar.gz |
| `mac/x64/unrar` | macOS Intel | 7.12（Intel 已停止新版分发） | https://www.rarlab.com/rar/rarmacos-x64-712.tar.gz |

注意事项：

- Linux/macOS 二进制入库时用 `git update-index --chmod=+x` 保留可执行位——
  CI 在 Linux 检出构建 AppImage/deb 时依赖它。
- 升级换版本时从对应 tar.gz 解包 `rar/unrar` 覆盖，勿改动文件名。
- 许可见 `license.txt`（unRAR 许可：可免费使用与分发，仅限解压用途）。
