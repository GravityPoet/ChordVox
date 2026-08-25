const { autoUpdater } = require("electron-updater");
const https = require("https");
const { app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { openSafeExternalUrl } = require("./helpers/urlSecurity");
const {
  MACOS_BUNDLE_ID: EXPECTED_MAC_BUNDLE_ID,
  MACOS_SIGNING_CERTIFICATE_SHA256,
  macosCodeRequirement,
} = require("./config/macosSigningIdentity");

const EXPECTED_MAC_BUNDLE_NAME = "ChordVox.app";

class UpdateManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.lastUpdateInfo = null;
    this.isInstalling = false;
    this.isDownloading = false;
    this.manualUpdateDownloadUrl = null;
    this.eventListeners = [];
    this.startupTimer = null;
    this.lastCheckedAt = null;
    this.feedSourceKey = null;

    this.setupAutoUpdater();
    this.cleanupLegacyVisibleMacBackups();
  }

  getInstallMarkerPath() {
    return path.join(app.getPath("userData"), "updater-install-marker.json");
  }

  writeInstallMarker(targetVersion) {
    try {
      const marker = {
        targetVersion: targetVersion || null,
        currentVersion: app.getVersion(),
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.getInstallMarkerPath(), JSON.stringify(marker), "utf8");
    } catch (error) {
      console.warn("⚠️ Failed to write updater install marker:", error.message);
    }
  }

  clearInstallMarker() {
    try {
      const markerPath = this.getInstallMarkerPath();
      if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
      }
    } catch (error) {
      console.warn("⚠️ Failed to clear updater install marker:", error.message);
    }
  }

  cleanupLegacyVisibleMacBackups() {
    if (process.platform !== "darwin") {
      return;
    }

    const markerPath = this.getInstallMarkerPath();
    if (!fs.existsSync(markerPath)) {
      return;
    }

    try {
      const appBundlePath = path.resolve(process.execPath, "..", "..", "..");
      const appBundleName = path.basename(appBundlePath);
      if (!appBundleName.endsWith(".app")) {
        return;
      }

      const targetDir = path.dirname(appBundlePath);
      const backupPrefix = `${appBundleName}.bak.`;
      const backupNames = fs
        .readdirSync(targetDir)
        .filter(
          (entry) =>
            entry.startsWith(backupPrefix) && /^\d+$/.test(entry.slice(backupPrefix.length))
        );

      for (const backupName of backupNames) {
        const backupPath = path.join(targetDir, backupName);
        const backupStat = fs.statSync(backupPath);
        if (backupStat.isDirectory()) {
          fs.rmSync(backupPath, { recursive: true, force: true });
        }
      }

      if (backupNames.length > 0) {
        console.log(`🧹 Removed ${backupNames.length} legacy updater backup(s) from ${targetDir}`);
      }
    } catch (error) {
      console.warn("⚠️ Failed to remove legacy updater backup:", error.message);
    } finally {
      this.clearInstallMarker();
    }
  }

  getUpdaterPendingDir() {
    return path.join(app.getPath("cache"), "chordvox-updater", "pending");
  }

  resolvePendingZipCandidate(pendingDir, fileName) {
    const candidateName = String(fileName || "").trim();
    if (
      !candidateName ||
      candidateName !== path.basename(candidateName) ||
      !candidateName.toLowerCase().endsWith(".zip")
    ) {
      return null;
    }

    const zipPath = path.resolve(pendingDir, candidateName);
    const pendingRoot = path.resolve(pendingDir);
    const relative = path.relative(pendingRoot, zipPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }

    return fs.existsSync(zipPath) ? zipPath : null;
  }

  resolveDownloadedZipPath() {
    const pendingDir = this.getUpdaterPendingDir();
    if (!fs.existsSync(pendingDir)) {
      return null;
    }

    const updateInfoPath = path.join(pendingDir, "update-info.json");
    if (fs.existsSync(updateInfoPath)) {
      try {
        const updateInfo = JSON.parse(fs.readFileSync(updateInfoPath, "utf8"));
        const fileName = typeof updateInfo?.fileName === "string" ? updateInfo.fileName : "";
        const zipPath = this.resolvePendingZipCandidate(pendingDir, fileName);
        if (zipPath) {
          return zipPath;
        }
      } catch (error) {
        console.warn("⚠️ Failed to parse updater pending metadata:", error.message);
      }
    }

    const fallbackZip = fs
      .readdirSync(pendingDir)
      .find((entry) => typeof entry === "string" && entry.toLowerCase().endsWith(".zip"));
    if (!fallbackZip) {
      return null;
    }
    return this.resolvePendingZipCandidate(pendingDir, fallbackZip);
  }

  prepareMacSelfUpdate() {
    if (process.platform !== "darwin") {
      return { started: false, reason: "not-macos" };
    }

    const zipPath = this.resolveDownloadedZipPath();
    if (!zipPath) {
      return { started: false, reason: "zip-not-found" };
    }

    const appBundlePath = path.resolve(process.execPath, "..", "..", "..");
    const appBundleName = path.basename(appBundlePath);
    const executableName = path.basename(process.execPath);
    const targetVersion = String(this.lastUpdateInfo?.version || "").trim();
    const expectedUpdateArch = /(?:^|[-_.])arm64(?:[-_.]|$)/i.test(path.basename(zipPath))
      ? "arm64"
      : "x64";
    if (!appBundleName.endsWith(".app")) {
      return { started: false, reason: "invalid-app-bundle-path", appBundlePath };
    }
    if (!targetVersion) {
      return { started: false, reason: "target-version-missing" };
    }

    const scriptPath = path.join(app.getPath("temp"), `chordvox-self-update-${Date.now()}.sh`);
    const scriptContent = `#!/bin/bash
set -euo pipefail

APP_BUNDLE_PATH="$1"
ZIP_PATH="$2"
CURRENT_PID="$3"
EXECUTABLE_NAME="$4"
EXPECTED_APP_BUNDLE_NAME="$5"
EXPECTED_BUNDLE_ID="$6"
EXPECTED_VERSION="$7"
EXPECTED_ARCH="$8"
EXPECTED_CERTIFICATE_SHA256="$9"
EXPECTED_REQUIREMENT="\${10}"
APP_BUNDLE_NAME=$(basename "$APP_BUNDLE_PATH")

if [ ! -f "$ZIP_PATH" ]; then
  exit 11
fi

for _ in $(seq 1 200); do
  if ! kill -0 "$CURRENT_PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
if kill -0 "$CURRENT_PID" 2>/dev/null; then
  exit 10
fi

STAGING_DIR=$(mktemp -d /tmp/chordvox_update_XXXXXX)
COPY_DIR=$(mktemp -d /tmp/chordvox_update_copy_XXXXXX)
ROLLBACK_DIR=$(mktemp -d /tmp/chordvox_update_rollback_XXXXXX)
BACKUP_PATH="$ROLLBACK_DIR/$APP_BUNDLE_NAME"
INSTALL_REPLACED=0
INSTALL_SUCCEEDED=0
cleanup() {
  STATUS=$?
  set +e
  trap - EXIT
  if [ "$INSTALL_SUCCEEDED" != "1" ] && [ "$INSTALL_REPLACED" = "1" ] && [ -d "$BACKUP_PATH" ]; then
    rm -rf "$APP_BUNDLE_PATH"
    mv "$BACKUP_PATH" "$APP_BUNDLE_PATH" || true
    /usr/bin/open -na "$APP_BUNDLE_PATH" >/dev/null 2>&1 || true
  fi
  rm -rf "$STAGING_DIR"
  rm -rf "$COPY_DIR"
  if [ "$INSTALL_SUCCEEDED" = "1" ] || [ ! -d "$BACKUP_PATH" ]; then
    rm -rf "$ROLLBACK_DIR"
  fi
  exit "$STATUS"
}
trap cleanup EXIT

verify_expected_signature() {
  SIGNED_APP="$1"
  CERTIFICATE_PREFIX="$2"
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$SIGNED_APP" || return 1
  /usr/bin/codesign --verify --deep --strict -R="$EXPECTED_REQUIREMENT" "$SIGNED_APP" || return 1
  /usr/bin/codesign -d --extract-certificates="$CERTIFICATE_PREFIX" "$SIGNED_APP" \
    >/dev/null 2>&1 || return 1
  if [ ! -f "\${CERTIFICATE_PREFIX}0" ]; then
    return 1
  fi
  ACTUAL_CERTIFICATE_SHA256=$(/usr/bin/shasum -a 256 "\${CERTIFICATE_PREFIX}0" \
    | /usr/bin/awk '{print $1}')
  [ "$ACTUAL_CERTIFICATE_SHA256" = "$EXPECTED_CERTIFICATE_SHA256" ]
}

ditto -x -k "$ZIP_PATH" "$STAGING_DIR"
NEW_APP="$STAGING_DIR/$EXPECTED_APP_BUNDLE_NAME"
if [ ! -d "$NEW_APP" ]; then
  exit 12
fi

INFO_PLIST="$NEW_APP/Contents/Info.plist"
NEW_EXECUTABLE="$NEW_APP/Contents/MacOS/$EXECUTABLE_NAME"
if [ ! -f "$INFO_PLIST" ] || [ ! -x "$NEW_EXECUTABLE" ]; then
  exit 14
fi

BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST" 2>/dev/null || true)
BUNDLE_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST" 2>/dev/null || true)
if [ "$BUNDLE_ID" != "$EXPECTED_BUNDLE_ID" ] || [ "$BUNDLE_VERSION" != "$EXPECTED_VERSION" ]; then
  exit 15
fi

if ! verify_expected_signature "$NEW_APP" "$STAGING_DIR/new-certificate"; then
  exit 16
fi

ARCHS=$(/usr/bin/lipo -archs "$NEW_EXECUTABLE" 2>/dev/null || true)
case "$EXPECTED_ARCH" in
  arm64)
    echo "$ARCHS" | grep -qw arm64 || exit 18
    ;;
  x64)
    echo "$ARCHS" | grep -qw x86_64 || exit 18
    ;;
  *)
    exit 18
    ;;
esac

TARGET_DIR=$(dirname "$APP_BUNDLE_PATH")
mkdir -p "$TARGET_DIR"

TMP_TARGET="$COPY_DIR/$APP_BUNDLE_NAME"
rm -rf "$TMP_TARGET"
ditto "$NEW_APP" "$TMP_TARGET"
xattr -cr "$TMP_TARGET" >/dev/null 2>&1 || true
if ! verify_expected_signature "$TMP_TARGET" "$STAGING_DIR/copied-certificate"; then
  exit 19
fi

if [ -d "$APP_BUNDLE_PATH" ]; then
  rm -rf "$BACKUP_PATH"
  mv "$APP_BUNDLE_PATH" "$BACKUP_PATH"
  INSTALL_REPLACED=1
fi

ditto "$TMP_TARGET" "$APP_BUNDLE_PATH"
xattr -cr "$APP_BUNDLE_PATH" >/dev/null 2>&1 || true
if ! verify_expected_signature "$APP_BUNDLE_PATH" "$STAGING_DIR/installed-certificate"; then
  exit 20
fi
/usr/bin/open -na "$APP_BUNDLE_PATH" >/dev/null 2>&1 || true

for _ in $(seq 1 50); do
  if pgrep -f "$APP_BUNDLE_PATH/Contents/MacOS/$EXECUTABLE_NAME" >/dev/null 2>&1; then
    INSTALL_SUCCEEDED=1
    exit 0
  fi
  sleep 0.2
done

exit 13
`;

    fs.writeFileSync(scriptPath, scriptContent, "utf8");
    fs.chmodSync(scriptPath, 0o755);

    const worker = spawn(
      "/bin/bash",
      [
        scriptPath,
        appBundlePath,
        zipPath,
        String(process.pid),
        executableName,
        EXPECTED_MAC_BUNDLE_NAME,
        EXPECTED_MAC_BUNDLE_ID,
        targetVersion,
        expectedUpdateArch,
        MACOS_SIGNING_CERTIFICATE_SHA256,
        macosCodeRequirement(EXPECTED_MAC_BUNDLE_ID),
      ],
      {
        detached: true,
        stdio: "ignore",
      }
    );
    worker.unref();

    return { started: true, method: "mac-self-update", appBundlePath, zipPath };
  }

  getUpdateRepo() {
    const owner = (process.env.CHORDVOX_UPDATE_OWNER || "GravityPoet").trim();
    const repo = (process.env.CHORDVOX_UPDATE_REPO || "ChordVox").trim();
    return { owner, repo };
  }

  compareVersions(a, b) {
    const normalize = (version) => {
      const clean = String(version || "")
        .trim()
        .replace(/^v/i, "")
        .split("-", 1)[0];
      return clean
        .split(".")
        .map((part) => {
          const parsed = Number.parseInt(part, 10);
          return Number.isFinite(parsed) ? parsed : 0;
        })
        .slice(0, 3);
    };

    const av = normalize(a);
    const bv = normalize(b);
    const maxLen = Math.max(av.length, bv.length, 3);
    for (let i = 0; i < maxLen; i += 1) {
      const left = av[i] || 0;
      const right = bv[i] || 0;
      if (left > right) return 1;
      if (left < right) return -1;
    }
    return 0;
  }

  extractVersionFromTag(tag) {
    return String(tag || "")
      .trim()
      .replace(/^v/i, "")
      .split("-", 1)[0];
  }

  isSemverTag(tag) {
    return /^v?\d+\.\d+\.\d+(?:[-+].*)?$/i.test(String(tag || "").trim());
  }

  getReleaseAssets(release) {
    return Array.isArray(release?.assets) ? release.assets : [];
  }

  isMacUpdateAsset(assetName) {
    const normalized = String(assetName || "")
      .trim()
      .toLowerCase();
    return (
      normalized === "latest-mac.yml" ||
      normalized.endsWith("-mac.zip") ||
      normalized.endsWith(".dmg")
    );
  }

  isAppReleaseCandidate(release) {
    const tag = String(release?.tag_name || "").trim();
    if (!this.isSemverTag(tag)) {
      return false;
    }

    return this.getReleaseAssets(release).some((asset) => this.isMacUpdateAsset(asset?.name));
  }

  getReleaseDownloadBaseUrl(tagName) {
    const { owner, repo } = this.getUpdateRepo();
    const safeTag = encodeURIComponent(String(tagName || "").trim()).replace(/%2F/g, "/");
    return `https://github.com/${owner}/${repo}/releases/download/${safeTag}`;
  }

  configureFeedForRelease(release) {
    const tagName = release?.tag_name || release?.tagName;
    const baseUrl =
      release?.downloadBaseUrl || (tagName ? this.getReleaseDownloadBaseUrl(tagName) : null);
    if (!baseUrl) {
      throw new Error("Missing update release feed URL");
    }

    const nextKey = `generic:${baseUrl}`;
    if (this.feedSourceKey === nextKey) {
      return;
    }

    autoUpdater.setFeedURL({
      provider: "generic",
      url: baseUrl,
    });
    this.feedSourceKey = nextKey;
  }

  async findLatestAppRelease() {
    const { owner, repo } = this.getUpdateRepo();

    try {
      const latestRelease = await this.fetchJson(
        `https://api.github.com/repos/${owner}/${repo}/releases/latest`
      );
      if (this.isAppReleaseCandidate(latestRelease)) {
        return latestRelease;
      }
    } catch (error) {
      console.warn("⚠️ Failed to fetch GitHub latest release:", error.message);
    }

    const releases = await this.fetchJson(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`
    );

    if (!Array.isArray(releases)) {
      return null;
    }

    return (
      releases.find(
        (release) =>
          release &&
          release.draft !== true &&
          release.prerelease !== true &&
          this.isAppReleaseCandidate(release)
      ) || null
    );
  }

  decodeHtmlEntities(input) {
    if (!input) return "";

    return String(input)
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#x2F;/gi, "/")
      .replace(/&#(\d+);/g, (_, code) => {
        const parsed = Number.parseInt(code, 10);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _;
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
        const parsed = Number.parseInt(code, 16);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _;
      });
  }

  normalizeReleaseNotes(notes) {
    if (typeof notes !== "string") {
      return notes || null;
    }

    const trimmed = notes.trim();
    if (!trimmed) {
      return null;
    }

    if (!/<\/?[a-z][\s\S]*>/i.test(trimmed)) {
      return trimmed;
    }

    let normalized = trimmed;

    normalized = normalized
      .replace(/\r\n?/g, "\n")
      .replace(
        /<div[^>]*data-snippet-clipboard-copy-content="([^"]+)"[^>]*>[\s\S]*?<\/div>/gi,
        (_, code) => {
          const decoded = this.decodeHtmlEntities(code).trim();
          return `\n\n\`\`\`bash\n${decoded}\n\`\`\`\n\n`;
        }
      )
      .replace(/<pre[^>]*>\s*<code[^>]*>/gi, "\n\n```bash\n")
      .replace(/<\/code>\s*<\/pre>/gi, "\n```\n\n")
      .replace(/<pre[^>]*>/gi, "\n\n```\n")
      .replace(/<\/pre>/gi, "\n```\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|blockquote)>/gi, "\n\n")
      .replace(/<(p|div|section|article|blockquote)[^>]*>/gi, "")
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n")
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
      .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
      .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
      .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
      .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
      .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*")
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<[^>]+>/g, "");

    normalized = this.decodeHtmlEntities(normalized)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/```([^\n]*)\n\s+/g, "```$1\n")
      .trim();

    return normalized || trimmed;
  }

  fetchJson(url) {
    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            "User-Agent": `ChordVox-Updater/${app.getVersion()}`,
            Accept: "application/vnd.github+json",
          },
          timeout: 8000,
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += String(chunk);
          });
          response.on("end", () => {
            if (response.statusCode && response.statusCode >= 400) {
              reject(
                new Error(
                  `GitHub API request failed (${response.statusCode}): ${body.slice(0, 200)}`
                )
              );
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(new Error(`Invalid GitHub API response: ${error.message}`));
            }
          });
        }
      );

      request.on("timeout", () => {
        request.destroy(new Error("GitHub API request timed out"));
      });
      request.on("error", reject);
    });
  }

  async checkGitHubLatestRelease() {
    try {
      const release = await this.findLatestAppRelease();
      this.markChecked();
      if (!release) {
        return null;
      }

      const latestTag = String(release.tag_name || "").trim();
      const latestVersion = this.extractVersionFromTag(latestTag);
      if (!latestVersion) {
        return null;
      }

      const hasMacFeed = this.getReleaseAssets(release).some(
        (asset) =>
          String(asset?.name || "")
            .trim()
            .toLowerCase() === "latest-mac.yml"
      );
      const downloadBaseUrl = hasMacFeed ? this.getReleaseDownloadBaseUrl(latestTag) : null;

      const currentVersion = app.getVersion();
      const isNewer = this.compareVersions(latestVersion, currentVersion) > 0;
      if (!isNewer) {
        return {
          updateAvailable: false,
          latestVersion,
          currentVersion,
          tagName: latestTag,
          manualDownloadUrl: release.html_url || null,
          manualOnly: !hasMacFeed,
          downloadBaseUrl,
        };
      }

      const info = {
        version: latestVersion,
        releaseDate: release.published_at || null,
        releaseNotes: this.normalizeReleaseNotes(release.body || null),
        tagName: latestTag,
        manualDownloadUrl: release.html_url || null,
        manualOnly: !hasMacFeed,
        downloadBaseUrl,
        source: "github-fallback",
        autoDownload: false,
      };

      this.updateAvailable = true;
      this.updateDownloaded = false;
      this.manualUpdateDownloadUrl = info.manualDownloadUrl;
      this.lastUpdateInfo = info;
      this.notifyRenderers("update-available", info);

      return {
        updateAvailable: true,
        ...info,
      };
    } catch (error) {
      console.warn("⚠️ GitHub fallback update check failed:", error.message);
      return null;
    }
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;
  }

  setupAutoUpdater() {
    // Only configure auto-updater in production
    if (process.env.NODE_ENV === "development") {
      // Auto-updater disabled in development mode
      return;
    }

    // Prefer build-generated app-update.yml (from electron-builder publish settings).
    // Optional override allows custom feeds without rebuilding.
    const updateOwner = (process.env.CHORDVOX_UPDATE_OWNER || "").trim();
    const updateRepo = (process.env.CHORDVOX_UPDATE_REPO || "").trim();
    if (updateOwner && updateRepo) {
      autoUpdater.setFeedURL({
        provider: "github",
        owner: updateOwner,
        repo: updateRepo,
        private: false,
      });
      this.feedSourceKey = `github:${updateOwner}/${updateRepo}`;
    }

    // Default to automatically downloading updates after they are detected.
    // Can be disabled with CHORDVOX_AUTO_DOWNLOAD_UPDATES=false.
    autoUpdater.autoDownload =
      String(process.env.CHORDVOX_AUTO_DOWNLOAD_UPDATES || "true").toLowerCase() !== "false";

    // Keep install fully user-driven. Do not auto-install on app quit.
    autoUpdater.autoInstallOnAppQuit = false;

    // Enable logging in production for debugging (logs are user-accessible)
    autoUpdater.logger = console;

    // Set up event handlers
    this.setupEventHandlers();
  }

  markChecked() {
    this.lastCheckedAt = new Date().toISOString();
  }

  setupEventHandlers() {
    const handlers = {
      "checking-for-update": () => {
        this.notifyRenderers("checking-for-update", {
          startedAt: new Date().toISOString(),
        });
      },
      "update-available": (info) => {
        this.markChecked();
        this.updateAvailable = true;
        this.isDownloading = autoUpdater.autoDownload === true && info?.manualOnly !== true;
        const previousInfo = this.lastUpdateInfo || {};
        this.manualUpdateDownloadUrl = previousInfo.manualDownloadUrl || null;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes:
              this.normalizeReleaseNotes(info.releaseNotes) || previousInfo.releaseNotes || null,
            files: info.files,
            manualDownloadUrl: info.manualDownloadUrl || previousInfo.manualDownloadUrl || null,
            manualOnly: info.manualOnly === true,
            autoDownload: this.isDownloading,
          };
        }
        this.notifyRenderers("update-available", this.lastUpdateInfo || info);
      },
      "update-not-available": (info) => {
        this.markChecked();
        this.updateAvailable = false;
        this.updateDownloaded = false;
        this.isDownloading = false;
        this.manualUpdateDownloadUrl = null;
        this.lastUpdateInfo = null;
        this.notifyRenderers("update-not-available", info);
      },
      error: (err) => {
        this.markChecked();
        console.error("❌ Auto-updater error:", err);
        this.isDownloading = false;
        this.notifyRenderers("update-error", err);
      },
      "download-progress": (progressObj) => {
        console.log(
          `📥 Download progress: ${progressObj.percent.toFixed(2)}% (${(progressObj.transferred / 1024 / 1024).toFixed(2)}MB / ${(progressObj.total / 1024 / 1024).toFixed(2)}MB)`
        );
        this.notifyRenderers("update-download-progress", progressObj);
      },
      "update-downloaded": (info) => {
        this.markChecked();
        console.log("✅ Update downloaded successfully:", info?.version);
        this.updateDownloaded = true;
        this.isDownloading = false;
        this.manualUpdateDownloadUrl = null;
        this.isInstalling = false;
        const previousInfo = this.lastUpdateInfo || {};
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes:
              this.normalizeReleaseNotes(info.releaseNotes) || previousInfo.releaseNotes || null,
            files: info.files,
            manualDownloadUrl: info.manualDownloadUrl || previousInfo.manualDownloadUrl || null,
            manualOnly: info.manualOnly === true || previousInfo.manualOnly === true,
          };
        }
        this.notifyRenderers("update-downloaded", this.lastUpdateInfo || info);
      },
    };

    // Register and track event listeners for cleanup
    Object.entries(handlers).forEach(([event, handler]) => {
      autoUpdater.on(event, handler);
      this.eventListeners.push({ event, handler });
    });
  }

  notifyRenderers(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
      this.mainWindow.webContents.send(channel, data);
    }
    if (
      this.controlPanelWindow &&
      !this.controlPanelWindow.isDestroyed() &&
      this.controlPanelWindow.webContents
    ) {
      this.controlPanelWindow.webContents.send(channel, data);
    }
  }

  async checkForUpdates() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          updateAvailable: false,
          message: "Update checks are disabled in development mode",
        };
      }

      console.log("🔍 Checking for updates...");

      const githubReleaseResult = await this.checkGitHubLatestRelease();
      if (githubReleaseResult) {
        if (!githubReleaseResult.updateAvailable) {
          this.updateAvailable = false;
          this.updateDownloaded = false;
          this.isDownloading = false;
          this.manualUpdateDownloadUrl = null;
          this.lastUpdateInfo = null;
          console.log("✅ Already on latest version");
          return {
            updateAvailable: false,
            message: "You are running the latest version",
            version: githubReleaseResult.latestVersion,
          };
        }

        if (githubReleaseResult.downloadBaseUrl && githubReleaseResult.manualOnly !== true) {
          try {
            this.configureFeedForRelease(githubReleaseResult);
            const result = await autoUpdater.checkForUpdates();

            if (result?.isUpdateAvailable && result?.updateInfo) {
              console.log("📋 Update available:", result.updateInfo.version);
              console.log(
                "📦 Download size:",
                result.updateInfo.files
                  ?.map((f) => `${(f.size / 1024 / 1024).toFixed(2)}MB`)
                  .join(", ")
              );
              return {
                updateAvailable: true,
                version: result.updateInfo.version,
                releaseDate: result.updateInfo.releaseDate,
                files: result.updateInfo.files,
                releaseNotes: this.normalizeReleaseNotes(result.updateInfo.releaseNotes),
                manualDownloadUrl: null,
                manualOnly: false,
                autoDownload: autoUpdater.autoDownload === true,
              };
            }

            return {
              updateAvailable: true,
              version: githubReleaseResult.version,
              releaseDate: githubReleaseResult.releaseDate,
              releaseNotes: githubReleaseResult.releaseNotes,
              manualDownloadUrl: githubReleaseResult.manualDownloadUrl,
              manualOnly: true,
              autoDownload: false,
            };
          } catch (error) {
            console.warn(
              "⚠️ Auto-updater feed check failed, falling back to manual update:",
              error.message
            );
            return {
              updateAvailable: true,
              version: githubReleaseResult.version,
              releaseDate: githubReleaseResult.releaseDate,
              releaseNotes: githubReleaseResult.releaseNotes,
              manualDownloadUrl: githubReleaseResult.manualDownloadUrl,
              manualOnly: true,
              autoDownload: false,
            };
          }
        }

        return githubReleaseResult;
      }

      const result = await autoUpdater.checkForUpdates();

      if (result?.isUpdateAvailable && result?.updateInfo) {
        console.log("📋 Update available:", result.updateInfo.version);
        console.log(
          "📦 Download size:",
          result.updateInfo.files?.map((f) => `${(f.size / 1024 / 1024).toFixed(2)}MB`).join(", ")
        );
        return {
          updateAvailable: true,
          version: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate,
          files: result.updateInfo.files,
          releaseNotes: this.normalizeReleaseNotes(result.updateInfo.releaseNotes),
          manualDownloadUrl: null,
          manualOnly: false,
          autoDownload: autoUpdater.autoDownload === true,
        };
      } else {
        const fallbackResult = await this.checkGitHubLatestRelease();
        if (fallbackResult?.updateAvailable) {
          return fallbackResult;
        }
        console.log("✅ Already on latest version");
        return {
          updateAvailable: false,
          message: "You are running the latest version",
          version: fallbackResult?.latestVersion,
        };
      }
    } catch (error) {
      console.error("❌ Update check error:", error);
      const fallbackResult = await this.checkGitHubLatestRelease();
      if (fallbackResult?.updateAvailable) {
        return fallbackResult;
      }
      this.updateAvailable = false;
      this.updateDownloaded = false;
      this.manualUpdateDownloadUrl = null;
      this.lastUpdateInfo = null;
      return {
        updateAvailable: false,
        message: "Unable to check updates right now",
        error: "UPDATE_CHECK_FAILED",
      };
    }
  }

  async downloadUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update downloads are disabled in development mode",
        };
      }

      if (this.isDownloading) {
        return {
          success: true,
          message: "Download already in progress",
        };
      }

      if (this.updateDownloaded) {
        return {
          success: true,
          message: "Update already downloaded. Ready to install.",
        };
      }

      if (this.manualUpdateDownloadUrl) {
        await openSafeExternalUrl(shell, this.manualUpdateDownloadUrl);
        return {
          success: true,
          message: "Opened release page for manual download",
          manual: true,
          url: this.manualUpdateDownloadUrl,
        };
      }

      this.isDownloading = true;
      console.log("📥 Starting update download...");
      await autoUpdater.downloadUpdate();
      console.log("📥 Download initiated successfully");

      return { success: true, message: "Update download started" };
    } catch (error) {
      this.isDownloading = false;
      console.error("❌ Update download error:", error);
      throw error;
    }
  }

  async installUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update installation is disabled in development mode",
        };
      }

      if (!this.updateDownloaded) {
        return {
          success: false,
          message: "No update available to install",
        };
      }

      if (this.isInstalling) {
        return {
          success: false,
          message: "Update installation already in progress",
        };
      }

      this.isInstalling = true;
      console.log("🔄 Installing update and restarting...");
      this.writeInstallMarker(this.lastUpdateInfo?.version || null);

      const macSelfUpdate = this.prepareMacSelfUpdate();
      if (macSelfUpdate.started) {
        console.log("🧩 Using macOS self-update fallback:", macSelfUpdate);
        this.notifyRenderers("update-installing", {
          method: "mac-self-update",
          targetVersion: this.lastUpdateInfo?.version || null,
        });
        app.quit();
        return { success: true, message: "Update installation started", method: "mac-self-update" };
      }

      const { BrowserWindow } = require("electron");

      // Temporarily remove only the listeners that can prevent quitAndInstall,
      // and retain exact snapshots so a failed/timeout install leaves the
      // current session behaving normally.
      const appWindowClosedListeners = app.listeners("window-all-closed");
      const windowCloseListeners = BrowserWindow.getAllWindows().map((win) => ({
        win,
        listeners: win.listeners("close"),
      }));
      for (const listener of appWindowClosedListeners) {
        app.removeListener("window-all-closed", listener);
      }
      for (const { win, listeners } of windowCloseListeners) {
        for (const listener of listeners) {
          win.removeListener("close", listener);
        }
      }
      const restoreCloseListeners = () => {
        for (const listener of appWindowClosedListeners) {
          if (!app.listeners("window-all-closed").includes(listener)) {
            app.on("window-all-closed", listener);
          }
        }
        for (const { win, listeners } of windowCloseListeners) {
          if (win.isDestroyed()) continue;
          for (const listener of listeners) {
            if (!win.listeners("close").includes(listener)) {
              win.on("close", listener);
            }
          }
        }
      };

      const isSilent = process.platform === "win32";
      let installTriggered = false;

      try {
        await new Promise((resolve, reject) => {
          let timeout = null;
          const cleanupWait = () => {
            if (timeout) clearTimeout(timeout);
            autoUpdater.removeListener("before-quit-for-update", markTriggered);
          };

          const markTriggered = () => {
            installTriggered = true;
            cleanupWait();
            resolve(true);
          };

          timeout = setTimeout(() => {
            if (installTriggered) return;

            this.isInstalling = false;
            const fallbackUrl =
              this.manualUpdateDownloadUrl ||
              this.lastUpdateInfo?.manualDownloadUrl ||
              `https://github.com/${this.getUpdateRepo().owner}/${this.getUpdateRepo().repo}/releases/latest`;
            this.manualUpdateDownloadUrl = fallbackUrl;
            cleanupWait();
            reject(
              new Error(
                `AUTO_INSTALL_NOT_TRIGGERED: automatic installer did not start. Fallback URL: ${fallbackUrl}`
              )
            );
          }, 12000);

          autoUpdater.once("before-quit-for-update", markTriggered);

          try {
            autoUpdater.quitAndInstall(isSilent, true);
          } catch (error) {
            cleanupWait();
            reject(error);
          }
        });
      } catch (error) {
        restoreCloseListeners();
        throw error;
      }

      return { success: true, message: "Update installation started" };
    } catch (error) {
      this.isInstalling = false;
      this.clearInstallMarker();
      console.error("❌ Update installation error:", error);
      throw error;
    }
  }

  async getAppVersion() {
    try {
      const { app } = require("electron");
      return { version: app.getVersion() };
    } catch (error) {
      console.error("❌ Error getting app version:", error);
      throw error;
    }
  }

  async getUpdateStatus() {
    try {
      return {
        updateAvailable: this.updateAvailable,
        updateDownloaded: this.updateDownloaded,
        isDevelopment: process.env.NODE_ENV === "development",
        isDownloading: this.isDownloading,
        lastCheckedAt: this.lastCheckedAt,
      };
    } catch (error) {
      console.error("❌ Error getting update status:", error);
      throw error;
    }
  }

  async getUpdateInfo() {
    try {
      return this.lastUpdateInfo;
    } catch (error) {
      console.error("❌ Error getting update info:", error);
      throw error;
    }
  }

  checkForUpdatesOnStartup() {
    if (process.env.NODE_ENV !== "development") {
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
      }
      this.startupTimer = setTimeout(() => {
        console.log("🔄 Checking for updates on startup...");
        this.checkForUpdates().catch((err) => {
          console.error("Startup update check failed:", err);
        });
      }, 3000);
    }
  }

  cleanup() {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.eventListeners.forEach(({ event, handler }) => {
      autoUpdater.removeListener(event, handler);
    });
    this.eventListeners = [];
  }
}

module.exports = UpdateManager;
