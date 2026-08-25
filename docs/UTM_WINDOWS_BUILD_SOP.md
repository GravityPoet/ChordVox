# UTM Windows 打包 / 验证 SOP

流程最后验证：2026-08-17。VM 内源码、依赖和脚本属于易失缓存，不能据此日期假定仍是最新版。

> 硬规则：GitHub Actions 可用时，Windows 客户安装包必须来自 `windows-latest` runner；GitHub Actions 不可用时，Windows 客户安装包必须来自 UTM 真 Windows。VPS Linux + Docker/Wine 禁止作为 Windows 客户安装包来源。

适用场景：

- GitHub Actions 不可用，但需要补 Windows 客户安装包
- 需要真实 Windows 桌面环境验证安装包能启动
- 用户明确要求用 Windows 原生环境打包
- 已安装并启动 UTM 的 Windows 虚拟机

目标：

- 在真实 Windows 环境生成 Windows NSIS + portable 安装包
- 验证 Windows 安装包内 native module 是 Windows 版本
- 验证 Windows 安装包在真实 Windows 环境可运行
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
- guest 自带的 `npm 10.9.4` 可能对当前 lockfile 误报“不同步”
  - 优先用 `npx.cmd -y npm@11.9.0 ci --ignore-scripts --no-audit --no-fund`
- `--ignore-scripts` 会跳过 `ffmpeg-static` 的 postinstall
  - 必须随后执行 `node node_modules\ffmpeg-static\install.js`
  - 继续打包前必须确认 `node_modules\ffmpeg-static\ffmpeg.exe` 存在
- 如果 `electron-builder` 卡在 `usocket` / `Could not find any Visual Studio installation to use`
  - 直接删除 `node_modules\\dbus-next` 和 `node_modules\\usocket`
- 如果 `electron-builder` 卡在 `elevate.exe` 丢失
  - 先删 `C:\\WINDOWS\\SystemTemp\\electron-builder-cache\\nsis`，再重跑让它重新下载完整 NSIS cache
- 正式公开发布需要同时有 installer 和 portable：
  - `ChordVox-Setup-<VERSION>.exe`
  - `ChordVox-<VERSION>.exe`
- Windows 客户包发布前必须拆包验证：
  - `better_sqlite3.node` 必须是 `PE32+ executable (DLL) x86-64, for MS Windows`
  - `node_modules/ffmpeg-static/ffmpeg.exe` 必须存在，且必须是 Windows PE/MZ 文件
  - `resources\bin` 只能包含 Windows `.exe` / `.dll` 和 `node-runtime\win32-x64`
  - 包内不得出现 `sherpa-onnx-linux-x64`、Linux `ffmpeg-static/ffmpeg`、Linux `.so` native 运行物
  - 包内不得出现 Darwin / macOS `.dylib`、`darwin-*`、`macos-*` 运行物

## 2. 本机准备

在私有仓本机目录：

```bash
cd $HOME/Tools/ChordVox-IME/ChordVox-Pro
```

确认 UTM 虚拟机已启动：

```bash
utmctl list
```

应能看到：

- `Windows` 状态为 `started`

### 2.1 `utmctl` 输出规则

`utmctl exec` 在这台机器上可能出现“命令执行了、exit code 也是 0、但 stdout 没有回显”的情况。不要把“没有输出”误判成命令没跑。

在这台机器上，优先用 Windows 程序绝对路径调用 `cmd.exe`，避免 shell 字符串被 `utmctl exec` 当成错误的参数数组：

```bash
utmctl exec Windows --cmd 'C:\Windows\System32\cmd.exe' /c 'echo UTM_OK> C:\Users\Public\utm-probe.txt'
utmctl file pull Windows 'C:\Users\Public\utm-probe.txt'
```

关键命令必须写入 guest 文件，再 pull 回宿主机核对：

```bat
cmd.exe /c where node > C:\Users\Public\probe.txt 2>&1
```

如果日志文件正被构建进程占用，`utmctl file pull` 可能失败。先在 guest 里复制快照，再 pull：

```bat
copy /Y C:\Users\Public\win-build.log C:\Users\Public\win-build-snapshot.log
```

`utmctl file pull` 在这里是把 guest 文件输出到 stdout；宿主机需要保存时用重定向：

```bash
utmctl file pull Windows 'C:\Users\Public\win-build-snapshot.log' > /tmp/win-build-snapshot.log
```

不要直接依赖 PowerShell inline 脚本。实测用 `.cmd` 批处理更稳，尤其是 `npm warn` 进入 stderr 时，PowerShell 容易被误判成异常；`.cmd` 以退出码为准。

2026-05-07 实战补充：不要把清理、切目录、复制资源、构建这些动作塞进一条 `utmctl exec ... cmd.exe /c "if exist ... && ..."` 或 inline PowerShell。最稳路径是先把 wrapper `.cmd` 放在 guest 固定路径，再只执行这一句：

```bash
utmctl exec Windows --cmd 'C:\Windows\System32\cmd.exe' /c 'C:\Users\Public\chordvox-next-windows-build.cmd'
```

wrapper 必须把以下证据写入日志，宿主机再 pull 日志判断真实状态：

- `CODEX_RUN_START`
- 当前源码目录和 source SHA
- `where node` / `where npm` / `where npx`
- `npm run verify:win:package` 的输出
- `CODEX_RUN_EXIT=<exit code>`

### 2.2 Guest Agent、交互桌面和完成标记

- Windows Update 期间 UTM Guest Agent 可能暂时不可用。先查看 VM 画面并在有界时间内重试；不要因为一次连接失败就强制重启 Windows、重装 Guest Tools 或重跑整轮构建。
- `utmctl exec` 返回 0 只代表远程调用已受理，不代表长命令、GUI 安装器或测试已完成。每个动作都要写独立的 `*.done`、真实退出码和日志，再轮询这些文件的新时间戳。
- 长 inline `cmd` / PowerShell 容易被多层引号拆坏。把脚本推入 guest 后执行固定 `.cmd`；需要 PowerShell 时由 `.cmd` 调用 `.ps1`。
- 需要在登录用户桌面启动 Electron/NSIS 时，使用 `InteractiveToken` 临时计划任务。计划任务 XML 使用 UTF-16LE BOM；UTF-8、无 BOM 或大端 UTF-16 在该 guest 中可能被 `schtasks` 拒绝。
- GUI `.exe` 可能派生子进程后让外层批处理提前返回。安装/便携版启动的完成条件必须轮询安装目录、卸载注册表、真实产品进程和 CDP 端口；不能把计划任务或 `start` 的退出码当成安装完成。
- 临时计划任务、脚本、隔离 profile、模型和测试包都要使用本轮唯一前缀。验收结束后只清理这组精确路径，并再次确认正常用户安装路径、快捷方式和注册表没有被碰触。

## 3. 本机先下载 Windows 运行二进制

先在 Mac 本机下载 Windows 版运行二进制，避免 guest 内部下载失败：

```bash
node scripts/download-whisper-cpp.js --current --platform win32 --arch x64
node scripts/download-llama-server.js --current --platform win32 --arch x64
node scripts/download-sherpa-onnx.js --current --platform win32 --arch x64
node scripts/download-nircmd.js --all
```

`download-whisper-cpp.js` 默认从 `GravityPoet/ChordVox` 的 `whisper-server-v0.0.6` runtime release 下载 `whisper-server` 资产。

另外两个预编译小工具建议直接从 GitHub release 拉：

- `windows-fast-paste.exe`
- `windows-key-listener.exe`

默认下载顺序已经调整为：

1. `GravityPoet/ChordVox`
2. `GravityPoet/ChordVox-Pro`

说明：

- 公开发布链应优先以 `GravityPoet/ChordVox` 为准
- helper 下载脚本现在默认按精确 release tag 直查，不再依赖 GitHub 公开 release 列表扫描
- 如果后续发布新的 helper 版本，要同步更新脚本里的默认 release tag，或在构建环境里显式设置 `WINDOWS_KEY_LISTENER_VERSION` / `WINDOWS_FAST_PASTE_VERSION`
- 旧上游二进制 fallback 已从默认下载链移除
- 只有显式设置 `CHORDVOX_ALLOW_LEGACY_WINDOWS_BIN_FALLBACK=1` 时，才允许临时回退到旧上游二进制发布源
- 一旦脚本命中该遗留回退，应尽快把缺失资产补传到 `GravityPoet/ChordVox` 或 `GravityPoet/ChordVox-Pro`

**硬规则**：

如果源码是通过 `git archive` 推给 Windows guest，`resources/bin` 不会自动进去，因为该目录是 ignored / untracked 运行二进制。必须单独打包并推入 guest 源码根目录：

```bash
zip -qr /tmp/chordvox-resources-bin.zip resources/bin
utmctl file push Windows 'C:\Users\Public\chordvox-resources-bin.zip' < /tmp/chordvox-resources-bin.zip
```

guest 内解压到源码根目录后，必须能看到：

```txt
resources\bin\windows-key-listener.exe
resources\bin\windows-fast-paste.exe
resources\bin\nircmd.exe
```

## 4. Windows guest 里的关键前置

### 4.1 Node

Windows guest 里默认可能没有 `node` / `npm`。

建议安装便携版 Node 22。已知可用路径是：

- `node-v22.19.0-win-x64.zip`
- 解压目录：`C:\NodePortable\node-v22.19.0-win-x64`

安装后要确保构建命令里把它加进 PATH：

```bat
set PATH=C:\NodePortable\node-v22.19.0-win-x64;%PATH%
```

如果 `where node` / `where npm` 为空，不要继续跑构建。先从 Mac 下载官方 Node zip，推入 guest 后解压到 `C:\NodePortable`，再把上面的 PATH 写进构建脚本。

### 4.2 构建目录

不要在 `C:\\Windows\\System32` 里最终出包。

推荐目录：

```txt
C:\ChordVoxBuild\ChordVox-Pro
```

标准构建目录是 `C:\ChordVoxBuild\ChordVox-Pro`。如果正式发版目标源码变了，必须先重新推入目标源码；不要直接用旧目录出新版本包。

### 4.2.1 缓存环境和一键入口的复用门槛

UTM `Windows` guest 可能保留下列缓存路径：

- 源码目录：`C:\ChordVoxBuild\ChordVox-Pro`
- portable Node：`C:\NodePortable\node-v22.19.0-win-x64`
- 下次手动构建入口：`C:\Users\Public\chordvox-next-windows-build.cmd`
- 构建日志：`C:\Users\Public\chordvox-next-windows-build.log`

不要因为路径存在就直接触发。先 pull 脚本并核对其中的 `SOURCE_SHA`/`VERSION`，再核对源码目录的 `SOURCE_SHA.txt` 和 `package.json`；三处必须与本次目标一致。通过后才触发：

```bash
utmctl exec Windows --cmd 'C:\Windows\System32\cmd.exe' /c 'C:\Users\Public\chordvox-next-windows-build.cmd'
```

构建脚本内部只做：

```bat
set PATH=C:\NodePortable\node-v22.19.0-win-x64;%PATH%
cd /d C:\ChordVoxBuild\ChordVox-Pro
call npm.cmd run build:renderer
call node_modules\.bin\electron-builder.cmd --win --x64 --publish never --config.extraMetadata.version=<package.json version>
node scripts\verify-mac-package.js --platform win
```

它不会跑 `npm run build:win`，也不会重新下载多平台 runtime。它会在构建前再次移除：

```txt
node_modules\@sentry-internal\node-cpu-profiler
node_modules\@sentry\profiling-node
node_modules\dbus-next
node_modules\usocket
```

以下是每轮都要重新验证的状态，不是持久事实：

- `node -v` -> `v22.19.0`
- `npx.cmd -y npm@11.9.0 -v` -> `11.9.0`
- `node_modules` 已存在
- `node_modules\.bin\electron-builder.cmd` 已存在
- Windows helper 已存在：`windows-key-listener.exe`、`windows-fast-paste.exe`、`nircmd.exe`
- `resources\bin` 未发现 `.so`、`linux`、`darwin`、`.dylib`
- C 盘剩余空间约 16.8GB

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

### 4.4 `npm ci` 误报 lockfile 不同步

如果在 guest 里直接跑 `npm ci`，报出类似：

```txt
package-lock.json is out of date
missing: better-sqlite3 / pg / pg-pool / pg-protocol
```

而你确认当前源码就是主线最新提交，不要手改 `package-lock.json`。

优先改用：

```bat
npx.cmd -y npm@11.9.0 ci --ignore-scripts --no-audit --no-fund
```

说明：

- 这是 guest 环境里 `npm 10.9.4` 的兼容性问题，不是这次发版内容真的缺依赖
- `--ignore-scripts` 是为了避免刚安装完就触发 native rebuild，把问题前置到可控步骤里

### 4.5 `dbus-next/usocket` 是 Linux-only 坑

如果 `electron-builder` 的 `install-app-deps` 阶段卡在：

```txt
node-gyp failed to rebuild ...\\node_modules\\usocket
Could not find any Visual Studio installation to use
```

本次成功路径里，直接删除 guest 构建目录中的：

```bat
rmdir /s /q node_modules\dbus-next
rmdir /s /q node_modules\usocket
```

说明：

- `dbus-next` 是 Linux GNOME / D-Bus 热键链路依赖
- Windows 打包不需要它
- 删掉这组依赖后，`better-sqlite3` 仍可正常重建，Windows 包能继续出

### 4.6 NSIS cache 损坏

如果已经走到：

```txt
building target=nsis
```

但随后报：

```txt
ENOENT: no such file or directory, copyfile ...\\electron-builder-cache\\nsis\\...\\elevate.exe
```

说明 guest 里的 NSIS cache 是半截的。

修复方式：

```bat
rmdir /s /q C:\WINDOWS\SystemTemp\electron-builder-cache\nsis
```

然后直接重跑：

```bat
.\node_modules\.bin\electron-builder.cmd --win --x64 --publish never --config.extraMetadata.version=<VERSION>
```

它会重新下载：

- `nsis-3.0.4.1.7z`
- `nsis-resources-3.4.1.7z`

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
call npx.cmd -y npm@11.9.0 ci --ignore-scripts --no-audit --no-fund
node node_modules\ffmpeg-static\install.js
if not exist node_modules\ffmpeg-static\ffmpeg.exe exit /b 41
rmdir /s /q node_modules\@sentry-internal\node-cpu-profiler
rmdir /s /q node_modules\@sentry\profiling-node
rmdir /s /q node_modules\dbus-next
rmdir /s /q node_modules\usocket
call npm.cmd run build:renderer
call .\node_modules\.bin\electron-builder.cmd --win --x64 --publish never --config.extraMetadata.version=<VERSION>
node scripts\verify-mac-package.js --platform win
```

只有脚本、`SOURCE_SHA.txt`、`package.json`、Windows helper 和依赖均已重新验证，且都匹配本次目标时，才可以跳过重新铺设并直接执行：

```bash
utmctl exec Windows --cmd 'C:\Windows\System32\cmd.exe' /c 'C:\Users\Public\chordvox-next-windows-build.cmd'
```

关键点：

- 让 `electron-builder.json` 的 `win.target=["nsis","portable"]` 自己出完整产物
- `verify-mac-package.js --platform win` 从 `v1.5.103` 起已可直接在 Windows guest 跑
- 不走 `npm run build:win`
- 这一步会校验安装包内是否包含：
  - `resources/bin/windows-key-listener.exe`
  - `resources/bin/windows-fast-paste.exe`
  - `resources/bin/nircmd.exe`
- `.bat` 里调用 `.cmd` 文件必须加 `call`，否则批处理可能在第一条 `npm.cmd` / `npx.cmd` 后中断，不再执行后续 verify / 产物整理。

## 6. 成功产物

Windows guest 最终应至少出现：

```txt
dist\ChordVox Setup <VERSION>.exe
dist\ChordVox Setup <VERSION>.exe.blockmap
dist\ChordVox <VERSION>.exe
dist\latest.yml
dist\win-unpacked\ChordVox.exe
```

## 7. 发布前 native module 验收

在上传 Windows 资产前，必须从 `portable` 或 `Setup` 包中拆出 `better_sqlite3.node` 并确认它是 Windows PE DLL。
优先验 `portable` 包 `ChordVox-<VERSION>.exe`；如果只临时拿得到 installer，再验 `ChordVox-Setup-<VERSION>.exe`。

在 macOS 宿主机执行：

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
ARTIFACTS_DIR="/path/to/utm/windows/dist"
ARTIFACT="$ARTIFACTS_DIR/ChordVox-${VERSION}.exe"
SEVEN_Z="node_modules/7zip-bin/mac/arm64/7za"
EXTRACT_DIR="/tmp/chordvox-win-native-check-${VERSION}"

cd $HOME/Tools/ChordVox-IME/ChordVox-Pro
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"

"$SEVEN_Z" e -y "$ARTIFACT" \
  "resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
  -o"$EXTRACT_DIR" >/dev/null

file "$EXTRACT_DIR/better_sqlite3.node" | grep -F "PE32+ executable (DLL)" >/dev/null

if "$SEVEN_Z" l "$ARTIFACT" | rg 'sherpa-onnx-linux-x64|ffmpeg-static/ffmpeg$|\.so(\s|$)'; then
  echo "Linux runtime files found in Windows package" >&2
  exit 1
fi
```

验收通过时，`file` 输出必须包含：

```txt
PE32+ executable (DLL) (GUI) x86-64, for MS Windows
```

如果输出是 `ELF 64-bit LSB shared object`，这是 Linux native module，必须丢弃本次 Windows 包并在 UTM 真 Windows 中重打。

### 7.1 公开安装包的 Windows 运行验收

静态拆包通过后，还要在 guest 内对公开下载对象做一轮真实客户路径验收：

1. 由 Windows guest 直接从公开 Release 下载 installer、portable、blockmap、`latest.yml` 和 manifest，并逐项比对公开 API 的字节数与 SHA256。
2. 记录安装前基线：ChordVox 进程、CDP 端口、卸载注册表、桌面/开始菜单快捷方式、自动启动项和正常用户数据目录。
3. installer 使用隔离安装目录与 `--user-data-dir` 启动；验证版本、进程稳定性、设置页 `panel=true`、英文默认 UI、可访问性树、音频设备枚举、FFmpeg、Parakeet、F8 注册、Windows `SendInput` 粘贴能力、退出确认和静默卸载。
4. portable 使用另一隔离 profile 与 `MODEL_STORAGE_ROOT`；验证不创建安装注册表、快捷方式或自动启动项，并覆盖模型下载、校验、解压和本地推理。
5. 固定 WAV 可验证“公开包 native sidecar + 公开模型 + WebSocket 协议 + 推理”的确定性链路；它不能替代真实麦克风、物理 F8 和第三方桌面应用粘贴的人工门禁。没有做真麦克风时必须明确写未覆盖，不能宣称零 Bug。
6. 退出后要求产品进程、portable 外壳、CDP 端口、sidecar、计划任务、随机解压目录和隔离 profile 全部归零；再与安装前基线比对。

公开包还必须先通过签名与自动化 native gate；不要只在资源管理器里目测 Publisher：

```powershell
$env:WIN_CSC_LINK = '<PFX path or electron-builder base64 value>'
$env:WIN_CSC_KEY_PASSWORD = '<PFX password>'
$env:WINDOWS_PUBLISHER_NAME = 'ChordVox Local Code Signing'

npm run build:win
npm run download:release-dictation-model
$env:CHORDVOX_PACKAGED_APP_EXECUTABLE = (Resolve-Path 'dist\win-unpacked\ChordVox.exe').ProviderPath
$env:CHORDVOX_PACKAGED_DICTATION_WHISPER_MODEL = (Resolve-Path '.cache\release-dictation-model\ggml-tiny.bin').ProviderPath
$env:CHORDVOX_PACKAGED_EXPECTED_PLATFORM = 'win32'
$env:CHORDVOX_PACKAGED_EVIDENCE_PATH = (Join-Path $PWD 'dist\native-runtime-evidence-windows.json')
npm run verify:packaged:dictation
```

必须保留并回收到宿主机：

- `windows-authenticode-evidence.json`
- `native-runtime-evidence-windows.json`

`scripts/publish-utm-windows-release.sh` 会按当前 installer/portable 的 SHA256 反查 Authenticode 证据，并要求发布者、同一签名证书、时间戳、固定 WAV、打包版受信任点击与独立进程粘贴全部匹配同一个 `source_sha`；任一缺失都拒绝上传。

Windows 固定自签身份的公钥证书是 `resources\windows\chordvox-local-code-signing.cer`。UTM/CI 隔离验收机需将它导入本机 `Root`（仅为验证自签根）并保留当前用户 `TrustedPeople` 记录，使 `Get-AuthenticodeSignature` 能验证完整链路；这些信任变更只存在于临时验收机，客户安装器不得静默导入此证书。私钥 PFX 和密码只保存在受限备份与 GitHub Secrets，不进入源码、构建日志或发布资产。

Windows ARM guest 运行 x64 包属于兼容层验收，不是 Intel/AMD 原生性能证明。x64 Node/Electron 在该环境中可能报告 `process.arch=x64` 和 `PROCESSOR_ARCHITECTURE=AMD64`，但 `PROCESSOR_IDENTIFIER` 仍包含 `ARMv8`。Parakeet sidecar 在 4 GB ARM UTM 中可正常推理，但完整应用并行冷启动可能超过原生 x64 的 60 秒门槛；Windows ARM 环境必须使用扩展后的启动时间门槛并以固定 WAV 真推理作为通过信号。

从 macOS 拆 Windows 包时，Git checkout 的 `LICENSE` / `NOTICE` 可能是 LF，而 Windows 构建复制品是 CRLF。包级 verifier 只允许对这两个法律文本归一化 CRLF/LF 后比较；正文、空格或其他字节差异仍必须失败。不要手工改包内法律文件来绕过校验。

## 8. 上传前必须做的修正

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

脚本会按 `latest.yml` 自动对齐 staging 目录里的 installer / blockmap 文件名，
并把 portable 统一整理成：

- `ChordVox-<VERSION>.exe`

如果你不用脚本手工上传，仍然必须自己改名：

- `ChordVox Setup <VERSION>.exe`
  ->
  `ChordVox-Setup-<VERSION>.exe`
- `ChordVox Setup <VERSION>.exe.blockmap`
  ->
  `ChordVox-Setup-<VERSION>.exe.blockmap`
- `ChordVox <VERSION>.exe`
  ->
  `ChordVox-<VERSION>.exe`

否则：

- `latest.yml` 的下载路径和 release 资产名对不上
- Windows 自动更新会坏

另外，`utmctl file pull` 拉大文件时不会稳定显示进度，必须用宿主机文件大小判断是否仍在增长：

```bash
stat -f '%N %z' /tmp/chordvox-release-windows/dist/*
ps -axo pid,ppid,stat,etime,command | rg 'utmctl file pull'
```

只有本地大小与 guest 中记录的大小一致，并且 `utmctl file pull` 进程退出后，才允许改名、生成 manifest 或上传。

2026-06-26 实战补充：

- 不要把多个大文件 `utmctl file pull` 串在同一条命令里；一旦出现 `Port is not connected`，会留下 0 字节占位文件。
- 处理方式：先删除 0 字节占位文件，再一次只拉一个大文件，并用 `stat -f '%N %z bytes'` 轮询到完整大小。
- `latest.yml` / `.blockmap` 这类小文件可以先拉回；installer / portable 必须分别拉，目标大小以 guest `dir` 和 `latest.yml` 为准。
- UTM 的 `Z:\` WebDAV 共享在这台机器上可能只能创建 0 字节文件或中途停住；不能把共享目录文件当成成功回收证据，必须核对宿主机实际字节数。

## 9. 公开 release 要上传什么

至少上传：

- `ChordVox-<VERSION>.exe`
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

cd $HOME/Tools/ChordVox-IME/ChordVox-Pro
scripts/publish-utm-windows-release.sh \
  "$VERSION" \
  "$SOURCE_SHA" \
  "$ARTIFACTS_DIR" \
  "GravityPoet/ChordVox"
```

这个脚本会自动完成：

- 读取 `latest.yml`
- 对齐 installer / portable / blockmap 文件名
- 生成 `release-manifest-windows.json`
- 上传到指定 GitHub release

## 10. 本次实战里踩到的坑

- Mac 宿主机直打 Windows：失败
- VPS Linux + Docker/Wine 产出的 Windows `.exe` 可能混入 Linux native module：禁止作为客户 Windows 包来源
- Windows `.exe` 外壳正确不等于内部 native module 正确：必须拆包验 `better_sqlite3.node`
- Windows guest 缺 `node`：需要补装
- `utmctl exec` 可能没有 stdout：关键命令必须写日志文件再 pull
- `utmctl exec` 返回 0 但结果文件尚未出现：轮询带新时间戳的 `*.done` 和真实退出码，不能把远程受理当完成
- Windows Update 期间 Guest Agent 可能短时断开：先看 VM 画面并等待更新恢复，不强制重启或重装工具
- 交互 GUI 计划任务 XML 必须使用 UTF-16LE BOM；动作脚本放到固定 `.cmd`，结束后删除计划任务
- NSIS/portable 外层调用可能提前返回：必须以安装目录、卸载注册表、产品进程和 CDP 端口联合裁决
- 日志被占用时 pull 失败：先在 guest 复制 snapshot 日志再 pull
- `npm 10.9.4` 会误报 lockfile 不同步：要固定用 `npm@11.9.0`
- `.bat` 里调用 `npm.cmd` / `npx.cmd` / `electron-builder.cmd` 必须用 `call`
- `npm run build:win` 会在 guest 里乱拉依赖：不稳定
- `git archive` 不会带 `resources/bin`：Windows helper 必须单独推入 guest
- `@sentry-internal/node-cpu-profiler` 会触发 Python/node-gyp：需要绕过
- `dbus-next/usocket` 会触发 Visual Studio/node-gyp：需要绕过
- NSIS cache 可能半截：缺 `elevate.exe` 时删 cache 重下
- 在 `System32` 目录下做 NSIS：容易出奇怪路径问题
- Windows 安装包文件名和 `latest.yml` 可能不一致：上传时必须走自动对齐脚本或手工改名
- `utmctl file pull` 拉大文件很慢，最好先在 guest 里整理一个干净 export 目录，再从宿主机统一回收
- `utmctl exec Windows --cmd powershell.exe ...` / inline PowerShell 在本机容易无日志或被 stderr warning 误判；优先推 `.cmd` 文件到 guest 后用 `C:\Windows\System32\cmd.exe /c <script.cmd>` 执行。
- 不要临时拼一条很长的 `cmd /c` 做清理 + 构建；如果 stdout 为空或参数被拆错，会浪费整轮排查时间。统一维护 `C:\Users\Public\chordvox-next-windows-build.cmd`，每次只更新脚本内容和 source SHA 检查。
- portable Node 的 `npx.cmd` 必须在 `PATH` 里能找到同目录 `node.exe`；如果直接全路径调用 `npx.cmd` 而没设置 PATH，可能报 `'node' 不是内部或外部命令`。
- 自定义 NSIS include 的 `customUnInstallCheck` / `customUnInstallCheckCurrentUser` 不能引用 electron-builder 模板内部的 `$installationDir`。该变量在另一个模板函数里声明，宏展开位置更早时会触发 `warning 6000: unknown variable/constant "installationDir"`，并被 `makensis` 当成 error。清理旧安装目录里的 `resources\app.asar.unpacked` / `resources\app.asar` 时使用 NSIS 内置 `$INSTDIR`，改完必须重新跑 UTM NSIS 构建和 `node scripts\verify-mac-package.js --platform win`。
- electron-builder 可能在日志中输出 `collector stderr output` / `npm error ELSPROBLEMS` 这类依赖诊断噪声；不要只凭这段判定构建失败。
  - 裁决顺序：看最终退出码、`node scripts\verify-mac-package.js --platform win` 输出、`win package verification passed`、`BUILD_SUCCESS`。
  - 如果最终 verifier 通过，且宿主机拆包确认 `better_sqlite3.node` 是 Windows PE DLL、无 Linux runtime 污染，这类 collector 噪声可作为非阻塞记录。
- 拉回 Windows 产物时必须同时保留 installer、portable、blockmap、`latest.yml`；只拿 installer 会破坏正式公开发版要求。
- 如果 verifier 报 `Missing Windows ffmpeg-static binary ... ffmpeg.exe`，本轮 Windows 包必须熔断。根因通常是 UTM 脚本用了 `npm ci --ignore-scripts` 但没有补跑 `node node_modules\ffmpeg-static\install.js`。补跑 install 后要清理 `dist`、重新执行 `electron-builder --win` 和 verifier；不能把已经缺 `ffmpeg.exe` 的包上传。
- macOS 对 Windows 拆包校验法律文本时，CRLF/LF 差异不是正文变化；verifier 应归一化换行后比较，但仍须拒绝任何实质内容差异。
- Windows ARM UTM 中 x64 Parakeet sidecar 能运行并完成固定 WAV 推理，但完整 Electron 应用会增加冷启动开销。若日志只有解析参数、随后在 60000ms 被终止，先独立证明 sidecar 最终 `Listening on` 与真推理，再检查 ARM 专用启动门槛；不要把静态 `working: true` 当作运行成功。

## 11. 当前结论

在 UTM Win11 中：

- 可以成功做 Windows 打包
- 但前提是：
  - Node 已装
  - Windows 运行二进制已补齐
  - 固定 `npm@11.9.0`
  - 避开 `npm run build:win`
  - 避开 `System32` 作为最终构建目录
  - 必要时移除 `profiler` / `dbus-next` / `usocket`
  - 必要时清空损坏的 NSIS cache
  - 上传时走 `scripts/publish-utm-windows-release.sh`
