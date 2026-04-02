# UTM Windows 打包 SOP

最后验证：2026-03-23

适用场景：
- GitHub Actions Windows runner 不可用
- 本机 Apple Silicon Mac 不能直接交叉打 Windows
- 已安装并启动 UTM 的 Windows 虚拟机

目标：
- 生成 Windows NSIS 安装包
- 用正式脚本上传最新版安装包到 GitHub release

## 1. 先记住这几个结论

- 不要在 macOS 宿主机直接跑 `npm run build:win`
  - 会卡在 `node-gyp does not support cross-compiling native modules from source`
- 不要在 Windows guest 的 `C:\\Windows\\System32` 下面直接做最终 NSIS 构建
  - 会踩 NSIS include / 路径重定向类问题
- 不要直接跑 `npm run build:win`
  - `prebuild:win` 会在 guest 里下载多平台依赖，容易卡 TLS / 网络
- 用 Windows guest 时，推荐拆成：
  - 先在 Mac 本机下载 Windows 需要的二进制
  - 再推到 guest
  - 最后只跑 `build:renderer + electron-builder --win`

## 2. 本机准备

在私有仓本机目录：

```bash
cd /Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro
```

确认 UTM 虚拟机已启动：

```bash
utmctl list
```

应能看到：
- `Windows` 状态为 `started`

## 3. 本机先下载 Windows 运行二进制

先在 Mac 本机下载 Windows 版运行二进制，避免 guest 内部下载失败：

```bash
node scripts/download-whisper-cpp.js --current --platform win32 --arch x64
node scripts/download-llama-server.js --current --platform win32 --arch x64
node scripts/download-sherpa-onnx.js --current --platform win32 --arch x64
node scripts/download-nircmd.js --all
```

另外两个预编译小工具建议直接从 GitHub release 拉：
- `windows-fast-paste.exe`
- `windows-key-listener.exe`

## 4. Windows guest 里的关键前置

### 4.1 Node

Windows guest 里默认可能没有 `node` / `npm`。

建议安装便携版 Node 22：
- `node-v22.22.0-win-x64.zip`

安装后要确保构建命令里把它加进 PATH：

```bat
set PATH=C:\Windows\System32\node\node-v22.22.0-win-x64;%PATH%
```

### 4.2 构建目录

不要在 `C:\\Windows\\System32` 里最终出包。

推荐目录：

```txt
C:\ChordVoxBuild-<version>\ChordVox-Pro
```

### 4.3 Sentry profiler

如果直接跑 `electron-builder` 卡在：

```txt
@sentry-internal/node-cpu-profiler
Could not find any Python installation to use
```

说明 Windows guest 缺 Python / node-gyp 构建链。

本次成功路径里，采用了“在 guest 构建目录里移除 profiler 模块”绕过：

```bat
rmdir /s /q node_modules\@sentry-internal\node-cpu-profiler
rmdir /s /q node_modules\@sentry\profiling-node
```

说明：
- 这是为了打包绕过 Windows 的 node-gyp/Python 坑
- 不是长期最优方案
- 但这次确实能让 Windows 打包继续走下去

## 5. 正式构建顺序

推荐顺序：

1. 把目标源码提交打成 tar/zip，从 Mac 推给 Windows guest
2. 在 guest 的普通目录解压源码
3. 把 Windows 二进制包解到：

```txt
resources\bin
```

4. 在 guest 里执行：

```bat
npm ci
npm run build:renderer
.\node_modules\.bin\electron-builder.cmd --win nsis --x64 --publish never --config.extraMetadata.version=<VERSION>
```

关键点：
- 只打 `nsis`
- 不打 `portable`
- 不走 `npm run build:win`

## 6. 成功产物

Windows guest 最终应至少出现：

```txt
dist\ChordVox Setup <VERSION>.exe
dist\ChordVox Setup <VERSION>.exe.blockmap
dist\latest.yml
```

## 7. 上传前必须做的修正

`latest.yml` 里写的安装包名可能是带连字符的：

```txt
ChordVox-Setup-<VERSION>.exe
```

但 Windows guest 实际产物文件名可能是带空格的：

```txt
ChordVox Setup <VERSION>.exe
```

发布前必须确保对齐文件名。
如果你走：

```bash
scripts/publish-utm-windows-release.sh
```

脚本会按 `latest.yml` 自动对齐 staging 目录里的 installer / blockmap 文件名；
如果你不用脚本手工上传，仍然必须自己改名：

- `ChordVox Setup <VERSION>.exe`
  ->
  `ChordVox-Setup-<VERSION>.exe`
- `ChordVox Setup <VERSION>.exe.blockmap`
  ->
  `ChordVox-Setup-<VERSION>.exe.blockmap`

否则：
- `latest.yml` 的下载路径和 release 资产名对不上
- Windows 自动更新会坏

## 8. 公开 release 要上传什么

至少上传：

- `ChordVox-Setup-<VERSION>.exe`
- `ChordVox-Setup-<VERSION>.exe.blockmap`
- `latest.yml`
- `release-manifest-windows.json`

推荐不要手工一个个上传，直接在 macOS 宿主机用正式脚本：

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
SOURCE_SHA="<Pro源SHA>"
ARTIFACTS_DIR="/path/to/utm/windows/dist"

cd /Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro
scripts/publish-utm-windows-release.sh \
  "$VERSION" \
  "$SOURCE_SHA" \
  "$ARTIFACTS_DIR" \
  "GravityPoet/ChordVox"
```

这个脚本会自动完成：
- 读取 `latest.yml`
- 对齐 installer / blockmap 文件名
- 生成 `release-manifest-windows.json`
- 上传到指定 GitHub release

## 9. 本次实战里踩到的坑

- Mac 宿主机直打 Windows：失败
- Windows guest 缺 `node`：需要补装
- `npm run build:win` 会在 guest 里乱拉依赖：不稳定
- `@sentry-internal/node-cpu-profiler` 会触发 Python/node-gyp：需要绕过
- 在 `System32` 目录下做 NSIS：容易出奇怪路径问题
- Windows 安装包文件名和 `latest.yml` 可能不一致：上传时必须走自动对齐脚本或手工改名

## 10. 当前结论

在 UTM Win11 中：

- 可以成功做 Windows 打包
- 但前提是：
  - Node 已装
  - Windows 运行二进制已补齐
  - 避开 `npm run build:win`
  - 避开 `System32` 作为最终构建目录
  - 上传时走 `scripts/publish-utm-windows-release.sh`
