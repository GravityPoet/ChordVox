# macOS Packaging SOP

## Goal

Ensure every desktop package:

- contains required native helper binaries
- contains required runtime modules
- does not regress into "launches then immediately crashes"
- proves the exact pinned self-signed identity without claiming Apple notarization

## Release position

This packaging SOP sits under the unified release rule:

1. First choice is GitHub Actions.
2. `main` customer release uses the formal release workflow.
3. Non-`main` branches should prefer GitHub Actions preview artifacts.
4. Manual macOS packaging is a fallback path, not the default release path.

## Required build commands

### macOS local test package

```bash
npm run build:mac:test
```

This compatibility command uses the same pinned `ChordVox Local Code Signing` identity as customer releases. It must never fall back to ad-hoc signing.

Before the first local build, or after restoring the encrypted signing backup, run:

```bash
npm run setup:mac:signing
```

The setup command verifies that the login-keychain identity matches `resources/mac/chordvox-local-signing.crt` and proves that two different binary contents produce the same certificate-bound designated requirement. It will not generate a replacement identity after the public certificate is pinned.

To install the freshly packaged local app, use the repository installer instead of manually overwriting `/Applications`:

```bash
npm run install:mac:local
```

The installer verifies the pinned signature before staging, after staging, and after installation; creates and validates a permission-`0600` ZIP rollback under `~/Library/Application Support/Codex/Backups/ChordVox/AppRollbacks.noindex`; atomically replaces `/Applications/ChordVox.app`; restarts the canonical app; and removes the build-directory `.app` copy. It opens Accessibility settings only when the old and new designated requirements differ. Repeated updates with the same certificate must report `ACCESSIBILITY_REGRANT_REQUIRED=0`.

This now uses `scripts/build-mac-dmg.js` as the default stable packaging path:

1. build `zip` artifacts into `dist/.mac-dmg-work`
2. run `scripts/verify-mac-package.js` against the fresh `.app`
3. write the macOS-only `Fix & Open.command` helper into the DMG staging folder
4. generate a unique temporary `dmg` via plain `hdiutil create`
5. write the ChordVox gradient Finder background, drag-to-Applications arrow layout, and blocked-launch helper hint into the mounted DMG
6. verify that temporary `dmg`
7. atomically promote it to the canonical `dist/ChordVox-<VERSION>-arm64.dmg`

This bypasses the old `dmg-builder -> hdiutil detach` race that kept failing with `Resource busy`.
It also avoids writing `hdiutil create` directly into a previously used canonical filename, which can be held briefly by Finder / Quick Look / Spotlight on macOS.
The visual installer window is still produced by `scripts/build-mac-dmg.js`; do not re-enable `dmg-builder` just to change the background.

`Fix & Open.command` is macOS-only. It calls `sudo xattr -rd com.apple.quarantine /Applications/ChordVox.app` and then `open /Applications/ChordVox.app`; do not copy this helper, its wording, or its troubleshooting path into Windows or Linux packages.

## DMG UI inspection hierarchy

Before using a screenshot, classify the UI target:

1. Electron / Web UI: inspect with Playwright or Electron APIs first. Read DOM, renderer state, main-process state, IPC logs, and element locators before considering screenshots.
2. Native macOS app UI: inspect with Accessibility tree, AppleScript, or System Events first when available. Use semantic windows, buttons, labels, and menu items instead of pixel guessing.
3. DMG Finder installer window: treat it as Finder rendering, not ChordVox UI. There is no app DOM. Validate structure without popups first:
   - `npm run verify:dmg-config`
   - `hdiutil verify dist/ChordVox-<VERSION>-arm64.dmg`
   - mount with `hdiutil attach -readonly -nobrowse -noverify -noautoopen`
   - confirm `ChordVox.app`, `Applications`, `Fix & Open.command`, `.DS_Store`, and `.background/background.tiff`
   - confirm `.background/background.tiff` dimensions with `sips -g pixelWidth -g pixelHeight`
   - confirm helper wording with `rg` against the mounted `Fix & Open.command`
   - confirm Finder item coordinates through the build script layout verifier, not by guessing from a random front window

Only use a real Finder render or screenshot for final pixel QA, such as spacing, visual balance, font hierarchy, label clipping, or whether the exact mounted DMG looks ugly. If a screenshot is needed, first prove the Finder target is the exact mounted DMG volume and do not capture the current frontmost window blindly.

### macOS release package

```bash
npm run build:mac
```

This uses the same stable DMG flow and the same pinned self-signed identity as the test package. Hardened Runtime remains enabled; Apple notarization is intentionally disabled because the project does not use a paid Developer ID.

Do not use this command on a machine where:

```bash
security find-identity -v -p codesigning
```

does not list `ChordVox Local Code Signing`. In that case run `npm run setup:mac:signing` to restore the encrypted P12. If the recovery material is unavailable, stop the macOS release; do not generate a new certificate and do not fall back to ad-hoc.

### Windows release package

```bash
npm run build:win
```

Run this only on GitHub `windows-latest` or UTM true Windows. Do not use macOS cross-builds or VPS Linux + Docker/Wine output for customer Windows packages.

This automatically runs `npm run verify:win:package` after packaging.

Windows packages must not include `Fix & Open.command`; use Windows installer / SmartScreen wording only.

### Linux release package

```bash
npm run build:linux
```

This automatically runs `npm run verify:linux:package` after packaging.

Linux packages must not include `Fix & Open.command`; use AppImage / deb / rpm / tar.gz instructions only.

## What the verification script checks

Script:

```bash
node scripts/verify-mac-package.js --platform <mac|win|linux>
```

Checks:

1. The packaged app exists in the expected unpacked output directory
2. Required helper binaries exist and are executable:
   - macOS:
     - `Contents/Resources/bin/macos-globe-listener`
     - `Contents/Resources/bin/macos-fast-paste`
   - Windows:
     - `resources/bin/windows-key-listener.exe`
     - `resources/bin/windows-fast-paste.exe`
     - `resources/bin/nircmd.exe`
   - Linux:
     - `resources/bin/linux-fast-paste`
3. Required runtime modules exist inside packaged `app.asar`:
   - `electron-updater`
   - `builder-util-runtime`
   - `fs-extra`
   - `graceful-fs`
4. Required external-worker modules exist in `app.asar.unpacked`:
   - `src/helpers/archiveSecurity.js`
   - `node_modules/tar/package.json`
   - `node_modules/@isaacs/fs-minipass/package.json`
   - `node_modules/chownr/package.json`
   - `node_modules/minipass/package.json`
   - `node_modules/minizlib/package.json`
   - `node_modules/yallist/package.json`
5. Every Mach-O under `Contents/Resources/bin` contains the architecture of the packaged app. For `llama-server`, the verifier recursively checks bundled `@rpath`, `@loader_path`, and `@executable_path` dependencies. It also starts the packaged binary with `--help` when the verification host has the same architecture; cross-architecture packages receive static architecture and dependency checks without requiring Rosetta.

The same-architecture startup gate allows up to 60 seconds because the first launch of a newly signed nested binary can spend additional time in macOS signature/provenance validation. This matches the app's own local-server startup budget; a timeout still fails the package.

If any check fails, packaging must be treated as failed.

For the current macOS DMG flow, the fresh app bundle lives under:

```bash
dist/.mac-dmg-work/mac-arm64/ChordVox.app
```

The verifier is called with that explicit path by `scripts/build-mac-dmg.js`.

## Release gate

Do not hand a package to users unless all of the following are true:

1. The platform build succeeds
2. The platform verify step passes
3. `npm run verify:icons` passes, proving the source PNG has a real alpha channel and electron-builder points macOS/DMG to `src/assets/icon.icns`, Windows to `src/assets/icon.ico`, and Linux to `src/assets/icon.png`
4. `npm run i18n:check:release` passes, proving marketed locales do not fall back to English for shipped UI keys
5. For customer releases, `npm run verify:release:dictation` has passed on the exact source SHA that is being packaged
6. For macOS test packages, a real launch smoke test confirms a visible main window or onboarding window appears
7. For macOS releases:
   - `security find-identity -v -p codesigning` shows `ChordVox Local Code Signing`
   - `electron-builder` does not fall back to ad-hoc signing
   - `scripts/verify-mac-package.js` proves the exact certificate SHA-256, designated requirement, and Hardened Runtime flag
   - release notes state that the package is self-signed and not Apple-notarized
8. For Windows releases:
   - `better_sqlite3.node` is `PE32+ executable (DLL) x86-64, for MS Windows`
   - the package does not contain `sherpa-onnx-linux-x64`, Linux `ffmpeg-static/ffmpeg`, or Linux `.so` runtime files
9. For macOS DMG releases:
   - `npm run verify:dmg-config` passes
   - the mounted DMG contains `.background/background.tiff`
   - opening the DMG shows the 1040x560 ChordVox gradient installer window
   - the ChordVox app icon is on the left, `Applications` symlink is in the middle, `Fix & Open.command` is on the right, and all Finder item names sit outside the icon artwork consistently
   - the Chinese blocked-launch hint is visually prominent and sits below the English helper explanation, not between English lines
10. For local streaming releases:

- `verify-mac-package.js` must prove every module used by the external Node worker is present in `app.asar.unpacked`
- if logs contain `Cannot find module` from `Contents/Resources/app.asar.unpacked`, treat the package as failed even if the app itself opens

11. For a user-visible macOS UI change whose delivery target is the installed product, source changes, tests, screenshots, commits, and pushes are intermediate evidence only. Completion requires a fresh package from the final source commit, installation through `npm run install:mac:local`, a running canonical process from `/Applications/ChordVox.app`, and verification of the exact changed UI behavior in that installed build. An older `dist` artifact or an uninstalled build-directory `.app` cannot satisfy this gate.

## Failure diagnosis

### Case 1: Popup says Globe listener binary not found

Meaning:

- package is missing `macos-globe-listener`
- packaging config or resource copy step is broken

Check:

```bash
ls -la dist/.mac-dmg-work/mac-arm64/ChordVox.app/Contents/Resources/bin
```

### Case 2: App launches then crashes with `Cannot find module 'builder-util-runtime'` / `graceful-fs`

Meaning:

- runtime dependency packaging is broken
- `electron-updater` dependency chain was not fully bundled

Check:

```bash
npx asar list dist/.mac-dmg-work/mac-arm64/ChordVox.app/Contents/Resources/app.asar | rg 'node_modules/(builder-util-runtime|graceful-fs)'
```

Equivalent checks:

- Windows:
  ```bash
  npx asar list dist/win-unpacked/resources/app.asar | rg 'node_modules/(builder-util-runtime|graceful-fs)'
  ```
- Linux:
  ```bash
  npx asar list dist/linux-unpacked/resources/app.asar | rg 'node_modules/(builder-util-runtime|graceful-fs)'
  ```

### Case 3: App is rejected by Gatekeeper on first launch

Meaning:

- this is expected for the pinned self-signed customer package
- Gatekeeper acceptance is not a release gate because the package is intentionally not Developer ID-signed or Apple-notarized
- signature integrity and identity continuity must still pass the repository verifier

Check:

```bash
spctl -a -vv dist/.mac-dmg-work/mac-arm64/ChordVox.app
security find-identity -v -p codesigning
```

If `security find-identity` does not list `ChordVox Local Code Signing`, you cannot produce a continuous ChordVox release on that machine until the encrypted P12 is restored.

Both local preview and customer release packages use:

```bash
npm run build:mac:test
```

This package is cryptographically signed by the pinned ChordVox certificate but is not trusted or notarized by Apple. Customer-facing instructions should prefer the DMG flow: drag `ChordVox.app` to Applications, try to open it, use System Settings > Privacy & Security > Open Anyway, then double-click `Fix & Open.command` from the DMG only if still blocked.

For internal troubleshooting only, the equivalent terminal fallback is:

```bash
xattr -dr com.apple.quarantine /Applications/ChordVox.app
open /Applications/ChordVox.app
```

---

## 踩坑记录

持续记录已发生过的打包 / 发版问题，避免重复踩坑。

### Pitfall 1: `electron-builder` 命令找不到

**现象**：执行 `electron-builder --mac ...` 报 `command not found`。

**原因**：`electron-builder` 安装在项目 `node_modules/.bin/` 下，不在全局 PATH。

**正确做法**：始终使用 `npx electron-builder` 代替裸 `electron-builder`。

### Pitfall 2: `LSUIElement: true` 导致菜单栏 Tray 图标不显示

**现象**：ChordVox 菜单栏图标无法独立出现，只有另一个 app（如 Codex）触发菜单栏 relayout 时才跟着渲染。

**根因**：`electron-builder.json` 的 `extendInfo.LSUIElement: true` 让 macOS 在启动时将 app 标记为 accessory。即使运行时调用 `app.setActivationPolicy("regular")`，macOS 的 `NSStatusItem` 渲染仍可能停留在 accessory 状态——尤其在刘海屏 MacBook Pro 上。

**修复**：`LSUIElement` 设为 `false`。既然 ChordVox 已硬编码 `shouldShowDock = true`（永远显示 Dock 图标），`LSUIElement: true` 毫无意义且有害。

**规则**：如果 app 需要 Dock 图标 + 菜单栏 Tray 图标同时存在，`LSUIElement` 必须为 `false`。仅当 app 设计为"纯菜单栏应用、无 Dock 图标"时才设为 `true`。

### Pitfall 2.1: 不同 macOS / Windows 机器显示棋盘格、旧图标或图标不一致

**现象**：本机 Dock / Finder 图标正常，但其他 MacBook、Windows 安装器或 DMG 里显示成棋盘格背景、旧图标、低清图标，或不同入口看到的图标不一致。

**根因**：Electron 源图不能依赖带棋盘格预览背景的 RGB PNG；macOS 和 Windows 也不能只复用普通 PNG。macOS / DMG 需要 `src/assets/icon.icns`，Windows 需要 `src/assets/icon.ico`，Linux 才使用 `src/assets/icon.png`。源 PNG 必须是 1024x1024 RGBA，角落透明、主体不透明。

**规则**：发版或交付测试包前必须跑 `npm run verify:icons`。如果用户反馈“别的机器图标变了”，先核查包内 icon 资源和 `electron-builder.json` 引用，再判断是否是 macOS / Windows 图标缓存；不要只按本机 Dock 当前显示下结论。

### Pitfall 3: 覆盖已有 Release 资产需要 `--clobber`

**现象**：对同一个版本号重新上传资产时，`gh release upload` 报错资产已存在。

**正确做法**：加 `--clobber` 标志覆盖旧资产：

```bash
gh release upload "$TAG" "${UPLOAD[@]}" -R "$REPO" --clobber
```

### Pitfall 4: `npm version` 目标版本已存在时报错

**现象**：`npm version "1.5.103" --no-git-tag-version` 报 `Version not changed`。

**正确做法**：升版本前先检查当前版本号，相同则跳过：

```bash
CURRENT=$(node -e "console.log(require('./package.json').version)")
if [ "$CURRENT" != "$VERSION" ]; then
  npm version "$VERSION" --no-git-tag-version
fi
```

### Pitfall 5: blockmap 文件必须上传

**现象**：`electron-updater` 依赖 `.blockmap` 文件做增量更新（delta update）。如果只上传 `.zip` / `.dmg` 而漏了 `.blockmap`，已安装用户的自动更新会失败或回退到全量下载。

**正确资产清单**（macOS arm64 完整版）：

- `ChordVox-<VERSION>-arm64-mac.zip`
- `ChordVox-<VERSION>-arm64-mac.zip.blockmap`
- `ChordVox-<VERSION>-arm64.dmg`
- `ChordVox-<VERSION>-arm64.dmg.blockmap`
- `latest-mac.yml`

### Pitfall 6: 临时 worktree 借用 / 共享 `node_modules` 会产出“只有 Dock 图标、没有主页面”的坏包

**现象**：

- 测试包点击后只出现 Dock 图标
- 主页面 / onboarding 不出现
- 直接从终端启动打包后的 app，主进程报错：

```bash
Cannot find module 'builder-util-runtime'
```

**根因**：

- 使用临时 worktree 打包时，偷快复用了别处的 `node_modules`（例如符号链接、局部复制、共享目录）
- `electron-builder` 虽然能跑完，但 `app.asar` 里会漏掉 `electron-updater` 的运行时依赖链，尤其是 `builder-util-runtime`

**硬规则**：

1. 打 mac 测试包时，worktree 必须自己执行 `npm ci`
2. 禁止用共享、符号链接、局部复制的 `node_modules` 产包
3. `npm run verify:mac:package` 通过后，还必须杀掉所有 `ChordVox` 进程，再从 `dist/.mac-dmg-work/mac-arm64/ChordVox.app` 做一次真实启动验收
4. 如果只出现 Dock 图标、没有可见窗口，按打包失败处理，禁止把 DMG / ZIP 发给人测

**最小验收命令**：

```bash
pkill -f 'ChordVox' || true
npm run verify:mac:package
open -n dist/.mac-dmg-work/mac-arm64/ChordVox.app
```

验收标准：

- 能看到可见主窗口或 onboarding
- 不能只剩 Dock 图标

### Pitfall 7: 本地流式 worker 入口存在，但间接依赖没有解包

**现象**：

- UI 显示“本地流式启动失败”
- Toast 里出现 `Failed to start local streaming: Local streaming worker exited during startup: 1`
- 日志里出现：

```bash
Cannot find module 'tar'
Require stack:
- .../Contents/Resources/app.asar.unpacked/src/helpers/archiveSecurity.js
- .../Contents/Resources/app.asar.unpacked/src/helpers/sherpaStreamingManager.js
- .../Contents/Resources/app.asar.unpacked/src/helpers/sherpaStreamingWorker.js
```

**根因**：

- `sherpaStreamingWorker.js` 使用外部 Node runtime 从 `app.asar.unpacked` 启动。
- 旧校验只检查了 worker 入口文件和 `sherpa-onnx-node`，但没有检查 `archiveSecurity.js -> tar` 的间接依赖链。
- `tar` 放在 `app.asar` 内时，外部 Node worker 不能可靠解析到它。

**硬规则**：

1. 任何从 `app.asar.unpacked` 启动的 worker，都要把完整 `require()` 依赖链写进 `asarUnpack`
2. 每新增或改动 worker 依赖，必须同步更新 `scripts/verify-mac-package.js`
3. `Cannot find module` 出现在 packaged app 日志里时，优先按“打包缺依赖”处理，不要先怪用户配置或模型文件
4. 修完后必须重打包并验证 `node_modules/tar/package.json` 以及 `@isaacs/fs-minipass`、`chownr`、`minipass`、`minizlib`、`yallist` 都在 `app.asar.unpacked`

### Pitfall 8: 同 bundle id 的多个本地测试 app 会污染验收结果和 Dock 图标判断

**现象**：

- 明明启动的是新包，macOS 却把激活请求接到另一份旧测试 app
- Dock 图标、聚焦状态、窗口是否出现都会被串台

**根因**：

- 同时保留了多份 `ChordVox.app` 测试副本，bundle identifier 一样

**硬规则**：

1. 验包前先 `pkill -f 'ChordVox'`
2. 同一轮验收只保留一个待测 app 实例
3. 不要把临时解压版 `.app` 长期放桌面参与对照，除非本轮明确要测它
4. 交付给测试方时优先给 DMG / ZIP，不默认交付解压版 `.app`

### Pitfall 8: `dmg-builder` 最后一步 `hdiutil detach` 报 `Resource busy`

**现象**：

- `npm run build:mac:test` 前面都跑完了
- `dist/.mac-dmg-work/mac-arm64/ChordVox.app` 和 `dist/ChordVox-<VERSION>-arm64-mac.zip` 已经产出
- 只在最后 `dmg` 收尾时报：
  - `Unable to detach device cleanly`
  - `hdiutil: couldn't unmount "diskX" - 资源忙`

**根因**：

- 这是 `dmg-builder` 收尾阶段的临时挂载盘卸载失败
- 常见触发源不是前面构建坏了，而是 Finder / Quick Look / Spotlight 还占着那个临时卷
- 带 `background` 的 DMG 布局更容易让 Finder 介入，所以这类问题在 mac 本地打包里并不罕见

**判断规则**：

1. 如果 `dist/.mac-dmg-work/mac-arm64/ChordVox.app` 已存在，且 `zip` 也已产出，先判断为“DMG 收尾失败”，不要误判成整次 mac 打包失败
2. 这时不要先重跑整套 renderer + packaging；优先清理挂载盘，再单独补 `dmg`
3. 只有在 `.app` / `zip` 本身缺失，或 `npm run verify:mac:package` 未通过时，才按“完整打包失败”处理

**当前默认方案**：

- 现在仓库默认已经不再依赖 `dmg-builder` 做 DMG 收尾
- `npm run build:mac` / `npm run build:mac:test` 会走 `scripts/build-mac-dmg.js`
- 这个脚本会先让 `electron-builder` 只产出可验证的 `zip + .app`，再用 `hdiutil create` 手工生成稳定 DMG
- 渐变背景、对称箭头、图标位置由 `scripts/build-mac-dmg.js` 在挂载后的 DMG 里写入 Finder 视图，不依赖 `electron-builder` 的 `dmg.background`

**如果仍要单独重做 DMG**：

```bash
npm run build:mac:dmg:test
```

或正式客户自签名版：

```bash
npm run build:mac:dmg
```

### Pitfall 9: 固定正式文件名反复重打时，`hdiutil create` 对 `dist/ChordVox-<VERSION>-arm64.dmg` 报 `资源忙`

**现象**：

- 同一个版本号反复本地重打测试包
- `zip`、`.app`、`verify-mac-package` 都已通过
- 只有最后一步直接写：
  - `dist/ChordVox-<VERSION>-arm64.dmg`
  - 报 `hdiutil: create failed - 资源忙`

**根因**：

- 不是包体坏，也不是 `hdiutil` 本身不会打包
- 根因是 macOS 后台组件（Finder / Quick Look / Spotlight / 安全扫描）可能还在短时间占用旧的同名 DMG
- 如果脚本每次都让 `hdiutil create` 直接覆盖同一个正式文件名，就会反复撞这个 busy 状态

**现在的默认防法**：

1. `scripts/build-mac-dmg.js` 先在 `dist/.mac-dmg-work/` 里生成唯一临时 DMG
2. 先 `verify` 临时 DMG
3. 再把临时 DMG 提升到正式名
4. 如果正式名路径仍短暂 busy，会自动重试
5. 如果重试后仍 busy，脚本会保留一个时间戳 DMG，而不是让整次打包失败

**硬规则**：

1. 不要再把“固定正式文件名直写”当成稳定方案
2. 版本号不变、需要反复重打时，优先接受脚本生成的时间戳兜底包
3. 只有正式发版前，才需要确保最终资产回到标准正式文件名

**判断规则**：

- 如果 `zip`、`.app`、`verify-mac-package` 都通过，但正式文件名提升失败：
  - 这是“正式文件名路径忙”，不是“打包链路坏了”
- 如果连临时 DMG 都生成不了：
  - 才按真正的 `hdiutil` / 打包环境故障处理

### Pitfall 10: 固定自签名身份缺失时误生成新身份或退回 ad-hoc

**现象**：

- 本机没有 `ChordVox Local Code Signing`
- `npm run build:mac` 在签名前熔断
- 临时生成新证书会改变 TCC 身份，ad-hoc 则会重新绑定内容哈希

**判定命令**：

```bash
security find-identity -v -p codesigning
```

如果输出：

```txt
0 valid identities found
```

**正确做法**：

1. 从加密回滚件恢复固定身份：
   ```bash
   npm run setup:mac:signing
   ```
2. 恢复后重新运行 `npm run build:mac` 或 `npm run build:mac:test`；两者都必须使用同一证书。
3. 回滚件缺失时停止 macOS 发布，禁止自动生成新身份或 ad-hoc 降级。
4. 对外说明清楚：客户包是固定自签名、未 Apple 公证，首次打开需要 Gatekeeper 手动放行。

### Pitfall 11: `llama-server` 文件存在，但同目录 dylib 架构不一致

**现象**：

- `resources/bin/llama-server-darwin-arm64` 是 arm64。
- 同目录 `libllama*.dylib`、`libggml*.dylib` 或 `libmtmd*.dylib` 却被后续 Intel 下载覆盖成 x86_64。
- 只用 `ls` 看见 server 文件存在会误判为“依赖齐全”，实际启动时报 `incompatible architecture`。

**处理**：

先运行目标架构下载门禁：

```bash
node scripts/download-llama-server.js --current --platform darwin --arch arm64
```

该命令会在复用已有 server 前检查 server、其 `@rpath` 依赖和全部 llama 专属 dylib 的架构。全部匹配时不联网下载；任一缺失或架构错误时，先在隔离目录准备完整 runtime，再精确替换 llama 专属文件并清理同平台其他架构 server。`scripts/build-mac-dmg.js` 在调用 electron-builder 前也会执行同一门禁。

随后正常打包：

```bash
npm run build:mac:test
```

**规则**：

- 不得因为目标 server 文件已经存在而跳过依赖架构验证。
- 下载失败且已有 runtime 通过架构门禁时可以继续；若门禁发现污染但刷新失败，必须熔断，不能用旧 dylib 打包。
- 成品包仍必须通过 `verify-mac-package`；它会检查包内全部 Mach-O 架构，并在验证主机与目标包架构一致时真实执行 `llama-server --help`。跨架构验证只做静态架构与依赖闭包检查，不要求 Rosetta。

### Pitfall 12: 自定义 DMG staging 的裸 `ditto` 报 `.BC.T_*: No such file or directory`

**现象**：

- `npm run build:mac:test` 已经产出并验证：
  - `dist/.mac-dmg-work/mac-arm64/ChordVox.app`
  - `dist/ChordVox-<VERSION>-arm64-mac.zip`
- 失败点发生在 `scripts/build-mac-dmg.js` 把 `.app` 复制进临时 DMG staging 目录时：
  - `ditto: .../app.asar.unpacked/node_modules/minizlib/dist/commonjs/.BC.T_*: No such file or directory`
  - `[mac-dmg] ditto exited with code 1`

**根因**：

- 这是 DMG staging 复制失败，不是 renderer build、`electron-builder` 或 `app.asar.unpacked` 依赖链缺失。
- 裸 `ditto` 会复制本机 Finder / provenance 扩展属性和资源叉；`app.asar.unpacked/node_modules` 里大量小文件带本机扩展属性时，macOS copyfile 可能在目标目录生成 `.BC.T_*` 临时文件时竞态失败。

**处理**：

1. 确认源 `.app` 里的报错文件真实存在：
   ```bash
   find dist/.mac-dmg-work/mac-arm64/ChordVox.app/Contents/Resources/app.asar.unpacked/node_modules/minizlib -maxdepth 4 -print
   ```
2. 自定义 DMG 脚本复制 `.app` 和 mounted DMG tree 时固定使用：
   ```bash
   ditto --norsrc --noextattr <source> <target>
   ```
3. 重新打包并验收：
   ```bash
   npm run build:mac:test
   hdiutil verify "dist/ChordVox-<VERSION>-arm64.dmg"
   ```

**规则**：

- 不要因为 `.BC.T_*` 报错去改 `asarUnpack`，除非 `verify-mac-package` 也证明依赖链缺文件。
- macOS DMG staging 不应复制源码机扩展属性；客户包需要的是 bundle 内容、权限、symlink、背景图、`.DS_Store` 和 blockmap。
