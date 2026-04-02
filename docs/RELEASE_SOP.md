# ChordVox 正确发版 SOP（Pro -> Public）

本文档是闭源 `ChordVox-Pro` 向公开下载仓 `GravityPoet/ChordVox` 的唯一发版流程。
公开仓自动发布已关闭，发布入口统一在私有仓 `Release` workflow。

## 0.1 发版前整理（必须做）

1. 进入 Pro 仓并确认当前工作区就是你要发布的内容

```bash
cd /Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro
git status --short
```

2. 升版本号（同时更新 `package.json` 和 `package-lock.json`）

```bash
VERSION="1.5.72"
npm version "$VERSION" --no-git-tag-version
```

3. 先做最小验收，至少确保前端和类型可过

```bash
npm run typecheck
npm run build:renderer
```

4. 提交并推送主线

```bash
git add -A
git commit -m "Release v${VERSION}"
git push origin main
```

5. 给源仓打版本 tag，并推到私有源仓

```bash
git tag -a "v$VERSION" -m "ChordVox v$VERSION"
git push origin "v$VERSION"
```

6. 记录本次真实源提交 SHA，后续 workflow / manifest 都要用这个

```bash
git rev-parse HEAD
```

## 0. 前置条件

- 已安装并登录 GitHub CLI：`gh auth status`
- Pro 仓主线代码在：`/Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro`
- 公开下载仓：`GravityPoet/ChordVox`
- 发版版本号示例：`1.5.31`

---

## 1. 标准流程（优先，走 Pro 的 Release workflow）

1. 获取要发版的源提交（必须在 Pro 的 `origin/main` 上）

```bash
cd /Users/moonlitpoet/Tools/ChordVox-Pro
git fetch origin
git rev-parse origin/main
```

2. 手动触发 Pro workflow（带 `version + source_sha`）

```bash
VERSION="1.5.31"
SOURCE_SHA="<上一步得到的40位SHA>"

gh workflow run Release \
  -R GravityPoet/ChordVox-Pro \
  -f version="$VERSION" \
  -f source_sha="$SOURCE_SHA" \
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

5. 校验本次 Release 资产中包含平台 manifest：
   - `release-manifest-linux.json`
   - `release-manifest-windows.json`
   - `release-manifest-macos-arm64.json`
   - `release-manifest-macos-x64.json`
6. 发布说明必须包含 `docs/RELEASE_NOTES_TEMPLATE.md` 中的 `macOS First Launch` 段落，并固定使用英文提示：
   - `macOS first launch may require permission because the app is distributed outside the App Store. If Gatekeeper blocks the app, run:`
7. 发布说明只能使用 Markdown，不得粘贴 HTML 标签或 GitHub 页面渲染后的 DOM 片段。

### 1.1 Windows 用 UTM 发最新版安装包到 GitHub

如果这次 Windows 不走 GitHub Actions runner，而是改用 UTM Win11 本地打包并发布：

1. 触发 Release workflow 时把 `windows_delivery` 设为 `utm-manual`

```bash
VERSION="1.5.31"
SOURCE_SHA="<上一步得到的40位SHA>"

gh workflow run Release \
  -R GravityPoet/ChordVox-Pro \
  -f version="$VERSION" \
  -f source_sha="$SOURCE_SHA" \
  -f windows_delivery="utm-manual"
```

2. 等 Linux / macOS 发布完成后，按 [docs/UTM_WINDOWS_BUILD_SOP.md](/Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro/docs/UTM_WINDOWS_BUILD_SOP.md) 在 UTM 里生成 Windows 包

3. 在 macOS 宿主机执行正式上传脚本，把 UTM 的最新 Windows 安装包补传到公开 GitHub Release

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
SOURCE_SHA="<上一步得到的40位SHA>"
ARTIFACTS_DIR="/path/to/utm/windows/dist"

cd /Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro
scripts/publish-utm-windows-release.sh \
  "$VERSION" \
  "$SOURCE_SHA" \
  "$ARTIFACTS_DIR" \
  "GravityPoet/ChordVox"
```

4. 验证公开仓 Release 中包含：
   - `ChordVox-Setup-<VERSION>.exe`
   - `ChordVox-Setup-<VERSION>.exe.blockmap`
   - `latest.yml`
   - `release-manifest-windows.json`

---

## 2. 回退流程（Actions 权限/账单受限时，手动发）

> 仅在第 1 步失败时使用。手动发版必须显式记录 `source_sha`。
> 如果 GitHub Actions 报错 `recent account payments have failed or your spending limit needs to be increased`，直接走本节。

1. 本机构建（macOS）

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
SOURCE_SHA="<Pro源SHA>"
PRO_DIR="/Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro"

cd "$PRO_DIR"
git fetch origin
git checkout "$SOURCE_SHA"

npm ci
npm run build:mac:test -- --arm64 --publish never
```

2.1 验证构建产物

```bash
ls -lah dist/ChordVox-${VERSION}-* dist/latest-mac.yml
```

正常情况下至少应有：
- `dist/ChordVox-${VERSION}-arm64-mac.zip`
- `dist/ChordVox-${VERSION}-arm64-mac.zip.blockmap`
- `dist/ChordVox-${VERSION}-arm64.dmg`
- `dist/latest-mac.yml`

2.2 如果 `dmg-builder` 卡住并报：
- `Unable to detach device cleanly`
- `hdiutil: couldn't unmount "diskX" - 资源忙`

不要重头折腾整次发版，直接手动补一个 `dmg`：

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
PRO_DIR="/Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro"

cd "$PRO_DIR"
rm -f "dist/ChordVox-${VERSION}-arm64.dmg"
rm -rf /tmp/chordvox-dmg-stage
mkdir -p /tmp/chordvox-dmg-stage
cp -R dist/mac-arm64/ChordVox.app /tmp/chordvox-dmg-stage/
ln -s /Applications /tmp/chordvox-dmg-stage/Applications

hdiutil create \
  -volname "ChordVox" \
  -srcfolder /tmp/chordvox-dmg-stage \
  -ov \
  -format UDZO \
  "/tmp/ChordVox-${VERSION}-arm64.dmg"

cp "/tmp/ChordVox-${VERSION}-arm64.dmg" "dist/ChordVox-${VERSION}-arm64.dmg"
```

3. 生成构建清单（manifest）

```bash
cd /Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro
VERSION="1.5.31"
SOURCE_SHA="<Pro源SHA>"

python3 <<'PY'
import glob, hashlib, json, os
from datetime import datetime, timezone

version = os.environ.get("VERSION", "")
source_sha = os.environ.get("SOURCE_SHA", "")
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

4. 手动发布到公开仓

```bash
#!/bin/bash
set -euo pipefail

VERSION="1.5.31"
TAG="v$VERSION"
REPO="GravityPoet/ChordVox"
cd /Users/moonlitpoet/Tools/ChordVox软件-网页/ChordVox-Pro

cat > /tmp/chordvox_release_notes.md <<EOF2
# ChordVox v${VERSION}

## Highlights

- <user-facing change 1>
- <user-facing change 2>
- <user-facing change 3>

## macOS First Launch
macOS first launch may require permission because the app is distributed outside the App Store. If Gatekeeper blocks the app, run:
\`\`\`bash
xattr -dr com.apple.quarantine /Applications/ChordVox.app
open /Applications/ChordVox.app
\`\`\`
EOF2

# 注意：release notes 必须直接写 Markdown。
# 不要从 GitHub 页面复制渲染后的 HTML，例如 <h1> / <ul> / <li> / <div class="highlight"> 等。
# 公开 Release 说明必须保持用户视角，不要放 private repo、source SHA、internal manifest 等内部溯源信息。

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release edit "$TAG" -R "$REPO" --title "ChordVox v${VERSION}" --notes-file /tmp/chordvox_release_notes.md
else
  gh release create "$TAG" -R "$REPO" --title "ChordVox v${VERSION}" --notes-file /tmp/chordvox_release_notes.md
fi

ASSETS=(
  dist/ChordVox-${VERSION}-arm64.dmg
  dist/ChordVox-${VERSION}-arm64-mac.zip
  dist/latest-mac.yml
  dist/release-manifest-macos-manual.json
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
- `ChordVox-${VERSION}-arm64-mac.zip`
- `latest-mac.yml`
- `release-manifest-macos-manual.json`

---

## 3. 发布后验收清单

- Release 页面资产名称与版本号一致
- `release-manifest-*.json` 中的 `sourceSha` 与本次目标 SHA 一致
- 本机下载 DMG 并可启动
- 若被 Gatekeeper 拦截，文案里有以下命令：

```bash
xattr -dr com.apple.quarantine /Applications/ChordVox.app
open /Applications/ChordVox.app
```
