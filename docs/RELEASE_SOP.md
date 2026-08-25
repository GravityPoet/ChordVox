# ChordVox 正确发版 SOP（Pro -> Public）

本文档是闭源 `ChordVox-Pro` 向公开下载仓 `GravityPoet/ChordVox` 的唯一发版流程。
公开仓自动发布已关闭，发布入口统一在私有仓 GitHub Actions workflow。

> **单一规则源：** 发版判断、渠道选择、回退、失败记录和发布验收只维护在本文件。
> 禁止再创建 `docs/release-sop.md`、`docs/RELEASE_PROCESS.md` 或其他平行摘要；需要补规则时直接修改本文件。

### 文档路由（按需读取，不要全量重复读取）

- 所有公开发版：先读本文件；本文件已经包含完整主流程、fallback 和失败记录。
- 仅在实际构建或排查 macOS 包时，再读 [`MAC_PACKAGING_SOP.md`](MAC_PACKAGING_SOP.md)。
- 仅在 Actions Windows 不可用、必须进入 UTM 时，再读 [`UTM_WINDOWS_BUILD_SOP.md`](UTM_WINDOWS_BUILD_SOP.md)。
- 仅在起草公开文案时，使用 [`RELEASE_NOTES_TEMPLATE.md`](RELEASE_NOTES_TEMPLATE.md)；模板不是发布流程。
- [`COMMERCIAL_RELEASE.md`](COMMERCIAL_RELEASE.md) 只维护授权/售卖后端信息，不再承载发版规则。

### 发布渠道边界

- **客户正式版：** 默认从 `main` 的 `.github/workflows/release.yml` 发布到公开仓；必须完成真实听写、目标平台包内运行物和公开资产验收。
- **分支构建验证：** `.github/workflows/build-and-notarize.yml` 只验证各平台能否打包，当前不会保留重复 Actions artifact，也不会创建公开 Release；除非用户明确指定该分支就是本次产品基线并要求交付包，否则不要把它当成下载渠道。
- **macOS 统一签名：** 本地测试版和客户正式版都必须使用固定的 `ChordVox Local Code Signing` 自签名身份，禁止退回 ad-hoc；交付前仍必须跑 `verify:icons`、`verify:mac:package` 和真实启动验收。
- **macOS 身份连续性：** 固定证书、`com.gravitypoet.chordvox` Bundle ID 与 `/Applications/ChordVox.app` 路径共同保持 TCC 身份连续。当前产品明确不购买 Apple Developer Program，因此客户包不做 Developer ID 签名或 Apple 公证；每台新 Mac 首次安装需要手动“仍要打开”，后续同证书更新通常不再重复触发辅助功能授权。
- **首次固定证书迁移：** 在首个使用当前固定证书的公开版本发布前，不得假设旧 ad-hoc / 其他证书版本可以自动跨越签名身份。Release notes 必须要求老客户手动下载 DMG、覆盖安装一次，并在 macOS 要求时重新启用一次辅助功能；从这个版本起，后续版本必须继续使用同一证书。客户不安装根证书。

## 0.0 统一发布规则（全部分支适用）

默认规则固定为：

1. 只要 GitHub Actions 可用，优先走 GitHub Actions。
2. `main` 口径的正式公开发版，只能走 `Release` workflow，再发布到公开 GitHub Release。
3. 非 `main` 分支只允许走 `Build and Verify` 这类预览构建流，产物应留在 GitHub Actions artifacts，不应伪装成正式公开 release。
4. 如果用户明确指定某个非 `main` 分支就是当前产品发布基线（例如 `codex/pill`），按该分支发布，但必须在本轮记录真实 `source_ref` 和 `source_sha`；不要因为“不是 main”中断发布。
5. 只要是“今天给客户的新交付”，默认必须发新版本号；禁止把今天新打的安装包继续补传到旧 tag / 旧 release 上，伪装成“今天的新版本”。
6. 只有用户明确说“就在旧 release 上补文件，不新发版本”时，才允许编辑旧 release 或向旧 tag 继续上传资产；否则一律按新版本处理。
7. 发三端安装包的统一环境规则：
   - GitHub Actions 可用：正式 `Release` workflow 发 macOS / Windows / Linux 三端，其中 Windows 必须来自 GitHub `windows-latest` runner。
   - GitHub Actions 不可用：本机打 macOS，VPS 只打 Linux，Windows 必须用 UTM 真 Windows 打包。
   - 如果同一 Release run 只有 macOS 因 ChordVox 自签名 Secret 缺失而失败，但 Windows / Linux job 已成功并上传 `release-windows-x64` / `release-linux-x64` artifact，可保留这两个真实目标 runner 产物；先从加密 P12 回滚件恢复同一身份，再在本机补 macOS 包并手工组装 draft。禁止生成新证书或用 ad-hoc 包冒充连续更新。
   - VPS Linux + Docker/Wine 禁止作为 Windows 客户安装包来源。
8. 公开 Release 的客户下载入口必须放在 release notes 顶部；不要依赖 GitHub `Assets` 折叠列表自然排序来暴露 macOS 安装包。
9. 不得为了让某个平台安装包“顶上来”随意删除 updater 元数据、blockmap、manifest 或其他平台安装包；只在确认确实冗余且不会影响下载/自动更新时才允许删除。
10. Windows 包发布前必须拆包验证 native runtime 平台：`better_sqlite3.node` 必须是 `PE32+ executable (DLL) x86-64, for MS Windows`，`node_modules/ffmpeg-static/ffmpeg.exe` 必须存在且是 Windows PE/MZ 文件，且 Windows 包中不得出现 `sherpa-onnx-linux-x64`、`ffmpeg-static/ffmpeg`、`.so` 等 Linux 运行物。
11. 所有运行在 `app.asar.unpacked` / 外部 Node runtime / 子进程 worker 里的模块，都必须验证完整 `require()` 依赖链已经随包解开；禁止只验证 worker 入口文件存在。尤其本地流式 worker 的链路 `sherpaStreamingWorker.js -> sherpaStreamingManager.js -> archiveSecurity.js -> tar` 必须在 `asarUnpack` 和 `scripts/verify-mac-package.js` 里同时覆盖。
12. 客户安装包必须在真实目标平台 runner / VM 上构建并验证包内运行物；禁止把交叉构建产物当作客户包来源。Windows 用 GitHub `windows-latest` 或 UTM 真 Windows，Linux 用 Linux runner / VPS，macOS 用 macOS runner / 本机。每个平台发布前都必须跑对应的 `npm run verify:<platform>:package` 或 `node scripts/verify-mac-package.js --platform <mac|win|linux>`，并保留日志证明包内没有混入外平台运行物。

## 0.1 手工补平台包分工（仅当 Actions 不可用）

如果本次不是完全依赖 GitHub Actions，而是要手工补平台包，平台分工固定为：

1. macOS：本机打包。
2. Linux：VPS 打包。
3. Windows：UTM 真 Windows 打包。

如果需要按顺序推进，优先把 Linux VPS 与 Windows UTM 拆成两条互不污染的构建线；macOS 本机包可并行或随后补齐。

原因：

- `v1.5.114` 到 `v1.5.116` 的公开 Windows 包曾出现 `better_sqlite3.node` 被打成 Linux `ELF` 的事故，外壳是 Windows `.exe`，内部 native module 却不是 Windows DLL。
- `builder:wine` 即使能生成 NSIS + portable，也不能作为 Windows native module 正确性的充分证明。
- Windows 客户包必须来自真实 Windows 环境：GitHub `windows-latest` 或 UTM Win11。
- macOS 仍由本机处理 DMG、固定自签名和真实启动验证
- Linux 仍由 VPS 处理，避免把 Linux native 产物混入 Windows 包。

### 0.1.1 三端打包命令与首次启动适配

三端安装包必须使用各自平台命令、各自产物和各自首次启动说明，禁止把 macOS 的 `Fix & Open.command` 写成 Windows / Linux 通用方案。

| 平台    | 构建环境                                             | 构建命令                                                                                  | 客户安装包                                                            | 首次启动说明                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | 本机 macOS；正式发版优先 GitHub Actions macOS runner | 测试包：`npm run build:mac:test`；正式包：`npm run build:mac:customer` / Release workflow | `ChordVox-<VERSION>-arm64.dmg`、`ChordVox-<VERSION>-arm64-mac.zip`    | 固定自签名、未 Apple 公证：打开 DMG，拖 `ChordVox.app` 到 `Applications`，再从 `Applications` 打开；每台新 Mac 首次安装到“系统设置 > 隐私与安全性 > 仍要打开”放行一次，仍打不开时再双击 DMG 右侧 `Fix & Open.command`。 |
| Windows | GitHub `windows-latest` 或 UTM 真 Windows            | `npm run prebuild:win && npm run build:win`                                               | `ChordVox-Setup-<VERSION>.exe`、`ChordVox-<VERSION>.exe`              | 不使用 `Fix & Open.command`。按 Windows 安装器流程安装；如被 SmartScreen / 杀软拦截，只给 Windows 专属说明。                                                                                                            |
| Linux   | Linux VPS / Linux runner                             | `npm run prebuild:linux && npm run build:linux`                                           | `ChordVox-<VERSION>-linux-x86_64.AppImage`、`.deb`、`.rpm`、`.tar.gz` | 不使用 `Fix & Open.command`。按 AppImage / deb / rpm / tar.gz 对应方式安装或运行。                                                                                                                                      |

发布说明、README、下载页和客服话术必须保持这个边界：

- `Fix & Open.command` 只出现在 macOS DMG、macOS First Launch、macOS 客服排障里。
- Windows / Linux 下载区不能出现 `Fix & Open.command`、`xattr`、`Gatekeeper`、`Open Anyway` 这类 macOS 专属词。
- 如果是同一版本补三端包，先确认三端文件名和 Release notes 顶部下载链接逐项对应，不要用一个“通用安装说明”覆盖三端。

### 0.1.2 三端包内运行物验收

每个平台的客户包都必须在目标平台构建目录里验收，不要只在宿主机看文件名或只看 `electron-builder` 成功日志。

| 平台    | 构建来源                                 | 必跑验证                                                           | 包内运行物硬要求                                                                                                                                                                                    |
| ------- | ---------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | macOS runner / 本机                      | `node scripts/verify-mac-package.js --platform mac <ChordVox.app>` | `Contents/Resources/bin` 只能包含 macOS helper、Darwin runtime、`.dylib` 和对应 `node-runtime/darwin-*`。不得出现 Windows `.exe` / `.dll` 或 Linux `.so` / `linux-*` 运行物。                       |
| Windows | GitHub `windows-latest` / UTM 真 Windows | `npm run verify:win:package`                                       | `better_sqlite3.node` 和 `node_modules/ffmpeg-static/ffmpeg.exe` 必须是 Windows PE/MZ；`resources/bin` 只能包含 Windows `.exe` / `.dll` 和 `node-runtime/win32-*`；不得出现 Darwin / Linux 运行物。 |
| Linux   | Linux runner / VPS                       | `npm run verify:linux:package`                                     | `resources/bin` 只能包含 Linux helper、Linux runtime、`.so*` 和 `node-runtime/linux-*`；不得出现 Windows `.exe` / `.dll` 或 macOS `.dylib` / `darwin-*` 运行物。                                    |

补充规则：

- 仓库 `resources/bin` 可以作为多平台运行物缓存；判断是否污染客户包，以目标平台打包后的 `dist/*-unpacked` / `.app` 内容为准。
- 不要把 universal Mach-O 里的多架构 slice 误判为外平台污染；真正要拦的是独立的错误平台运行物，例如 Windows 包里的 Linux `.so`、Linux 包里的 Windows `.dll`、macOS 包里的 Windows `.exe`。
- 如果验证脚本报外平台运行物、缺 helper、缺外部 Node runtime、缺 `app.asar.unpacked` 依赖链，立即熔断，不上传该资产；必须在真实目标 runner / VM 中重打。

## 0.2 发版前整理（必须做）

1. 进入 Pro 仓并确认当前工作区就是你要发布的内容

```bash
cd $HOME/Tools/ChordVox-IME/ChordVox-Pro
git status --short
```

本仓同时配置私有源 `origin` 与公开下载仓 `public`，两边同名版本 tag 可能故意指向不同提交。预检时只允许把私有源 tag 拉进本地命名空间：

```bash
git fetch origin --tags --prune
git ls-remote --tags public "refs/tags/v${VERSION}*"
```

禁止执行 `git fetch public --tags`；它可能报 `would clobber existing tag`，也可能把公开快照 tag 混入私有源发布判断。若 `git ls-remote public` 遇到 SSH 连接中断，改用 `gh api repos/GravityPoet/ChordVox/git/ref/tags/v${VERSION}` 与 `gh release view "v${VERSION}" -R GravityPoet/ChordVox` 做只读碰撞检查，不要因此改写或删除任何本地 tag。

`gh release view --json` 的 Release 标题字段是 `name`，不是 `title`；字段不确定时先看 `gh` 报错列出的可用字段，不要在发布脚本里猜 GraphQL 字段：

```bash
gh release view "v${VERSION}" -R GravityPoet/ChordVox \
  --json name,tagName,isDraft,isPrerelease,url,assets
```

如果 `git status --short` 里出现与发版无关的 handoff 文档，例如：

- `docs/HANDOFF_*.md`

不要顺手纳入发版提交。

2. 升版本号（同时更新 `package.json` 和 `package-lock.json`）

```bash
VERSION="1.5.72"
npm version "$VERSION" --no-git-tag-version
```

本地发布门禁必须与 Actions 使用的 Node 22 + npm 11.9.0 对齐。先检查 `node --version` 与 `npm --version`；如果系统默认 Node 超出依赖声明的支持范围，不要把带 `EBADENGINE` 的结果当成发布证据，改用临时固定工具链：

```bash
CHORDVOX_NODE22_BIN="$(npx -y -p node@22 -p npm@11.9.0 -c 'dirname "$(command -v node)"')"
export PATH="$CHORDVOX_NODE22_BIN:$PATH"
node --version
npm --version
npm ci
npm audit --audit-level=high
npm run verify:ci
npm run build:renderer
```

后续真实听写与本地打包也应继续使用这个 PATH。不要用外层 `npx -p ... -c 'npm run ...'` 直接包裹发布脚本；`verify:release:dictation` 内部还会启动 `npx playwright`，嵌套 npm exec 会把内层命令误解为外层参数并报 `EUSAGE`。

3. 先做最小验收，至少确保前端和类型可过

```bash
npm run verify:ci
npm run build:renderer
```

4. 发布前必须跑真实本地听写 release gate，禁止只用 stubbed E2E 证明听写可用

```bash
# 真实听写证明必须在干净 commit 上运行；若刚执行过 npm version，先提交或 stash 本地变更。
CHORDVOX_RELEASE_DICTATION_WHISPER_MODEL="/absolute/path/to/ggml-model.bin" \
  npm run verify:release:dictation
```

必须看到：

- 使用固定音频 `tests/fixtures/dictation/release-en.wav`
- 使用本地 Whisper 模型绝对路径，不能留空、不能让测试 skip
- `dictation-flow.real.spec.ts` 中真实转录、粘贴、历史保存事件全部通过，且 transcript 命中 `hello|world|chordvox`
- 脚本输出 `real_dictation_verified_sha`，触发 GitHub `Release` workflow 时必须填写这个 SHA，并且必须等于 `source_sha`

真实粘贴 gate 运行时必须让接收端持续占有 macOS 前台焦点，期间不要在 Codex、终端或其他应用中点击/输入。如果真实转录、paste success 事件和历史保存都成功，只有接收端文本为空，先核对 frontmost process；确认是前台竞争后在无交互窗口重跑一次，不要误诊为转录或粘贴实现失败。守护残留进程时也不要直接用会匹配自身命令行的 `pgrep -af <pattern>`；优先使用测试脚本持有的精确 PID，或用不会自匹配的 `ps` 过滤表达式。

5. macOS 发版前必须做一次真实打包验收，禁止只看 workflow 成功就发布

```bash
npm run verify:icons
npm run build:mac:customer
node scripts/verify-mac-package.js --platform mac
npm run verify:dmg-config
```

> 现在正式 macOS 客户包应走 `npm run build:mac:customer`，由 `scripts/build-mac-dmg.js` 生成稳定 DMG 和暖象牙色拖拽安装窗口。
> 只有临时排查 electron-builder 本身时才直接用 `npx electron-builder`；裸 `electron-builder` 不在全局 PATH 中会报 `command not found`。
> macOS DMG 打开后必须显示大标题、暖象牙色背景、左侧 `ChordVox.app`、右侧 `Applications`、中间细箭头；不要回退成白底或无箭头布局。

必须看到：

- `npm run compile:native` 已执行
- `node scripts/verify-mac-package.js --platform mac` 通过
- `npm run verify:icons` 通过，且 macOS / DMG 使用 `src/assets/icon.icns`，Windows 使用 `src/assets/icon.ico`，Linux 使用 `src/assets/icon.png`
- `npm run i18n:check:release` 通过，德/西/法/意/葡/俄 marketed locales 不允许缺 key 回落英文
- `npm run verify:release:dictation` 已在同一 `source_sha` 上通过
- 打包结果内存在 `Contents/Resources/bin/macos-globe-listener`
- 打包结果内存在本地流式外部 worker 依赖链：`app.asar.unpacked/src/helpers/archiveSecurity.js`、`app.asar.unpacked/src/models/modelRegistryData.json`、`app.asar.unpacked/node_modules/tar/package.json` 及 `tar` 的直接依赖包。
- `npm run verify:dmg-config` 通过

安装版固定 WAV 与真实点击粘贴还要单独执行，源码 Electron 的 E2E 不能替代：

```bash
CHORDVOX_PACKAGED_DICTATION_WHISPER_MODEL="/absolute/path/to/ggml-tiny.bin" \
  npm run verify:installed:dictation
```

这个门禁会临时退出 `/Applications/ChordVox.app`，用隔离 `userData` 启动安装版，外部注入固定 WAV 音频流，再通过生产悬浮按钮的两次受信任点击完成录音/停止，并把结果粘贴到另一个独立进程。必须同时看到 `app.isPackaged=true`、`app.asar`、打包版 E2E 钩子关闭、固定 WAV 转写命中、受信任点击、受信任粘贴输入以及独立目标进程；结束后会恢复正常 ChordVox。它不等于真实麦克风验收。

6. 提交并推送主线

```bash
git add -A
git commit -m "Release v${VERSION}"
git push origin main
```

6. 给源仓打版本 tag，并推到私有源仓

```bash
git tag -a "v$VERSION" -m "ChordVox v$VERSION"
git push origin "v$VERSION"
```

7. 记录本次真实源提交 SHA，后续 workflow / manifest 都要用这个

```bash
git rev-parse HEAD
```

## 0.3 已知环境差异（2026-04-12 补充，2026-05-07 更新）

- Linux VPS / Windows UTM 环境如果系统自带 `npm 10.9.4`，可能对当前 `package-lock.json` 误报“不同步”
  - 不要手改 lockfile
  - Linux 优先：`npx -y npm@11.9.0 ci`
  - Windows UTM：`npx.cmd -y npm@11.9.0 ci --ignore-scripts --no-audit --no-fund`
- Windows 正式公开发版不只要 installer，还要 portable：
  - `ChordVox-Setup-<VERSION>.exe`
  - `ChordVox-<VERSION>.exe`
- Windows 正式公开发版必须配置并通过 Authenticode 门禁：
  - GitHub Secret `WINDOWS_CSC_LINK`：PFX 文件路径、URL 或 electron-builder 支持的 base64 内容
  - GitHub Secret `WINDOWS_CSC_KEY_PASSWORD`
  - GitHub Variable `WINDOWS_PUBLISHER_NAME`：固定为 `ChordVox Local Code Signing`
  - Windows 使用仓库内固定公钥证书 `resources/windows/chordvox-local-code-signing.cer` 锁定身份；私钥 PFX 只进入加密 Secret，禁止提交到仓库
  - `electron-builder.win.cjs` 会把发布者名写入 `win.signtoolOptions.publisherName`，并固定使用 SHA-256/RFC3161 时间戳；`win.forceCodeSigning=true` 会让缺证书或签名失败直接终止打包
  - `npm run verify:win:authenticode` 必须证明 NSIS、Portable 与 `win-unpacked/ChordVox.exe` 均为 `Valid`、匹配固定证书、发布者一致且带可信时间戳，并生成 `windows-authenticode-evidence.json`
  - 固定自签证书保证发布身份连续和文件完整性，但没有公共 CA / SmartScreen reputation；未信任该证书的客户机仍可能显示 SmartScreen 或证书不受信任提示，禁止通过安装器静默写入客户根证书库
- Windows/Linux workflow 在产物生成后必须运行 `npm run verify:packaged:dictation`，生成各自的 `native-runtime-evidence-*.json`。该证据必须与 `source_sha` 一致，并覆盖打包版固定 WAV、生产按钮受信任点击、独立进程原生粘贴和隔离 profile；缺证据时不得发布。
- Windows 正式公开发版必须保留拆包证据：
  - `better_sqlite3.node` 是 `PE32+ executable (DLL) x86-64, for MS Windows`
  - `node_modules/ffmpeg-static/ffmpeg.exe` 存在，且是 Windows PE/MZ 文件
  - 不包含 `sherpa-onnx-linux-x64`
  - 不包含 `ffmpeg-static/ffmpeg`
  - 不包含 Linux `.so` native 运行物
- GitHub 的 `browser_download_url` 对大文件有时会先返回 `302` 跳转到 CDN
  - 终验不要只看 `HEAD`
  - 对大文件优先用 `curl -L --range 0-0 -s -o /dev/null -w '%{http_code}'`
  - 最终对象返回 `200` 或 `206` 都可视为链接可用
- `gh release view --json ...` 走 GitHub GraphQL，偶发 `Post "https://api.github.com/graphql": EOF`
  - 这通常是查询连接中断，不等于 Release 或资产上传失败
  - 处理：立即重试一次；若仍失败，用 REST 兜底：
    ```bash
    gh api repos/GravityPoet/ChordVox/releases/tags/v${VERSION} \
      --jq '{html_url,draft,prerelease,assetCount:(.assets|length)}'
    ```
  - 最终裁决仍以：资产精确清单存在 + 主下载链接 `curl -L --range 0-0` 返回 `200` / `206` 为准

### 0.3.1 fallback 环境发现与刷新（2026-07-13）

VPS `/tmp`、UTM 源码目录和一键脚本都是**易失缓存**，不是长期可用性承诺。GitHub Actions 不可用时，可以先探测下列构建线，但每次发版都必须重新验证：

- Linux VPS：
  - 构建目录：`/tmp/chordvox-release-linux`
  - 一键入口：`/tmp/chordvox-next-linux-build.sh`
  - 先验证目录、脚本、Node/npm、剩余空间和目标源码；任一缺失就按 2.3 节重新铺设。
- Windows UTM：
  - VM 名称：`Windows`
  - 构建目录：`C:\ChordVoxBuild\ChordVox-Pro`
  - 便携 Node：`C:\NodePortable\node-v22.19.0-win-x64`
  - 一键入口：`C:\Users\Public\chordvox-next-windows-build.cmd`
  - 先验证 VM 已注册并启动、脚本内 `SOURCE_SHA`/`VERSION`、源码目录和 Windows helper；任一失配就按 UTM SOP 刷新。

只有上述检查全部通过且 SHA/版本与本次发布完全一致，才可直接触发：

```bash
# Linux
ssh $NOTRACE_VPS_HOST /tmp/chordvox-next-linux-build.sh

# Windows UTM
utmctl exec Windows --cmd 'C:\Windows\System32\cmd.exe' /c 'C:\Users\Public\chordvox-next-windows-build.cmd'
```

硬规则：

- 缓存目录不是发布源真相。正式发版前必须确认目标 `SOURCE_SHA` / `package.json` 版本号就是本次要发布的版本。
- 如果脚本不存在，或本机源码/目标 `SOURCE_SHA` 已变化，必须先按本 SOP 重新把目标源码推入 VPS/UTM，再使用可复用依赖继续构建；不要拿旧缓存直接出新版本包。
- Windows 仍必须来自 UTM 真 Windows；VPS 仍只承担 Linux 包构建。
- Mac 本机正在使用时，不要为了补包顺手跑 macOS 打包；先只推进 VPS Linux 和 UTM Windows。

## 0.4 失败熔断规则（2026-04-23 补充，2026-05-06 更新）

这几类错误已经实战踩过，命中后不要反复试错：

1. GitHub Actions 账单 / 额度失败
   - 典型日志：
     - `recent account payments have failed`
     - `spending limit needs to be increased`
     - job 没有真正开始运行
   - 处理：立刻走第 2 节手工 fallback，不要重复触发 workflow。

2. macOS 本机缺少 ChordVox 固定签名身份
   - `security find-identity -v -p codesigning` 返回 `0 valid identities found`
   - 处理：运行 `npm run setup:mac:signing` 从本机加密 P12 回滚件恢复同一身份；若回滚件也缺失，停止 macOS 发布，禁止生成新证书或退回 ad-hoc。
   - 说明：自签名客户包本来就需要首次 Gatekeeper 放行，但其证书身份必须连续。客户说明先走“系统设置 > 隐私与安全性 > 仍要打开”，仍失败才用 DMG 内 `Fix & Open.command`；不要把终端命令写成主路径。

3. 老客户从 ad-hoc / 旧证书版本迁移到首个固定证书版本
   - 现象：自动更新不能作为签名身份切换的可靠迁移路径，或覆盖后辅助功能显示旧授权但当前 App 不生效。
   - 处理：让客户从公开 Release 手动下载 DMG，退出旧版后拖入 `Applications` 覆盖一次；按正常自签名首开流程放行，并在系统要求时重新启用 ChordVox 的辅助功能。禁止让客户安装根证书。
   - 验收：迁移后的 App designated requirement 必须包含当前固定证书哈希；下一次同证书更新不应再次要求辅助功能迁移。

4. Linux / Windows lockfile 误报
   - 如果 `npm ci` 报 `package-lock.json is out of date`，且缺的是 `better-sqlite3` / `pg` / `pg-pool` / `pg-protocol`
   - 处理：不要改 lockfile；fallback 环境允许改用 `npm install --no-audit --no-fund` 或对应的 `npm@11.9.0 install`。

5. SSH / UTM 长任务断线
   - 处理：先重连并检查构建进程和 `dist` 目录，不要立即重启整轮构建。
   - Linux 查：
     ```bash
     ps -ef | grep -E "electron-builder|fpm|rpmbuild|npm run build:linux" | grep -v grep
     ls -lh /tmp/chordvox-release-linux/dist
     ```

6. 大文件回收失败
   - 如果 `scp` 报 `Connection closed`，不要反复 `scp`
   - 处理：改用可断点续传的：
     ```bash
     rsync -avP --partial --prune-empty-dirs \
       --include='*/' \
       --include='*.AppImage' \
       --include='*.deb' \
       --include='*.rpm' \
       --include='*.tar.gz' \
       --include='latest-linux.yml' \
       --include='release-manifest-linux.json' \
       --exclude='*' \
       <remote>:<path>/dist/ /tmp/chordvox-release-linux/dist/
     ```
   - 不要直接同步整个 `dist/` 目录；它可能包含巨大的 `linux-unpacked/`，不是公开 Release 资产，会浪费时间和本机空间。
   - `--include='*/'` 只用于让 rsync 走到顶层文件；必须配 `--prune-empty-dirs`，否则会把 `linux-unpacked/` 这类空目录骨架也拉回本机，制造误判和清理成本。

7. Windows 包禁止走 VPS/Wine 作为客户包来源
   - GitHub Actions 可用：Windows 必须走 GitHub `windows-latest` runner。
   - GitHub Actions 不可用：Windows 必须走 UTM 真 Windows。
   - Linux VPS + `electronuserland/builder:wine` 生成的 Windows `.exe` 不得作为客户安装包发布。
   - 如果发现 Windows 包内 `better_sqlite3.node` 是 `ELF`、缺少 `ffmpeg-static/ffmpeg.exe`、`ffmpeg.exe` 不是 Windows PE/MZ、出现 `sherpa-onnx-linux-x64`、出现 `ffmpeg-static/ffmpeg` 或 `.so`，立即熔断，删除/替换该 Windows 资产。

8. VPS 磁盘不足
   - 典型日志：
     - `ENOSPC: no space left on device`
     - `df -h` 显示 `/`、`/tmp` 或 Docker 数据目录接近 100%
   - 处理：先清理旧的 `/tmp/chordvox-release-*`、旧 `dist/*-unpacked`、Docker 临时产物，再重跑。
   - VPS 只承担 Linux 包构建，不承担 Windows 客户包构建。
   - 可用空间少于 10GB 时，不要开始新一轮 Linux 构建。

9. Windows UTM `resources/bin` 不能全量混入非 Windows 运行物
   - Windows 构建目录只应保留 Windows 所需 `.exe` / `.dll` 和 `node-runtime/win32-x64`。
   - 打包前必须确认至少存在：
     - `windows-key-listener.exe`
     - `windows-fast-paste.exe`
     - `nircmd.exe`
   - 打包后必须拆包确认不存在 Linux 运行物。

10. Windows native module 平台校验失败

- 如果 `better_sqlite3.node` 不是 `PE32+ executable (DLL) x86-64, for MS Windows`，不能发布。
- 如果 `node_modules/ffmpeg-static/ffmpeg.exe` 缺失或不是 Windows PE/MZ 文件，不能发布。
- 如果 Windows 包里出现 `sherpa-onnx-linux-x64`、`ffmpeg-static/ffmpeg` 或 `.so`，不能发布。
- 处理：丢弃这次 Windows 产物，在 GitHub `windows-latest` 或 UTM 真 Windows 中重打。

11. 远端文件名有空格
    - Windows installer 原始产物可能叫 `ChordVox Setup <VERSION>.exe`，空格会让未引用的 `rsync/scp` 路径被 shell 拆开。
    - 拉取远端单文件时必须引用远端路径，或先在远端 staging 改成无空格文件名。
    - 上传公开 release 时优先使用 `scripts/publish-utm-windows-release.sh` 做文件名规范化；脚本名虽带 `utm`，但输入可以是任意 Windows dist 目录。

12. Linux `npm ci` 遇到 darwin-only native dependency
    - 典型日志：
      - `Unsupported platform for electron-liquid-glass@1.1.1: wanted {"os":"darwin"} (current: {"os":"linux"})`
    - 根因：darwin-only native 包被放在 root `dependencies`，Linux 会把它当必装依赖。
    - 处理：把这类平台专属 native 包放到 root `optionalDependencies`，重新生成 `package-lock.json` 后提交推送，再用新的 `SOURCE_SHA` 重建三端包。
    - 不要在 VPS 上用 `--force`、`--ignore-platform` 或手删 lockfile 绕过；这会让 CI 和客户包来源继续不可复现。

13. Windows UTM `--ignore-scripts` 后缺 `ffmpeg-static/ffmpeg.exe`
    - 典型日志：
      - `Missing Windows ffmpeg-static binary: ...\node_modules\ffmpeg-static\ffmpeg.exe`
    - 根因：UTM fallback 为了避免 native rebuild 使用 `npm ci --ignore-scripts`，但这也会跳过 `ffmpeg-static` 的 postinstall 下载。
    - 处理：在 Windows guest 里执行 `node node_modules\ffmpeg-static\install.js`，确认 `node_modules\ffmpeg-static\ffmpeg.exe` 存在，然后清理 `dist` 重跑 `electron-builder --win` 和 `node scripts\verify-mac-package.js --platform win`。
    - 不能把缺 `ffmpeg.exe` 的 Windows installer / portable 上传到公开 release。

14. GitHub Release 创建前检查偶发 `EOF`
    - 典型日志：
      - `error checking for existing release: Head "https://api.github.com/repos/GravityPoet/ChordVox/releases/tags/vX.Y.Z": EOF`
    - 根因：GitHub API/网络在 `gh release create` 的存在性检查阶段断开，release 通常还没有创建。
    - 处理：立即用 `gh release view` 和 REST `gh api repos/GravityPoet/ChordVox/releases/tags/vX.Y.Z` 复核；确认 release/tag 仍不存在后再重试创建。
    - 不要在未复核时重复创建或改传旧 tag。

## 0.5 Release Highlights 文案规则（客户收益优先）

发布给客户看的 `Highlights / 更新亮点` 不是提交日志，必须把真实改动翻译成客户能感知的收益。

发版前必须先读取上一版公开 release notes，并把上一版作为最低质量基线，而不是可选参考：

```bash
cd $HOME/Tools/ChordVox-IME/ChordVox-Pro && gh release view v<PREVIOUS_VERSION> -R GravityPoet/ChordVox --json body,assets,url
```

对标原则：

- 如果上一版 Downloads 是可点击直链，本版不能退化成裸文件名或反引号文件名。
- 如果上一版 Highlights 有分组标题、场景解释、收益描述，本版不能退化成平铺的普通 bullet list。
- 如果上一版让用户一眼知道“该下哪个包、为什么要更新”，本版必须至少做到同等清晰。
- 新版本的源码 SHA、CI 失败、manifest 细节、签名密钥缺失等内部事实只能进入内部 SOP/交付报告；公开文案只保留对用户有意义的安装风险和处理方式。

外部优质项目的可借鉴点：

- GitHub Desktop：release notes 按 Added / Fixed / Improved 分类，具体到用户动作，不写成内部提交流水账。
- Actual Budget：GitHub release 顶部保留 `View release notes`，桌面包以表格列出 File / Size / Downloads，让用户快速判断下载对象。
- Joplin：桌面 release assets 覆盖 DMG / PKG / AppImage / DEB / Windows installer / updater metadata，文件命名稳定，用户和自动更新脚本都能预测。
- Tauri：分发文档强调 GitHub Actions 构建、上传 release、updater 查询 release 三者必须成链路；安装包和 updater 元数据不能互相脱节。

硬规则：

1. 必须基于本次真实改动、构建产物和验证结果写，不得编造未实现能力。
2. 先写客户收益，再写技术事实；不要只写“修复了某文件 / 同步了某脚本”。
3. 重大版本要突出产品升级感，例如：
   - UI 全面升级：界面更清爽、更一致、更容易找到设置。
   - 语音悬浮胶囊升级：录音状态更直观，动效更高级，听写反馈更明确。
   - 新用户向导优化：首次设置路径更短，权限、模型准备、快捷键测试更清楚。
   - 本地模型与隐私体验优化：本地优先、后台准备模型、下载状态更可见。
   - 跨平台交付增强：macOS / Windows / Linux 安装包和 updater 元数据同步补齐。
   - 稳定性增强：关闭窗口后台运行、检查更新、打包完整性、helper 二进制等问题修复。
4. 小版本也要写成用户视角，例如：
   - 不写：`Fix onboarding waiting state`
   - 写：`First-time setup now clearly shows when the local model is still preparing, so users know when speech testing will unlock.`
5. 英文和中文必须都写完整，不能只把一边写好，另一边随便直译。
6. 不要把 private repo、source SHA、CI 内部错误、manifest 细节写进公开 release notes；这些只放内部记录。
7. 如果只是补平台安装包，也要说明客户收益，例如“Windows / Linux 用户现在可以直接下载同版本安装包”，不要只写“uploaded assets”。
8. macOS 固定自签名包仍受 Gatekeeper 限制，必须保留首次启动说明，避免客户安装后误判为软件坏了。
9. 每条亮点必须通过“用户现在可以……”测试；如果写不出用户动作或收益，就不要放在 Highlights。
10. 亮点数量少于 3 组或每组缺少场景解释时，不得发布；宁可减少技术细节，也要把 3-5 个核心收益讲透。
11. 禁止用“More natural / Faster / Smarter / Clearer / Safer / Stronger”这类空泛形容词单独撑起 bullet；形容词后必须跟具体功能、使用场景和可感知结果。

推荐结构：

```markdown
## Highlights

更新亮点

English

- A more polished ChordVox experience: refreshed settings, onboarding, and floating dictation capsule make the app feel clearer and more production-ready.
- Faster first-time setup: permissions, local model preparation, and hotkey testing are now easier to understand.
- Better local-first transcription feedback: users can see when the local model is preparing and when speech testing is ready.
- Broader package availability: macOS, Windows, and Linux installers are published under the same version when available.

中文

- ChordVox 整体体验升级：设置页、新手向导和语音悬浮胶囊全面打磨，界面更清爽、更接近正式产品。
- 首次设置更顺畅：权限、本地模型准备和快捷键测试路径更清晰，用户更容易完成第一次听写。
- 本地优先体验更明确：模型正在准备、测试何时解锁等状态更可见，减少等待时的困惑。
- 多平台安装包更完整：macOS、Windows、Linux 安装包会尽量在同一版本下同步提供。
```

## 0.6 Release Assets 展示与上传顺序规则

GitHub Release 页面只会默认展示部分 assets，资产多时会出现 `Show all N assets`。这个展示顺序不可靠，不能把“客户能不能看到 macOS 安装包”寄托在 assets 列表排序上。

硬规则：

1. 每个客户交付 release notes 顶部必须有 `Downloads / 下载资源` 区块。
2. `Downloads / 下载资源` 必须放在 `Highlights / 更新亮点` 前面。
3. 每次发布前先区分两类资产，不要机械照旧 SOP：
   - 客户手动下载入口：放在 release notes 顶部 Downloads。
   - 自动更新 / 元数据资产：保留在 Assets，但普通用户不需要手动下载。
4. Downloads 中的客户安装包必须是 Markdown 可点击直链，禁止只写裸文件名、反引号文件名或“见 Assets”。链接必须直接指向 `https://github.com/GravityPoet/ChordVox/releases/download/v<VERSION>/<asset>`。
5. 每个主下载链接发布前必须用公开资产列表验证文件存在；主入口建议再用 `curl -L --range 0-0 <url>` 抽样验证返回 `200` 或 `206`。
6. 推荐下载顺序固定为：
   - macOS Apple Silicon 主安装包：`ChordVox-<VERSION>-arm64.dmg`
   - macOS PKG / Intel 安装包（可选，只有本次 fresh 构建并验证通过且真实上传才展示）
   - Windows Installer：`ChordVox-Setup-<VERSION>.exe`
   - Linux AppImage：`ChordVox-<VERSION>-linux-x86_64.AppImage`
   - 其他 Linux 包：`ChordVox-<VERSION>-linux-amd64.deb` / `ChordVox-<VERSION>-linux-x86_64.rpm` / `ChordVox-<VERSION>-linux-x64.tar.gz`
7. 如果某个平台本次没有产物，Downloads 里不要写不存在的文件；可以写“暂未提供”或直接省略该平台。
8. macOS `ChordVox-<VERSION>-arm64-mac.zip` 是 `electron-updater` 自动更新链路需要的资产，不作为客户下载入口展示，但必须保留在 Assets。
9. `latest-mac.yml`、`latest.yml`、`latest-linux.yml`、`*.blockmap`、`release-manifest-*.json` 属于 updater / 校验 / 溯源元数据，不要为了减少 assets 数量随意删除。
10. GitHub 自动生成的 `Source code (zip)` / `Source code (tar.gz)` 不能删除，也不应作为客户下载入口。
11. 如果后续需要重排 assets 视觉顺序，优先更新 release notes 顶部 Downloads 链接；不要优先删除再重传资产。
12. 新建 release 或手动补传整套资产时，上传顺序优先：

- 先上传 macOS 客户安装包：`.dmg`
- 如果本次发布 PKG，再上传 fresh 构建并验证过的 `.pkg` 和 `.pkg.sha256`
- 再上传 Windows 客户安装包：`Setup .exe`
- 再上传 Linux 用户常用安装包：`AppImage` / `.deb` / `.rpm` / `.tar.gz`
- 最后上传 updater 元数据：macOS `.zip`、`latest*.yml`、`*.blockmap`、`release-manifest-*.json`

13. 覆盖已有 release 时，如果 GitHub 仍把 macOS 安装包折叠到 `Show all` 下面，不要反复删传折腾；直接把 Downloads 区块改到正文最顶部，并使用明确文件名或直接下载链接。

推荐 Downloads 模板：

```markdown
## Downloads

下载资源

English

- macOS (Apple Silicon): [ChordVox-X.Y.Z-arm64.dmg](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-arm64.dmg)
- Windows Installer: [ChordVox-Setup-X.Y.Z.exe](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-Setup-X.Y.Z.exe)
- Linux AppImage: [ChordVox-X.Y.Z-linux-x86_64.AppImage](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-linux-x86_64.AppImage)
- Linux DEB: [ChordVox-X.Y.Z-linux-amd64.deb](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-linux-amd64.deb)
- Linux RPM: [ChordVox-X.Y.Z-linux-x86_64.rpm](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-linux-x86_64.rpm)
- Linux tar.gz: [ChordVox-X.Y.Z-linux-x64.tar.gz](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-linux-x64.tar.gz)

中文

- macOS（Apple 芯片）：[ChordVox-X.Y.Z-arm64.dmg](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-arm64.dmg)
- Windows 安装版：[ChordVox-Setup-X.Y.Z.exe](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-Setup-X.Y.Z.exe)
- Linux AppImage：[ChordVox-X.Y.Z-linux-x86_64.AppImage](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-linux-x86_64.AppImage)
- Linux DEB：[ChordVox-X.Y.Z-linux-amd64.deb](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-linux-amd64.deb)
- Linux RPM：[ChordVox-X.Y.Z-linux-x86_64.rpm](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-linux-x86_64.rpm)
- Linux tar.gz：[ChordVox-X.Y.Z-linux-x64.tar.gz](https://github.com/GravityPoet/ChordVox/releases/download/vX.Y.Z/ChordVox-X.Y.Z-linux-x64.tar.gz)
```

## 0. 前置条件

- 已安装并登录 GitHub CLI：`gh auth status`
- Pro 仓主线代码在：`$HOME/Tools/ChordVox-IME/ChordVox-Pro`
- 公开下载仓：`GravityPoet/ChordVox`
- 发版版本号示例：`1.5.31`

---

## 1. 标准流程（优先，走 Pro 的 Release workflow）

> 这条只适用于 `main` 口径的正式公开发版。

1. 获取要发版的源提交（必须在 Pro 的 `origin/main` 上）

```bash
cd $HOME/Tools/ChordVox-IME/ChordVox-Pro
git fetch origin
git rev-parse origin/main
```

2. 先在同一源提交上跑真实听写 gate，再手动触发 Pro workflow（带 `version + source_sha + real_dictation_verified_sha`）

```bash
VERSION="1.5.31"
SOURCE_SHA="<上一步得到的40位SHA>"
git checkout "$SOURCE_SHA"
CHORDVOX_RELEASE_DICTATION_WHISPER_MODEL="/absolute/path/to/ggml-model.bin" \
  npm run verify:release:dictation
REAL_DICTATION_VERIFIED_SHA="$SOURCE_SHA"

gh workflow run Release \
  -R GravityPoet/ChordVox-Pro \
  -f version="$VERSION" \
  -f source_sha="$SOURCE_SHA" \
  -f real_dictation_verified_sha="$REAL_DICTATION_VERIFIED_SHA" \
  -f windows_delivery="actions"
```

3. 观察构建与发布

```bash
gh run list -R GravityPoet/ChordVox-Pro --limit 5
gh run watch -R GravityPoet/ChordVox-Pro <RUN_ID> --exit-status
```

4. 验证公开仓 Release

```bash
gh release view "v$VERSION" -R GravityPoet/ChordVox --json url,assets
```

5. 校验 Actions 日志里 `Verify packaged macOS helpers` 步骤已通过。
   如果该步骤不存在或失败，禁止继续把这次 macOS 资产视为可发布版本。

6. 校验本次 Release 资产中包含平台 manifest：
   - `release-manifest-linux.json`
   - `release-manifest-windows.json`
   - `release-manifest-macos-arm64.json`
   - `release-manifest-macos-x64.json`
   - 每个 manifest 必须同时记录 `sourceSha` 与 `realDictationVerifiedSha`，且两者等于本次 `SOURCE_SHA`
7. 对 macOS 资产做抽样核验：
   - 至少核对公开 Release 里的 `ChordVox-<VERSION>-arm64-mac.zip` / `dmg` sha256 是否符合预期
   - 若本次做过手动补传，必须再次解包确认 `ChordVox.app/Contents/Resources/bin/macos-globe-listener` 存在
8. 发布说明必须使用双语排版：
   - 同一节内必须先写完整英文块，再写对应的完整中文块
   - 英文和中文要按 section / paragraph / bullet group 成组对应，不要一句英文后面立刻插一句中文
   - 推荐结构是：英文标题或英文 bullets 在前，中文标题或中文 bullets 在后，整节保持固定顺序
9. 发布说明必须包含 `docs/RELEASE_NOTES_TEMPLATE.md` 中的 `macOS First Launch` 段落，并固定把正常安装动作放在最前面，Gatekeeper 与 DMG helper 只作为兜底：
   - `Open the DMG, drag ChordVox.app to Applications, then open ChordVox from Applications.`
   - 同一小节内先放英文说明，再放对应中文说明，且保留相同含义
10. 发布说明只能使用 Markdown，不得粘贴 HTML 标签或 GitHub 页面渲染后的 DOM 片段。
11. 发布说明必须通过品牌安全检查：

- 只能使用 ChordVox 自有表述描述功能，例如 `built-in cleanup`、`ChordVox 内置清洗`、`voice assistant mode`。
- 不得用竞品名称、竞品风格、竞品 prompt 或竞品定位来描述 ChordVox 功能。
- 禁止出现 `Typeless-style`、`Typeless 风格`、`Typeless`、`Wispr`、`superwhisper`、`Aqua Voice` 等竞品口径，除非用户明确要求写竞品对比文案。
- 发布前必须对 release notes 文件执行检查；一旦命中，停止发布并改成 ChordVox 自有表述：

```bash
if grep -Eiq 'typeless|wispr|superwhisper|aqua[ -]?voice' /tmp/chordvox_release_notes.md; then
  echo "Brand-safety check failed: release notes contain competitor wording." >&2
  exit 1
fi
```

12. 发布说明必须通过功能事实检查：

- 可以使用有销售感的价值文案，但不能把运行时关闭、UI 隐藏、平台受限或仅内部打底的功能写成全量客户可用。
- 发布前要对本次主推功能核源码证据：runtime flag、`SHOW_*` UI 开关、平台 guard、单测 / E2E、真实包资产。例：`TAIL_COMMANDS_RUNTIME_ENABLED=false`、`PASTE_CONFIRM_RUNTIME_ENABLED=false`、`SHOW_TAIL_COMMANDS_SETTING=false`、`SHOW_PASTE_CONFIRM_SETTING=false` 时，不能宣传“语音结束控制”“长文本粘贴确认流”已上线。
- 平台受限必须写清平台范围。例：按前台应用名 / Bundle ID 自动切换润色风格当前依赖 macOS `getFrontmostApp()`，公开文案应写“macOS 上可按当前应用切换”，不要泛化为三端全平台。
- 禁止把内部原因写给客户：private source SHA、CI 失败原因、缺少 secrets、签名密钥缺失、manifest 内部字段都不进公开正文；只写客户需要知道的安装动作和首次启动帮助。

### 1.1 Windows 用 UTM 发最新版安装包到 GitHub

如果这次 Windows 不走 GitHub Actions runner，而是改用 UTM Win11 本地打包并发布：

1. 触发 Release workflow 时把 `windows_delivery` 设为 `utm-manual`

```bash
VERSION="1.5.31"
SOURCE_SHA="<上一步得到的40位SHA>"
git checkout "$SOURCE_SHA"
CHORDVOX_RELEASE_DICTATION_WHISPER_MODEL="/absolute/path/to/ggml-model.bin" \
  npm run verify:release:dictation
REAL_DICTATION_VERIFIED_SHA="$SOURCE_SHA"

gh workflow run Release \
  -R GravityPoet/ChordVox-Pro \
  -f version="$VERSION" \
  -f source_sha="$SOURCE_SHA" \
  -f real_dictation_verified_sha="$REAL_DICTATION_VERIFIED_SHA" \
  -f windows_delivery="utm-manual"
```

2. 等 Linux / macOS 发布完成后，按 [docs/UTM_WINDOWS_BUILD_SOP.md]($HOME/Tools/ChordVox-IME/ChordVox-Pro/docs/UTM_WINDOWS_BUILD_SOP.md) 在 UTM 里生成 Windows 包

3. 在 macOS 宿主机执行正式上传脚本，把 UTM 的最新 Windows 安装包补传到公开 GitHub Release

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
SOURCE_SHA="<上一步得到的40位SHA>"
REAL_DICTATION_VERIFIED_SHA="$SOURCE_SHA"
ARTIFACTS_DIR="/path/to/utm/windows/dist"

cd $HOME/Tools/ChordVox-IME/ChordVox-Pro
scripts/publish-utm-windows-release.sh \
  "$VERSION" \
  "$SOURCE_SHA" \
  "$REAL_DICTATION_VERIFIED_SHA" \
  "$ARTIFACTS_DIR" \
  "GravityPoet/ChordVox"
```

4. 验证公开仓 Release 中包含：
   - `ChordVox-<VERSION>.exe`
   - `ChordVox-Setup-<VERSION>.exe`
   - `ChordVox-Setup-<VERSION>.exe.blockmap`
   - `latest.yml`
   - `release-manifest-windows.json`
   - `release-manifest-windows.json` 中 `sourceSha` 与 `realDictationVerifiedSha` 都等于本次 `SOURCE_SHA`

---

## 2. 回退流程（Actions 权限/账单受限时，手动发）

> 仅在第 1 步失败时使用。手动发版必须显式记录 `source_sha` 和 `real_dictation_verified_sha`。
> 如果 GitHub Actions 报错 `recent account payments have failed or your spending limit needs to be increased`，直接走本节。
> 平台环境固定为：macOS 用本机、Windows 用 UTM、Linux 用 VPS。

1. 本机构建（macOS）

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
SOURCE_SHA="<Pro源SHA>"
PRO_DIR="$HOME/Tools/ChordVox-IME/ChordVox-Pro"

cd "$PRO_DIR"
git fetch origin
git checkout "$SOURCE_SHA"

npm ci
npm run build:mac:test
```

> 如果本机 `resources/bin` 已经有必需二进制，不要为了“完整流程”重复跑 `prebuild:mac:*` 下载。遇到 GitHub / TLS 下载断线时，先确认二进制是否已存在；已存在就直接 `npm run build:mac:test`。

1.1 手动发 macOS 包后，必须额外确认：

```bash
node scripts/verify-mac-package.js --platform mac
find dist/.mac-dmg-work/mac-arm64/ChordVox.app/Contents/Resources -maxdepth 4 | rg 'macos-globe-listener'
```

2.1 验证构建产物

```bash
ls -lah dist/ChordVox-${VERSION}-* dist/latest-mac.yml
```

正常情况下至少应有：

- `dist/ChordVox-${VERSION}-arm64-mac.zip`
- `dist/ChordVox-${VERSION}-arm64-mac.zip.blockmap`
- `dist/ChordVox-${VERSION}-arm64.dmg`
- `dist/ChordVox-${VERSION}-arm64.dmg.blockmap`
- `dist/latest-mac.yml`

### 2.2 当前默认脚本已经绕过了旧 `dmg-builder detach` 问题。

如果你只是要重做稳定 DMG，直接执行：

```bash
npm run build:mac:dmg:test
```

如果必须只重做 `dmg`，仍然走仓库脚本，不要手写裸 `hdiutil`。脚本会复用 `Fix & Open.command`、背景图、Finder 布局、校验和临时文件提升逻辑：

```bash
VERSION="1.5.31"
npm run build:mac:dmg:test
npm run verify:dmg-config
hdiutil verify "dist/ChordVox-${VERSION}-arm64.dmg"
```

2.3 Linux VPS 手工补包

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
SOURCE_SHA="<Pro源SHA>"
BUILD_DIR="/tmp/chordvox-release-linux"

ssh $NOTRACE_VPS_HOST "rm -rf '$BUILD_DIR' && mkdir -p '$BUILD_DIR'"
git archive "$SOURCE_SHA" | ssh $NOTRACE_VPS_HOST "tar -x -C '$BUILD_DIR'"

ssh $NOTRACE_VPS_HOST "cd '$BUILD_DIR' && npx -y npm@11.9.0 ci --no-audit --no-fund || npx -y npm@11.9.0 install --no-audit --no-fund"
ssh $NOTRACE_VPS_HOST "cd '$BUILD_DIR' && npm run prebuild:linux && npm run build:linux"
ssh $NOTRACE_VPS_HOST "cd '$BUILD_DIR' && npm run verify:linux:package"

rsync -avP --partial --prune-empty-dirs \
  --include='*/' \
  --include='*.AppImage' \
  --include='*.deb' \
  --include='*.rpm' \
  --include='*.tar.gz' \
  --include='latest-linux.yml' \
  --include='release-manifest-linux.json' \
  --exclude='*' \
  $NOTRACE_VPS_HOST:"$BUILD_DIR/dist/" /tmp/chordvox-release-linux/dist/
```

Linux 注意：

- 仅当脚本真实存在，且日志/源码已确认 `SOURCE_SHA` 与版本完全匹配本次发布时，才可以直接跑：
  ```bash
  ssh $NOTRACE_VPS_HOST /tmp/chordvox-next-linux-build.sh
  ```
- `rpm` 阶段可能长时间无输出，不等于卡死；先查进程和 `dist` 文件增长。
  - 2026-05-07 实战里 `rpmbuild` 长时间安静但仍在跑，不能因为终端没刷屏就重启整轮；先看 `ps -ef | grep -E "rpmbuild|fpm|electron-builder"`、远端 `dist/` 文件时间和大小。
- SSH 断线后先重连看构建进程和产物，不要立刻重跑。
- 本地 PTY / Codex 等待会话丢失并报 `Unknown process id` 时同样按 SSH 断线处理：重连检查 `electron-builder` / `rpmbuild` / `7za` 与 `dist/`，若四包已存在，只重跑 `verify:linux:package` 取得新鲜证据，禁止重复打包。
- AppImage 运行冒烟必须在隔离 `--user-data-dir` 下用 Xvfb + DBus 启动，确认解包后的 Electron 主进程稳定存活至少 15 秒并识别 Whisper、FFmpeg、sherpa-onnx 后，先向该主进程发送 `SIGTERM`，再等待 `xvfb-run` / `dbus-run-session` 外层自然退出。禁止用 `timeout` 先杀外层包装进程；这会遗留 Electron 主进程，并在显示会话先消失后制造 `FATAL ... Failed to shutdown` 假失败。合格收尾必须同时满足：外层 exit 0、隔离 profile 无残留进程、无 crash dump、无 Fatal 日志。
  - 残留检测器本身的命令行不能包含用于识别 Electron 子进程的文字模式，否则 `awk` / `grep` 会把自己误报为残留。稳定做法是按精确 PID 等待，或让 `/proc/*/cmdline` 扫描器从环境变量读取 profile 路径并跳过自身 PID。
  - 通过 GitHub 下载的 AppImage 可能没有执行位；`--appimage-extract` 前先 `chmod 755`，再以 SHA256 证明内容未变化。`Permission denied` 不能据此判定包损坏。
  - 发布后还必须覆盖 AppImage runtime 的真实 FUSE 路径。若 VPS 有 `/dev/fuse` 但未安装 `libfuse2`，用 `apt-get download libfuse2` + `dpkg-deb -x` 解到权限受控的临时目录，只把其库目录加入该次进程的 `LD_LIBRARY_PATH`，不要为一次验收永久修改宿主依赖。除上述运行门禁外，还须确认 15 秒时存在 `.mount_ChordVox*` 挂载，进程退出后挂载数归零。
- 回收大文件优先 `rsync -avP --partial`，不要反复 `scp`。
- 覆盖同版本 Release 前的旧大包优先在网络更快的 VPS 上完整备份并逐项核对公开 SHA256；本机只保留实际需要的上传副本。中断的本机临时下载应移入废纸篓等可恢复位置，不把半包混入上传目录。
- 回收 Linux 产物时只同步顶层发布资产，不要把 `linux-unpacked/` 拉回本机：

  ```bash
  rsync -avP --partial --prune-empty-dirs \
    --include='*/' \
    --include='*.AppImage' \
    --include='*.deb' \
    --include='*.rpm' \
    --include='*.tar.gz' \
    --include='latest-linux.yml' \
    --include='release-manifest-linux.json' \
    --exclude='*' \
    $NOTRACE_VPS_HOST:"$BUILD_DIR/dist/" /tmp/chordvox-release-linux/dist/
  ```

  - 如果怀疑 `--include='*/'` 仍造成目录噪声，改成逐个拉确切资产名，不要为了省事同步整个 `dist/`。

- 如果 `release-manifest-linux.json` 没生成，必须补生成并随 Linux 资产上传。
- `release-manifest-linux.json` 体积很小是正常现象；只要 `python3 -m json.tool` 能解析，且 `assets[]` 覆盖 AppImage / deb / rpm / tar.gz / latest-linux.yml，就不要因为它只有几百字节误判为坏文件。
- 远端用 `set -u` 生成 manifest 时，不要在嵌套 `ssh '...'` 字符串里直接写 `awk '{print $1}'`；`$1` 可能被远端 shell 当位置参数展开导致 `unbound variable`。
  - 稳定写法：用 `cut -d " " -f 1`，或用单引号 heredoc 把脚本传给远端。
  - 如果本地 manifest 被重定向成 `0B`，不要继续上传；先在远端重新生成、`python3 -m json.tool` 校验，再单独拉回 manifest。
- shell 预检版本优先使用 `jq -r .version package.json`，不要在多层 SSH 引号中拼接过度转义的 `node -p` 表达式。远端 `set -u` 下若使用 `dpkg-query -f='${Status}'`，必须把 `$` 留给远端 `dpkg-query`（例如 heredoc 或 `\${Status}`），否则 shell 会先报 `unbound variable`。

### 2.4 Windows VPS / Wine 禁止项与事故复核

Windows 客户安装包禁止再使用 VPS Linux + Docker `electronuserland/builder:wine` 作为来源。

原因：`v1.5.114` 到 `v1.5.116` 的公开 Windows 包曾出现外壳为 Windows `.exe`，但内部 `resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node` 是 Linux `ELF` 的事故；同时包内混入了 `sherpa-onnx-linux-x64` 和 Linux `ffmpeg-static/ffmpeg`。这类包在 Windows 上会报：

```txt
better_sqlite3.node is not a valid Win32 application
```

如果怀疑某个 Windows release 资产有问题，先在 macOS 宿主机只读拆包：

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.116"
ARTIFACT="/tmp/ChordVox-${VERSION}.exe"
EXTRACT_DIR="/tmp/chordvox-win-inspect-${VERSION}"
SEVEN_Z="node_modules/7zip-bin/mac/arm64/7za"

rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"

curl -L --fail --retry 3 \
  -o "$ARTIFACT" \
  "https://github.com/GravityPoet/ChordVox/releases/download/v${VERSION}/ChordVox-${VERSION}.exe"

"$SEVEN_Z" e -y "$ARTIFACT" \
  "resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
  "resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe" \
  -o"$EXTRACT_DIR" >/dev/null

file "$EXTRACT_DIR/better_sqlite3.node"
file "$EXTRACT_DIR/ffmpeg.exe"
"$SEVEN_Z" l "$ARTIFACT" | rg 'sherpa-onnx-linux-x64|ffmpeg-static/ffmpeg$|\.so(\s|$)' && {
  echo "Linux runtime files found in Windows package" >&2
  exit 1
}
```

合格输出必须满足：

```txt
better_sqlite3.node: PE32+ executable (DLL) ... for MS Windows
ffmpeg.exe: PE32... for MS Windows
```

如果 `better_sqlite3.node` 输出是 `ELF 64-bit LSB shared object`，`ffmpeg.exe` 缺失/不是 Windows PE 文件，或命中 Linux runtime 文件，必须丢弃该 Windows 资产，在 GitHub `windows-latest` 或 UTM 真 Windows 中重打。`npm run build:win` 会自动调用 `npm run verify:win:package`，不得跳过该验证后手工上传 Windows 包。

2.5 Windows UTM 手工补包（Actions 不可用时默认）

Windows UTM 详细步骤以 [`docs/UTM_WINDOWS_BUILD_SOP.md`](UTM_WINDOWS_BUILD_SOP.md) 为准；在以下场景使用：

- Windows 包需要真实 Windows 桌面启动验证。
- GitHub Actions 不可用，但仍要补 Windows 客户安装包。
- 用户明确要求 Windows 原生环境打包。

UTM 总规则：

- 仅当脚本真实存在，且脚本、`SOURCE_SHA.txt`、`package.json` 三处都匹配本次目标时，才可以直接跑：
  ```bash
  utmctl exec Windows --cmd 'C:\Windows\System32\cmd.exe' /c 'C:\Users\Public\chordvox-next-windows-build.cmd'
  ```
- `git archive` 不会带上被忽略 / 未跟踪的 `resources/bin`，必须单独打包推入 UTM。
- `utmctl exec` 可能 exit 0 但没有 stdout，关键命令必须写日志文件再 pull。
- 不要把清理、切目录、构建这些动作塞进一条 inline `cmd /c` 或 PowerShell；下次直接跑预热 `.cmd` 包装脚本，并从日志里的 `CODEX_RUN_START` / source SHA / `CODEX_RUN_EXIT` 判断真实状态。
- `.bat` 中调用 `npm.cmd` / `npx.cmd` / `electron-builder.cmd` 必须加 `call`，否则批处理控制流可能中断。
- UTM 拉大文件很慢，观察本地文件大小，不要误判为卡死。

### 2.6 本地流式 worker 缺依赖事故复核

现象：

- UI 提示：`本地流式启动失败`
- 详细原因类似：`Failed to start local streaming: Local streaming worker exited during startup: 1`
- 日志里出现：

```txt
Error: Cannot find module 'tar'
Require stack:
- .../Contents/Resources/app.asar.unpacked/src/helpers/archiveSecurity.js
- .../Contents/Resources/app.asar.unpacked/src/helpers/sherpaStreamingManager.js
- .../Contents/Resources/app.asar.unpacked/src/helpers/sherpaStreamingWorker.js
```

根因：

- `sherpaStreamingWorker.js` 运行在外部 Node runtime 中，入口文件虽然被 `asarUnpack` 解开，但它间接依赖的 `tar` 没有被解包到 `app.asar.unpacked/node_modules`。
- 旧验收只检查 worker 入口和 `sherpa-onnx-node`，没有检查 `archiveSecurity.js -> tar` 这条实际启动依赖链。

硬规则：

- 命中该日志后，禁止把问题归因到模型下载或用户配置；先按打包缺依赖处理。
- 修复必须同时改两处：
  1. `electron-builder.json` 的 `asarUnpack` 覆盖缺失依赖及其直接依赖。
  2. `scripts/verify-mac-package.js` 把这些 unpacked 依赖列入必检项。
- 修完必须重新打包，不能只改源码让已安装旧包继续测试；旧 `/Applications/ChordVox.app` 不会自动获得新依赖。
- `node scripts/verify-mac-package.js --platform <mac|win|linux>` 必须能证明 `app.asar.unpacked/node_modules/tar/package.json` 和 `@isaacs/fs-minipass` / `chownr` / `minipass` / `minizlib` / `yallist` 存在。

3. 生成构建清单（manifest）

```bash
cd $HOME/Tools/ChordVox-IME/ChordVox-Pro
VERSION="1.5.31"
SOURCE_SHA="<Pro源SHA>"
REAL_DICTATION_VERIFIED_SHA="<同一Pro源SHA，且已通过 verify:release:dictation>"

VERSION="$VERSION" SOURCE_SHA="$SOURCE_SHA" REAL_DICTATION_VERIFIED_SHA="$REAL_DICTATION_VERIFIED_SHA" python3 <<'PY'
import glob, hashlib, json, os
from datetime import datetime, timezone

version = os.environ.get("VERSION", "")
source_sha = os.environ.get("SOURCE_SHA", "")
real_dictation_verified_sha = os.environ.get("REAL_DICTATION_VERIFIED_SHA", "")
files = sorted([p for p in glob.glob("dist/*") if os.path.isfile(p) and version in os.path.basename(p)])
for extra in ["dist/latest.yml", "dist/latest-mac.yml", "dist/latest-linux.yml"]:
    if os.path.isfile(extra):
        files.append(extra)

manifest = {
    "product": "ChordVox",
    "version": version,
    "tag": f"v{version}",
    "sourceRepo": "GravityPoet/ChordVox-Pro",
    "sourceSha": source_sha,
    "realDictationVerifiedSha": real_dictation_verified_sha,
    "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
    "assets": []
}

for path in files:
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    manifest["assets"].append({
        "name": os.path.basename(path),
        "sizeBytes": os.path.getsize(path),
        "sha256": digest
    })

with open("dist/release-manifest-macos-manual.json", "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
print("manifest written: dist/release-manifest-macos-manual.json")
PY
```

> 说明：
>
> - `dist/release-manifest-macos-manual.json` 仅用于手动发版时的本地溯源与验收。
> - 从本 SOP 起，该 manifest **不再上传到公开 GitHub Release**。

4. 手动发布到公开仓

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
TAG="v$VERSION"
REPO="GravityPoet/ChordVox"
cd $HOME/Tools/ChordVox-IME/ChordVox-Pro

cat > /tmp/chordvox_release_notes.md <<EOF2
# ChordVox v${VERSION}

## Highlights
更新亮点

English

- <customer benefit 1: what changed and why it helps>
- <customer benefit 2: what changed and why it helps>
- <customer benefit 3: what changed and why it helps>

中文

- <对应中文客户收益 1：改了什么，对客户有什么用>
- <对应中文客户收益 2：改了什么，对客户有什么用>
- <对应中文客户收益 3：改了什么，对客户有什么用>

## macOS First Launch
macOS 首次启动

English

Open the DMG, drag `ChordVox.app` to Applications, then open ChordVox from Applications. ChordVox uses a stable self-signed certificate and is not Apple-notarized, so each new Mac must approve the first launch in System Settings > Privacy & Security > Open Anyway. Only if it is still blocked, reopen the DMG and double-click `Fix & Open.command`; it only removes quarantine from the installed app and then opens ChordVox.

中文

打开 DMG，把 `ChordVox.app` 拖到 Applications，然后从 Applications 打开 ChordVox。ChordVox 使用固定自签名证书且未经 Apple 公证，因此每台新 Mac 首次安装都需要到“系统设置 > 隐私与安全性”选择“仍要打开”。只有仍打不开时，再回到 DMG 双击右侧 `Fix & Open.command`；它只会解除已安装 App 的隔离标记，然后打开 ChordVox。
EOF2

# 注意：release notes 必须直接写 Markdown。
# 注意：release notes 必须按“先完整英文块，再完整中文块”的双语顺序编写。
# 不要从 GitHub 页面复制渲染后的 HTML，例如 <h1> / <ul> / <li> / <div class="highlight"> 等。
# 公开 Release 说明必须保持用户视角，不要放 private repo、source SHA、internal manifest 等内部溯源信息。
# 品牌安全：不要用 Typeless / Wispr / superwhisper / Aqua Voice 等竞品口径描述 ChordVox 功能。

if grep -Eiq 'typeless|wispr|superwhisper|aqua[ -]?voice' /tmp/chordvox_release_notes.md; then
  echo "Brand-safety check failed: release notes contain competitor wording." >&2
  exit 1
fi

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release edit "$TAG" -R "$REPO" --title "ChordVox v${VERSION}" --notes-file /tmp/chordvox_release_notes.md
else
  gh release create "$TAG" -R "$REPO" --title "ChordVox v${VERSION}" --notes-file /tmp/chordvox_release_notes.md
fi

ASSETS=(
  dist/ChordVox-${VERSION}-arm64.dmg
  dist/ChordVox-${VERSION}-arm64.dmg.blockmap
  dist/ChordVox-${VERSION}-arm64.pkg
  dist/ChordVox-${VERSION}-arm64.pkg.sha256
  dist/ChordVox-${VERSION}-arm64-mac.zip
  dist/ChordVox-${VERSION}-arm64-mac.zip.blockmap
  dist/latest-mac.yml
)

UPLOAD=()
for f in "${ASSETS[@]}"; do
  if [ -f "$f" ]; then
    UPLOAD+=("$f")
  fi
done

if [ ${#UPLOAD[@]} -eq 0 ]; then
  echo "no assets found"; exit 1
fi

gh release upload "$TAG" "${UPLOAD[@]}" -R "$REPO" --clobber
echo "done: https://github.com/$REPO/releases/tag/$TAG"
```

5. 手动发版后的验收

```bash
gh release view "v$VERSION" -R GravityPoet/ChordVox --json url,assets
```

至少确认公开仓有：

- `ChordVox-${VERSION}-arm64.dmg`
- `ChordVox-${VERSION}-arm64.dmg.blockmap`
- 若本次发布 PKG：`ChordVox-${VERSION}-arm64.pkg`
- 若本次发布 PKG：`ChordVox-${VERSION}-arm64.pkg.sha256`
- `ChordVox-${VERSION}-arm64-mac.zip`
- `ChordVox-${VERSION}-arm64-mac.zip.blockmap`
- `latest-mac.yml`
- 若本次还有 Linux / Windows 手工补传，继续确认：
  - `latest-linux.yml`
  - `latest.yml`
  - `ChordVox-<VERSION>.exe`
  - `ChordVox-Setup-<VERSION>.exe`

---

## 3. 发布后验收清单

- Release 页面资产名称与版本号一致
- 本地生成的 `dist/release-manifest-macos-manual.json` 中 `sourceSha` 与 `realDictationVerifiedSha` 都与本次目标 SHA 一致
- 公开仓 Release 不上传 `release-manifest-macos-manual.json`
- 本机下载 DMG 并可启动
- 若是多平台手工补传，抽样检查公开下载 URL：

```bash
curl -L --range 0-0 -s -o /dev/null -w '%{http_code}\n' \
  "https://github.com/GravityPoet/ChordVox/releases/download/v${VERSION}/ChordVox-${VERSION}-arm64.dmg"
```

- 公开文案必须明确客户包使用固定自签名证书且未经 Apple 公证，并写清正常路径：打开 DMG，拖到 `Applications`，再从 `Applications` 打开；随后到“系统设置 > 隐私与安全性 > 仍要打开”完成每台新 Mac 的首次放行，仍打不开时才使用 DMG 右侧 `Fix & Open.command`。
- 不要把 `xattr` 终端命令写成客户主路径；终端命令只作为内部排障兜底留在 macOS Packaging SOP。

---

## 4. 覆盖已发布版本的注意事项

如果需要对**同一版本号**重新发布（hotfix 修复后重新打包）：

1. 上传资产必须加 `--clobber`，否则 `gh release upload` 会拒绝覆盖：

```bash
gh release upload "$TAG" "${UPLOAD[@]}" -R "$REPO" --clobber
```

2. `--clobber` 只覆盖同名资产，不会删除旧名称文件。复用 draft 时必须以本次暂存清单为准删除多余资产，再同时校验“无缺失、无多余”；`utm-manual` 自动阶段重跑后也要重新上传并验证 Windows 资产
3. 覆盖后 `latest-mac.yml` 的 `sha512` 和文件大小会变化，已安装用户的自动更新会重新下载
4. 覆盖后必须再次验收公开仓资产完整性

---

## 5. 踩坑记录索引

详细的已知坑和避免方式见 [`docs/MAC_PACKAGING_SOP.md` → 踩坑记录](MAC_PACKAGING_SOP.md#踩坑记录)。

关键条目：

- `electron-builder` 必须用 `npx` 前缀
- macOS 客户 DMG 必须通过 `scripts/build-mac-dmg.js`，不要绕过暖象牙色背景、拖拽标题、细箭头 Finder 布局
- `LSUIElement` 设为 `true` 会导致菜单栏图标不渲染
- blockmap 文件必须一起上传
- `--clobber` 只覆盖同名资产；旧名称资产必须显式删除

---

## 6. 发布失败记录（唯一台账）

这里仅保留会改变后续发版决策的根因和预防动作；平台操作细节仍按上面的文档路由进入对应 SOP。

| 日期       | 场景                         | 根因                                                                                                                                                                                                                             | 后续固定做法                                                                                                                                                                                                                                            |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-25 | macOS `.pkg` 验证            | 默认 verifier 优先命中了旧 DMG workdir                                                                                                                                                                                           | `.pkg` 必须显式传 `dist/mac-arm64/ChordVox.app`，且先删除同版本旧包。                                                                                                                                                                                   |
| 2026-06-25 | Actions 未启动               | 账单/额度在 runner 启动前熔断                                                                                                                                                                                                    | 查 check-run annotation；命中账单提示后不重复触发，转第 2 节手工 fallback。                                                                                                                                                                             |
| 2026-06-25 | 本地解析 workflow            | 系统 Python 没有 PyYAML；`gh run view` 字段应为 `attempt` 而非 `runAttempt`                                                                                                                                                      | 优先用 `gh`/REST 取证，不假定系统 Python 已安装 PyYAML。                                                                                                                                                                                                |
| 2026-06-25 | SOP 路由漏读                 | 旧 `mp-release` 先选了小写摘要，遗漏完整 fallback                                                                                                                                                                                | 仓库只保留本文件；`mp-release` 必须优先识别明确声明为 canonical 的 SOP。                                                                                                                                                                                |
| 2026-06-25 | Linux 安装依赖               | Darwin-only `electron-liquid-glass` 曾放在必装依赖                                                                                                                                                                               | 平台专属 native 包放 `optionalDependencies`，并在 Linux 真环境跑 `npm ci`。                                                                                                                                                                             |
| 2026-06-25 | Windows UTM 缺 FFmpeg        | `npm ci --ignore-scripts` 跳过 `ffmpeg-static` postinstall                                                                                                                                                                       | UTM 脚本必须显式运行安装脚本并验证 `ffmpeg.exe` 为 Windows PE/MZ。                                                                                                                                                                                      |
| 2026-06-26 | 创建 Release 偶发 EOF        | GitHub API 在存在性检查阶段断线                                                                                                                                                                                                  | 先用 `gh release view` + REST 复核 tag/release 是否存在，再幂等重试。                                                                                                                                                                                   |
| 2026-06-26 | UTM 拉取大文件               | guest agent 多文件 stdout 传输不稳定，留下 0B 文件                                                                                                                                                                               | 一次拉一个文件，主客机字节数一致后才可进入上传清单。                                                                                                                                                                                                    |
| 2026-06-26 | Linux fallback 缺 manifest   | 手工流程未强制生成平台 manifest                                                                                                                                                                                                  | 上传前生成并校验 `release-manifest-linux.json`，覆盖全部顶层客户资产。                                                                                                                                                                                  |
| 2026-06-26 | Windows NSIS 构建            | 自定义宏错误引用 electron-builder 内部 `$installationDir`                                                                                                                                                                        | 自定义 hook 使用同作用域的 NSIS `$INSTDIR`，真 Windows 重打并通过包验证。                                                                                                                                                                               |
| 2026-07-04 | macOS DMG staging            | 裸 `ditto` 复制扩展属性触发临时文件竞态                                                                                                                                                                                          | 只用仓库 macOS 构建脚本，其 staging copy 固定 `--norsrc --noextattr`。                                                                                                                                                                                  |
| 2026-07-04 | tag 枚举                     | 本机 Git 不支持 `git tag --count`                                                                                                                                                                                                | 使用 `git tag --sort --format`；只在展示层用 `head` 限行。                                                                                                                                                                                              |
| 2026-07-04 | Electron 本地依赖            | `node_modules/electron/dist` 曾只解压了一部分                                                                                                                                                                                    | release gate 前验证 `require("electron")`、framework、`path.txt` 和 Electron 版本。                                                                                                                                                                     |
| 2026-07-04 | macOS 启动 smoke             | 单行 AppleScript `if/else` 语法错误，且遗留 smoke 进程                                                                                                                                                                           | 使用多行 `osascript -e`，验收 `window_count=1` 后清理 smoke 进程。                                                                                                                                                                                      |
| 2026-07-04 | Actions Windows 包           | workflow 曾跳过 `prebuild:win`，导致 helper 缺失                                                                                                                                                                                 | 构建前运行 `prebuild:win`，打包前后都断言 Windows helper 和 native runtime。                                                                                                                                                                            |
| 2026-07-04 | Actions Linux 包             | workflow 曾跳过 `prebuild:linux` 和 native build deps                                                                                                                                                                            | runner 安装 `rpm/libx11-dev/libxtst-dev`，运行 prebuild，并验证 Linux helper。                                                                                                                                                                          |
| 2026-07-04 | Actions macOS 包             | Apple 签名/公证凭据缺失                                                                                                                                                                                                          | 历史方案曾允许 ad-hoc fallback；现已由固定 ChordVox 自签名证书取代，workflow 缺少同一 P12 时直接熔断，禁止重新生成身份。                                                                                                                                |
| 2026-07-04 | Windows 资产名               | GitHub 规范化含空格文件名，旧 metadata 与上传名不一致                                                                                                                                                                            | 生成 manifest 和上传前先规范化 installer/portable/blockmap 文件名。                                                                                                                                                                                     |
| 2026-07-04 | Release 重跑                 | 旧 workflow 重跑会用模板覆盖人工润色 notes                                                                                                                                                                                       | 已存在 Release 只更新标题/资产，不覆盖正文；缺失 Release 才使用模板。                                                                                                                                                                                   |
| 2026-07-04 | 发布文案                     | 曾从 commit 主题推导出运行时关闭的功能                                                                                                                                                                                           | 文案必须核查 runtime flag、UI 可见性和真实资产，并以前一公开版本为最低质量基线。                                                                                                                                                                        |
| 2026-08-25 | GitHub 运行检查取证          | `gh run view --json annotations` 不是受支持字段，直接请求会失败；提交 annotation 路径也可能返回 404                                                                                                                              | 用 `gh run view --json jobs,headSha,status,conclusion` 和 `gh api repos/<owner>/<repo>/commits/<sha>/check-runs` 取证；仅在 runner 未启动且 job 为 0 步时按账单/runner 门禁处理。                                                                       |
| 2026-07-13 | v1.5.131 格式门禁            | `verify:ci` 通过，但单独的 `format:check` 发现 34 个既有漂移文件                                                                                                                                                                 | 发版前独立运行 `format:check`；只机械格式化报告文件，再重跑完整 CI，禁止把格式化成功当作功能验收。                                                                                                                                                      |
| 2026-07-13 | v1.5.131 Actions 未启动      | check-run annotation 明确报告付款失败或 spending limit，runner id 为 0、steps 为空                                                                                                                                               | 以 annotation 裁决；不重复触发，转手工三端，Windows 使用 UTM 真 Windows。                                                                                                                                                                               |
| 2026-07-13 | fallback 缓存失真            | VPS `/tmp` 脚本已消失，UTM 脚本和源码仍指向旧版本                                                                                                                                                                                | 文档只记录稳定路径，不再声称“当前已预热”；每轮验证脚本、SHA、版本和依赖，失配即重铺。                                                                                                                                                                   |
| 2026-07-25 | macOS UI 完成交付规则        | 新增安装成品验收规则后，`npx prettier --check docs/MAC_PACKAGING_SOP.md` 报格式漂移                                                                                                                                              | 编辑发布 SOP 后立即对目标文件运行 Prettier，再通过 `prettier --check` 和 `git diff --check` 才提交。                                                                                                                                                    |
| 2026-07-25 | macOS 本地原子安装           | `install:mac:local` 的隐藏 staging 路径缺少 `.app` 后缀；复制后的主二进制虽与源包逐字节一致，`@electron/fuses` 仍因 bundle 路径语义错误而报找不到 sentinel                                                                       | staging 与 displaced 路径固定保留 `.app` 后缀，并用回归断言锁定；修复后必须重跑原安装命令和安装成品 verifier。                                                                                                                                          |
| 2026-07-25 | 安装器格式检查               | 将 Bash 安装器与 TypeScript 测试一起交给 Prettier，前者报 `No parser could be inferred`，后者报告格式漂移                                                                                                                        | Bash 安装器使用 `bash -n`（有 `shellcheck` 时再追加），Prettier 只检查支持的 TypeScript 文件。                                                                                                                                                          |
| 2026-07-25 | 安装成品真实语音验收         | 正式包禁用 E2E 音频注入；固定 WAV 即使绕过 Chromium 沙箱也可能只走到 `processing` 后无转录，不能据此冒充真实语音通过                                                                                                             | 先断言页面来自 `/Applications/ChordVox.app/.../app.asar` 且 E2E hook 为 `undefined`；未在独立接收端得到目标文本就记为未通过。安装包 renderer 字节可用确定性 E2E 另验，真实麦克风链路仍须独立做人工/真音频门禁。                                         |
| 2026-07-25 | 星云成功态截图取证           | 透明 Electron 浮窗的成功态很短；Playwright 截图会错过窗口，macOS 窗口截图又可能得到全透明帧                                                                                                                                      | 不把某个固定毫秒数或单张瞬态截图当作产品硬门禁；验收 `safePaste()` 成功后的完整 DOM 时间线、无对号/SVG/方块/绿色徽章、单次引力波、极少星尘、计算样式与分阶段视觉取样，独立粘贴接收端另行证明文本落点。                                                  |
| 2026-08-13 | 星云关闭按钮命中区           | 星云按钮的透明宽布局盒覆盖关闭按钮的视觉位置，Playwright 点击时由 `.dictation-mic--nebula` 截获，出现“按钮有时无反应”                                                                                                            | 宽布局容器设为 `pointer-events: none`，只让可见 `.dv-capsule` 接收命中；关闭控件验收必须先用 `elementFromPoint` 证明中心命中自身，再执行真实点击，并在安装成品上重跑。                                                                                  |
| 2026-07-25 | 安装成品 QA 设置回滚         | 测试设置只保存在进程内存备份，强制中断抓帧会绕过 `finally`，留下测试路由                                                                                                                                                         | 临时改本机正式 profile 前，把允许列表内的原值写入权限 `0600` 的临时备份并注册 `SIGINT`/`SIGTERM` 恢复；结束时逐键比对后再删备份。若没有回滚断言，不得宣告验收完成。                                                                                     |
| 2026-07-25 | TextEdit 粘贴接收端          | 仅检查 TextEdit 的 front document 不能证明系统焦点仍在 TextEdit；停止指令可能造成前台窗口竞争                                                                                                                                    | 粘贴前同时断言目标文档名和 System Events 的 frontmost process；成功态与接收端文本分别取证，不能用“粘贴 API 返回成功”替代目标文本检查。                                                                                                                  |
| 2026-07-25 | LaunchServices 唯一性验收    | 已卸载 DMG 和已删除构建包仍可能保留历史注册；对不存在路径执行精确 `-u`、`-gc`，甚至只读重挂载后注销，也不一定立即清掉缓存                                                                                                        | 不为清历史缓存执行全局 LaunchServices 重置；先保证文件系统、Spotlight、挂载卷和正式进程唯一，再强制注册 `/Applications/ChordVox.app`，并把不可访问的历史记录明确标为缓存残留。                                                                          |
| 2026-07-25 | 安装成品临时 QA 脚本         | 放在 `/tmp` 的 ESM 脚本直接 `import "playwright"` 时，Node 从临时脚本目录向上解析，报 `ERR_MODULE_NOT_FOUND`，不会自动使用仓库 `node_modules`                                                                                    | 临时 QA 脚本使用 `createRequire(<repo>/package.json)` 显式从仓库解析 Playwright；模块加载失败后必须确认测试 App 已退出、临时 profile 已清理，并用正常参数恢复唯一 `/Applications/ChordVox.app` 进程。                                                   |
| 2026-07-25 | 安装成品 CDP 页面与清理      | 安装包 renderer 的真实 URL 是 `app.asar/src/dist/index.html`；当前 `?panel=true` 才是设置/首次启动控制面板，无 query 页面是听写浮层，空闲时正文可为空；仅终止启动命令返回的 PID 还可能留下 QA 子进程                             | 先从 `/json/list` 读取全部真实 URL，并按 query 对应的产品 surface 验收：首次启动/设置检查必须选 `panel=true`，听写检查才选无 query 页面；清理时按精确 `--user-data-dir` 枚举主进程和子进程，全部退出后删除隔离 profile，不触碰正常安装实例。            |
| 2026-07-25 | 安装成品 CDP 设置注入        | 在已连接的安装成品 renderer 上写完隔离设置后直接 `page.reload()`，目标页导航后被主进程销毁，Playwright 报 `Target page, context or browser has been closed`                                                                      | 使用同一临时 `--user-data-dir` 做两阶段冷启动：首进程只写允许列表内设置并完整退出，第二进程从该 profile 冷启动后再验收；禁止把开发态 `page.reload()` 假设套到安装成品 BrowserWindow 生命周期。                                                          |
| 2026-07-25 | TextEdit QA 文档定位         | 当前 TextEdit 新建未命名文档后读取 `id of document` 报 AppleScript `-1728`，以文档 id 保存回滚句柄不可用                                                                                                                         | 给 QA 文档写入隔离标记并保存其唯一文档名；停止录音前同时断言 TextEdit 是 frontmost process 且前台文档名吻合，读取与关闭都按该名称精确定位，不关闭用户其他文档。                                                                                         |
| 2026-07-25 | 安装包 `app.asar` 混合 QA    | 用仓库 Electron 直接加载安装包 `app.asar` 时，`process.resourcesPath` 仍指向仓库 Electron；会把包内存在的 `bin/macos-globe-listener` 误报为缺失并弹出警告                                                                        | 该路径只验 renderer 字节，不得作为 native helper 证据，且不能在用户可见会话中运行；helper 必须由 `/Applications/ChordVox.app/Contents/MacOS/ChordVox` 真实启动后，以实际子进程、架构、执行权限和签名联合验收。                                          |
| 2026-07-25 | 生产 Electron 自动化握手     | 对已打包可执行文件使用 Playwright `_electron.launch({ executablePath })` 会因生产 fuse/主进程调试边界卡在握手并最终超时                                                                                                          | 用真实可执行文件加隔离 `--user-data-dir` 和 `--remote-debugging-port=0` 启动，从 `DevToolsActivePort` 读取端口后 `connectOverCDP`；只控制 renderer，并用 OS 进程证据验 native helper，结束后精确终止 QA 进程并恢复唯一正常进程。                        |
| 2026-08-16 | 私有/公开双 remote 标签预检  | `git fetch public --tags --prune` 报 `would clobber existing tag`；随后 SSH `ls-remote` 偶发 `Connection closed ... port 443`                                                                                                    | 私有源与公开快照仓复用版本 tag，但允许指向不同提交。只把 `origin` tag 拉入本地；公开仓碰撞检查改用 `git ls-remote`，SSH 中断时用 `gh api` / `gh release view` 只读复核，禁止导入、删除或覆盖公开 tag。                                                  |
| 2026-08-16 | v1.5.132 格式门禁            | `npm run format:check` 报 3 个测试文件 `Code style issues found`，ESLint 已通过                                                                                                                                                  | 只对 `macLlamaRuntimePackaging.test.js`、`reviewFixes.test.ts`、`windowConfig.test.js` 执行 Prettier，然后重跑 `format:check` 与完整 `verify:ci`；版本 tag 只能在两道门禁都通过后创建。                                                                 |
| 2026-08-25 | v1.5.133 格式门禁            | `npm run format:check` 在版本提交前报告 17 个源码/测试/样式文件存在漂移                                                                                                                                                          | 只对该次输出列出的 17 个文件运行仓库锁定版本的 Prettier，再重跑 `format:check` 与完整 `verify:ci`；格式化不得扩大到未报告文件。                                                                                                                         |
| 2026-08-25 | v1.5.133 版本断言            | `verify:ci` 的 `proprietaryPackaging.test.ts` 仍把包版本固定为 `1.5.132`，导致 536/537 测试通过但 CI 退出                                                                                                                        | 版本递增后同步更新发布边界测试的期望值，再从头重跑 `verify:ci`；禁止用跳过测试或只跑单文件替代完整门禁。                                                                                                                                                |
| 2026-08-25 | 发布提交索引权限             | 沙箱内执行 `git commit` 创建 `.git/index.lock` 报 `Operation not permitted`，索引未被修改                                                                                                                                        | Git 写入必须在允许仓库 `.git` 的提权执行范围内完成；重试前先检查 `git status --short --branch`，确认没有残留 lock 或部分暂存。                                                                                                                          |
| 2026-08-16 | v1.5.132 本地 Node 版本      | 系统 Node 26 执行 `npm ci` 时，`better-sqlite3@12.9.0` 报 `EBADENGINE`，而 Release workflow 固定 Node 22 + npm 11.9.0                                                                                                            | 不修改依赖也不执行破坏性 audit fix；用一次性 `npx -p node@22 -p npm@11.9.0` 解析工具链 bin 目录并前置到 `PATH`，再直接执行发布命令，同时记录 Node/npm 版本，保持与 Actions runner 一致。                                                                |
| 2026-08-16 | v1.5.132 高危依赖审计        | `npm audit --omit=dev --json` 报 `electron-updater` / `builder-util-runtime` / `js-yaml` 3 个生产 high；完整审计还包含 Electron 和认证/构建链 high                                                                               | 对齐官方已修复版本：Electron 41.10.5、electron-updater 6.8.9、electron-builder 26.15.3、PostCSS 8.5.26，并更新既有 `better-auth` override 与可兼容传递依赖；完整 `npm audit` 归零后，把 `npm audit --audit-level=high` 加入 Release workflow 常驻门禁。 |
| 2026-08-16 | v1.5.132 真实听写执行器      | 外层 `npx -p node@22 -p npm@11.9.0 -c 'npm run verify:release:dictation'` 已识别 WAV、模型和 SHA，但内层 `npx playwright` 报 npm `EUSAGE`                                                                                        | 根因是嵌套 npm exec 上下文冲突，不是听写链路失败。只用外层 `npx` 解析 Node 22/npm 11.9 的 bin 目录，前置 `PATH` 后直接重跑原始命令；发布脚本内含 `npx` 时禁止再用 `npx -c` 包裹。                                                                       |
| 2026-08-16 | v1.5.132 DMG blockmap        | 升级到 electron-builder 26.15.3 后，DMG 本体、签名和布局均通过，但脚本硬编码的 `node_modules/app-builder-bin/...` 已不存在，`spawnSync` 返回 `status: null`，更新 blockmap 缺失                                                  | 26.15.3 已把 blockmap 生成迁到 `app-builder-lib` 的流式 `buildBlockMap`；脚本改为直接调用当前锁定构建库的 `buildBlockMap(input, "gzip", output)`，并断言输出存在且非空，测试同时禁止恢复已移除的 `app-builder-bin` 路径。                               |
| 2026-08-16 | v1.5.132 Linux 质量门禁      | macOS 本地 447 项测试全过，但 Ubuntu runner 上 `windowManagerPreparation.test.js` 的 3 个用例无条件断言 `setOpacity(0)`；生产代码只在 `process.platform === "darwin"` 时执行该防闪烁分支                                         | 测试按真实平台契约断言：macOS 必须调用 `setOpacity(0)`，非 macOS 必须不调用，同时所有平台仍须断言布局 resize、`showInactive()` 和锚点恢复；修复后必须让 Linux Release quality gate 实际通过，不能只凭 macOS 本地结果。                                  |
| 2026-08-16 | v1.5.132 Actions macOS 签名  | 固定 P12 已成功导入临时 keychain，但 `security add-trusted-cert` 写用户信任域时在无界面 macOS runner 阻塞；两个架构都停在证书导入后的同一位置                                                                                    | 固定证书改用 `sudo -n` 写入 runner 的临时系统信任域，按证书 SHA-1 在 `always()` 清理；P12、证书和客户包签名身份仍为同一固定 ChordVox 自签名，不生成新身份、不退回 ad-hoc，且授权失败必须立即报错而不是等待 GUI。                                        |
| 2026-08-16 | v1.5.132 Windows llama 启动  | `llama.cpp b10448` 的 `llama-server.exe` 已变为依赖 `llama-server-impl.dll` 的启动壳，后者还依赖 `llama-common.dll`；旧 owned-library 过滤器未收录这两个新 DLL，客户包启动验收以 `0xC0000135` 退出                               | 将两个 DLL 纳入 owned 与 required 清单，缓存键随下载脚本变化自动失效；单测锁定只打入服务端依赖而不带其他工具实现 DLL，Windows runner 仍必须实际执行打包后 `llama-server --help`，禁止只凭 PE 架构检查放行。                                             |
| 2026-08-16 | v1.5.132 macOS x64 Node      | macOS runner 是 arm64；`TARGET_ARCH=x64` 被 `--current` 的 `process.arch` 覆盖，Intel 包因此混入 `darwin-arm64/bin/node`，包级架构门禁拦截                                                                                       | `--current` 只表示选择单一当前构建目标，不得覆盖 `TARGET_PLATFORM` / `TARGET_ARCH`；显式 `--platform` / `--arch` 仍有最高优先级。用 arm64 宿主 + x64 目标单测锁定交叉构建契约，真实 x64 Runner 包仍须通过递归 Mach-O 架构验收。                         |
| 2026-08-16 | v1.5.132 Windows llama 清理  | 新增 DLL 已下载并安装，但通用 `cleanupFiles(..., "llama-server", ...)` 把 `llama-server-impl.dll` 误判为旧平台 server 并立即删除，最终包仍缺该依赖                                                                               | llama runtime 不再使用宽前缀清理；只通过平台感知的 `getConflictingServerPaths` 删除同平台错误架构的 server 可执行文件。回归用 `llama-server-win32-arm64.exe` 与 `llama-server-impl.dll` 同目录证明只删前者，真实 Windows 启动门禁继续保留。             |
| 2026-08-16 | v1.5.132 重复 macOS CI 签名  | push 自动触发的 `build-and-notarize.yml` 仍使用用户信任域写入，在无界面 Runner 阻塞并占用唯一 macOS 并发；正式 Release 的两个 macOS 作业因此长期保持 `runner_id=0` 排队                                                          | 自动验证与正式 Release 必须复用同一固定证书信任契约：`sudo -n` 写系统信任域、按证书 SHA-1 在 `always()` 清理；确认正式流程已修复后取消卡死的重复验证运行以释放 Runner，禁止取消已成功的正式 Release 平台作业。                                          |
| 2026-08-16 | v1.5.132 Actions 额度门      | 正式 Release 全部成功并公开后，维护提交的质量门仍通过，但四个平台作业均在创建 Runner 前以 0 步骤失败；check-run 注释明确要求处理近期付款失败或提高 spending limit                                                                | 0 步骤且四平台同文失败属于 GitHub 账户计费门，不得误判为代码回归或盲目重跑；保留已成功 Release 证据，记录未启动的后续验证边界，并在下次需要云端构建前由仓库所有者处理 Billing & plans。                                                                 |
| 2026-08-17 | v1.5.132 Linux helper ABI    | 旧公开 AppImage 内 `linux-fast-paste` 最高要求 `GLIBC_2.38`，高于 Ubuntu 22.04 的 `GLIBC_2.35`，导致同版 Linux 客户包无法执行快速粘贴 helper                                                                                     | Linux helper 固定在 Ubuntu 22.04 构建；包级 verifier 强制 x86_64 ELF 且最高 GLIBC 不超过 2.35。重打的四种封装均内含同一个 `GLIBC_2.34` helper，并在 Xvfb 中收到完整 `Ctrl+Shift+V` 事件序列后才允许覆盖。                                               |
| 2026-08-17 | v1.5.132 手工预检命令        | `gh release view --json title` 报未知字段，过度转义的 `node -p` 报 `Expected unicode escape`，远端 `dpkg-query -f="${Status}"` 被 `set -u` 抢先展开；另有猜测 verifier/源码路径和未引用 zsh glob 导致文件不存在或 unmatched glob | Release 标题字段固定用 `name`；版本读 `jq -r .version package.json`；远端命令用单引号 heredoc 或转义 `$`；任何脚本/源码路径先用 `rg --files` 与 `package.json` scripts 发现，禁止凭名称猜测。                                                           |
| 2026-08-17 | v1.5.132 真实听写前台焦点    | 首轮真实听写已完成真实转录、paste success 和历史保存，但用户同时在 Codex 前台交互，接收端 `sinkHasText=false`，形成粘贴落点假失败                                                                                                | 先核对细分事件与 frontmost process；只有接收端失焦时在无前台交互窗口重跑。第二轮 5.1 秒通过并输出精确 `real_dictation_verified_sha=ce62557658422c6dd484f65584fdbea44601ca5a`。                                                                          |
| 2026-08-17 | v1.5.132 VPS 长任务续接      | rpm 压缩期间新的 SSH 查询两次报 `Connection closed ... port 22`；跨日后本地 `write_stdin` 又报 `Unknown process id 94806`，但 VPS 上打包进程和四个成品实际均未中断                                                               | 不重启长构建；间隔后重连，以进程与 `dist/` 字节数裁决。若成品已齐，只单独重跑 `verify:linux:package` 获取新鲜终态，本轮 verifier 明确通过。                                                                                                             |
| 2026-08-17 | v1.5.132 AppImage 残留检测   | 首轮 15 秒冒烟中，`awk` 命令行自身含 `--type=` 判断文本，被自己的过滤器误报成残留进程；应用主进程实际已退出                                                                                                                      | 残留扫描改为从环境变量读取隔离 profile 的 `/proc/*/cmdline` 检查并跳过自身 PID。重跑后主进程存活 15 秒、退出码 0、残留 0、无 crash/Fatal，且日志识别 Whisper、FFmpeg、sherpa-onnx。                                                                     |
| 2026-08-17 | v1.5.132 回滚包备份与清理    | Mac 直接下载约 800 MB 旧 Linux 资产速度过慢；中断后的半包无法用受限环境直接 `rm -rf`；HTTP 下载的旧 AppImage 还因无执行位在解包时先报 `Permission denied`；终态检查又把额外的 `SHA256SUMS` 误算成第七个资产                      | 在 VPS 完整备份六个旧资产并保留 `SHA256SUMS`，用明确资产名集合加 `sha256sum -c` 验收，不用目录普通文件总数代替资产数；Mac 半包移入废纸篓保留可恢复性。AppImage 测试前只补执行位并再次核对 SHA，不能把权限位缺失误判为内容损坏。                         |
| 2026-08-17 | v1.5.132 Linux 更新元数据    | 首次校验 `latest-linux.yml` 时用不带层级范围的 `awk '$1 == "size:"'` 取最后一个 `size`，误拿到 RPM 大小并以 exit 1 结束；AppImage 与公开 SHA256 实际一致                                                                         | 顶层 `path` / `sha512` 必须用行首锚定，`files[]` 中 AppImage 的 `sha512` / `size` 必须限定在对应 `url` 到下一个 `url` 的块内，再与公开下载文件实际 SHA512 和字节数比对。                                                                                |
| 2026-08-17 | v1.5.132 AppImage FUSE 直跑  | Ubuntu 22.04 VPS 有 `/dev/fuse`，但未安装 `libfuse2`；只跑 `--appimage-extract` 后的 `AppRun` 不能证明客户下载的 AppImage runtime 能直接挂载                                                                                     | 将 Ubuntu 官方 `libfuse2` 仅下载并解到临时目录，通过单次 `LD_LIBRARY_PATH` 直接启动公开 AppImage；15 秒时 FUSE 挂载存在，主进程退出码 0，随后挂载 0、残留 0、crash 0、Fatal 0，宿主未永久安装系统包。                                                   |
| 2026-08-17 | v1.5.132 UTM Guest Agent     | Windows Update 期间 `utmctl` 一度无法连接 Guest Agent；恢复后 `utmctl exec` 又会先返回 0，而真实结果文件稍后才出现                                                                                                               | 先看 VM 画面并有界等待更新恢复，不强制重启；所有远程动作写日志、退出码和带新时间戳的 `*.done`，宿主机轮询真实完成状态。                                                                                                                                 |
| 2026-08-17 | v1.5.132 Windows 交互 QA     | 长 inline PowerShell/`cmd` 被多层引号拆坏；计划任务 XML 用 UTF-8/无 BOM 时导入失败；NSIS/portable GUI 外层返回不等于安装或启动完成                                                                                               | 推固定 `.cmd`/`.ps1`；交互任务 XML 使用 UTF-16LE BOM + `InteractiveToken`；以安装目录、卸载注册表、真实进程、CDP 端口和完成标记联合验收，结束后删除临时任务。                                                                                           |
| 2026-08-17 | v1.5.132 Windows 法律文本    | macOS 拆公开 Windows portable 时，包内 `LICENSE`/`NOTICE` 为 CRLF、仓库原文为 LF，原 verifier 按原始 SHA256 误报正文不一致                                                                                                       | verifier 仅对法律文本归一化 CRLF/LF 后比较，并用单测证明实质文字变化仍失败；公开 portable 原包随后完整通过 Windows 包级校验。                                                                                                                           |
| 2026-08-17 | v1.5.132 Windows ARM 推理    | 4 GB Windows 11 ARM UTM 通过 x64 兼容层运行公开包时，Parakeet sidecar 在完整 Electron 应用内超过 60000ms 启动门槛；同一发布二进制独立运行能 `Listening on`，固定 WAV 1.886 秒得到非空英文转写                                    | 以 `PROCESSOR_IDENTIFIER` 识别 Windows ARM 宿主，只把 Parakeet 启动门槛扩到 120000ms；native Windows x64 和非 Windows 仍保持 60000ms。重新在 UTM 公开包客户路径中验证模型冷启动与固定 WAV 真推理，禁止用静态可用性代替。                                |
| 2026-08-25 | v1.5.133 Release runner      | 正式 Release run `32787185788` 在 `resolve-release` 前即以 `runner_id=0`、0 steps 失败；不是代码步骤失败，而是账户 runner/billing 门禁。                                                                                         | 不盲目重跑；保留 run/jobs/check-runs 证据，转本地 macOS + UTM Windows + 授权后的 Linux fallback，并在公开 Release 中分开标注平台证据。                                                                                                                  |
| 2026-08-25 | v1.5.133 macOS Whisper 下载  | `prebuild:mac:customer` 在 Whisper TLS 握手处断线；缓存中的已校验二进制可用，直接走 `build:mac:dmg` 后包级校验通过。                                                                                                             | 下载失败先检查目标架构缓存和 SHA；缓存完整时不得把网络瞬断当成包坏，也不得重复下载覆盖已校验资源。                                                                                                                                                      |
| 2026-08-25 | v1.5.133 x64 llama 资产      | llama.cpp 最新 release API `v0.2.0` 没有匹配 macOS x64 资产；改用官方 `b10549`，并完成二进制/依赖架构和 `--help` 校验。                                                                                                          | macOS 交叉构建固定记录 llama 版本；最新标签缺资产时只允许选择官方存在且可校验的 pinned release，不修改下载器绕过架构校验。                                                                                                                              |
| 2026-08-25 | v1.5.133 x64 资源串架构      | 在同一 `resources/bin` 目录交替构建 x64/arm64 时，第一次 x64 重建混入 arm64 Node/Whisper，包级递归 Mach-O 校验拦截。                                                                                                             | 每次交叉构建前隔离目标架构资源，构建后运行 `verify-mac-package.js`；不要依赖目录残留或只看主二进制架构。                                                                                                                                                |
| 2026-08-25 | v1.5.133 交叉构建 shell      | 临时移动资源时把 zsh 变量命名为 `path`，覆盖了 `PATH`，导致同一段清理命令出现 `mv: command not found`；没有改坏仓库内容。                                                                                                        | shell 局部变量禁止使用 `PATH`/`path` 等环境变量名；移动前后都用绝对 `/bin/mv`，并检查 `git status` 与资源架构。                                                                                                                                         |
| 2026-08-25 | v1.5.133 macOS 焦点门禁      | 旧门禁在安装版把指针停在透明 nebula 布局盒，并在 always-on-top 面板仍可见时激活粘贴目标，分别造成 `data-close-ready=null` 和“窗口焦点”误报。                                                                                     | 门禁短暂激活原生窗口、移动到真实 `.dv-capsule` 命中面并在 React 重渲染后重试；激活粘贴目标前先隐藏面板/关闭交互。修复后安装版固定 WAV、受信任点击、独立粘贴全部通过。                                                                                   |
| 2026-08-25 | v1.5.133 x64 CDP 启动        | 受限沙箱下直接由 arm64 Node 启动 x64 包时，临时门禁未得到 loopback CDP；提升权限后同一包的真实固定 WAV/粘贴门禁通过，说明是运行环境权限/架构启动条件而非包内转录失败。                                                           | macOS packaged gate 失败先检查权限、Rosetta 和残留进程；不得把 CDP 握手失败写成“听写失败”，但必须保留失败上下文并在受控环境重跑一次。                                                                                                                   |
| 2026-08-25 | v1.5.133 测试会话句柄        | 一次 macOS packaged 门禁的外层会话句柄提前消失；随后检查到同源 evidence 已是完整通过且无残留进程，未盲目重复运行。                                                                                                               | 会话丢失按“重连/读 evidence/查精确进程”处理；只有证据缺失或进程残留才重跑，禁止用重复测试覆盖未知状态。                                                                                                                                                 |
| 2026-08-25 | v1.5.133 x64 证据字段        | x64 包在 Apple Silicon 主机上运行门禁时，证据 `arch` 来自测试宿主 Node（arm64），不是被测包架构；包级 `file/lipo` 校验仍明确为 x86_64。                                                                                          | 发布 manifest 的平台字段以实际包目标架构为准；后续让测试证据从被测可执行文件读取架构，避免把宿主架构写入运行证据。                                                                                                                                      |
| 2026-08-25 | v1.5.133 Linux fallback 权限 | 将私有源码归档传到 `$NOTRACE_VPS_HOST` 的 fallback 命令被安全边界拦截；当前没有得到“允许本次源码外传”的明确授权，因此没有创建远端构建目录或上传源码。                                                                                  | 只读检查 VPS 工具链并保留本地脚本；需要 Linux 资产时必须先获得一次性、限定用途的源码传输授权，再按 SHA 校验、构建、真实听写和清理闭环执行。                                                                                                             |
| 2026-08-25 | v1.5.133 本机启动误报        | 用 staging 包执行 `--version` 实际会启动 Electron 主进程并抢占同一 userData 的单实例锁，残留进程使 `/Applications/ChordVox.app` 看起来无法打开。                                                                                 | 架构检查只用 `file`/`lipo`/静态 ASAR 验证；需要运行包时必须使用隔离 `--user-data-dir`，并在结束前确认 staging 进程树已退出。                                                                                                                            |
| 2026-08-25 | v1.5.133 Windows UTM 构建    | 首轮 wrapper 缺少 `call`、资源 staging 路径错误、漏跑 `build:electron`，随后旧 llama 归档缺少 b10549 的实现 DLL；均在客户资产上传前被门禁拦截。                                                                                  | Windows wrapper 固定 `call`、绝对 staging 根、renderer/electron 双构建和 b10549 依赖清单；包级 verifier 必须先通过再进入 Authenticode 与真实听写。                                                                                                      |
| 2026-08-25 | v1.5.133 Windows 签名时间戳  | Digicert 时间戳服务在一次完整打包中瞬时失败；重试时签名与 RFC3161 探针均通过，证明不是证书或包内容问题。                                                                                                                         | 保留证书验证和至少一个 RFC3161 探针证据；时间戳服务瞬时故障只允许一次受控重试，不得用无时间戳签名绕过发布门禁。                                                                                                                                         |
| 2026-08-25 | v1.5.133 Windows PowerShell  | Windows PowerShell 5.1 没有 .NET Core 的 `Path.GetRelativePath`，导致 Authenticode 验证在签名已通过后自我失败。                                                                                                                  | verifier 使用 PowerShell 5.1 兼容的路径截取实现，并在真实 UTM 运行后再执行 packaged dictation；不能把测试脚本兼容错误判为签名失败。                                                                                                                     |
| 2026-08-25 | v1.5.133 UTM 清理边界        | Windows 真实听写证据尚未写出时，直接删除 `C:\ChordVoxBuild` 会同时删除待验收产物；宿主机空间充足，未提前清理。                                                                                                                   | 先拉取并校验安装包、签名证据和真实听写 evidence，再只删除本轮明确列出的构建目录、缓存、临时归档和测试凭据，保留 VM 系统与用户文件。                                                                                                                     |
| 2026-08-25 | v1.5.133 公开 tag 隐私门禁   | 私有仓库完整历史包含 `.agents` / Playwright 状态等本机文件，公共推送 hook 还把 Cloudflare 类型声明误报为地址；直接推送完整历史会扩大公开面。                                                                                     | 公开仓只发布经路径审计的单提交源码快照，保留产品树和 `sourceSha` 清单，不把私有历史或本机状态带到 public；仅在隔离快照已确认无敏感路径/高风险 token、且逐行确认误报后，绕过该快照仓库 hook。                                                            |
| 2026-08-25 | v1.5.133 UTM 历史垃圾        | 专用 Windows VM 的 `C:\Users\Public` 累积多轮旧源码包、构建日志、探针和测试证书，清理前客户机仅约 10.6 GB 可用。                                                                                                                 | 先转移并校验本轮客户资产，再按明确前缀删除 308 个内部临时项目（约 443 MB）及构建目录；最终确认构建目录和前缀残留为 0，客户机可用空间约 11.7 GB。                                                                                                        |
