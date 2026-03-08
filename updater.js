const { autoUpdater } = require("electron-updater");
const https = require("https");
const { app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

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

    this.setupAutoUpdater();
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

  getUpdaterPendingDir() {
    return path.join(app.getPath("cache"), "chordvox-updater", "pending");
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
        if (fileName && fileName.endsWith(".zip")) {
          const zipPath = path.join(pendingDir, fileName);
          if (fs.existsSync(zipPath)) {
            return zipPath;
          }
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
    const fallbackZipPath = path.join(pendingDir, fallbackZip);
    return fs.existsSync(fallbackZipPath) ? fallbackZipPath : null;
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
    if (!appBundleName.endsWith(".app")) {
      return { started: false, reason: "invalid-app-bundle-path", appBundlePath };
    }

    const scriptPath = path.join(app.getPath("temp"), `chordvox-self-update-${Date.now()}.sh`);
    const scriptContent = `#!/bin/bash
set -euo pipefail

APP_BUNDLE_PATH="$1"
ZIP_PATH="$2"
CURRENT_PID="$3"

if [ ! -f "$ZIP_PATH" ]; then
  exit 11
fi

for _ in $(seq 1 200); do
  if ! kill -0 "$CURRENT_PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

STAGING_DIR=$(mktemp -d /tmp/chordvox_update_XXXXXX)
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT INT TERM

ditto -x -k "$ZIP_PATH" "$STAGING_DIR"
NEW_APP="$STAGING_DIR/${appBundleName}"
if [ ! -d "$NEW_APP" ]; then
  NEW_APP=$(find "$STAGING_DIR" -maxdepth 3 -type d -name "*.app" | head -n 1 || true)
fi

if [ -z "\${NEW_APP:-}" ] || [ ! -d "$NEW_APP" ]; then
  exit 12
fi

TARGET_DIR=$(dirname "$APP_BUNDLE_PATH")
mkdir -p "$TARGET_DIR"

TMP_TARGET="\${APP_BUNDLE_PATH}.new.\$RANDOM"
rm -rf "$TMP_TARGET"
ditto "$NEW_APP" "$TMP_TARGET"
xattr -dr com.apple.quarantine "$TMP_TARGET" >/dev/null 2>&1 || true

BACKUP_PATH="\${APP_BUNDLE_PATH}.bak.\$(date +%s)"
if [ -d "$APP_BUNDLE_PATH" ]; then
  rm -rf "$BACKUP_PATH"
  mv "$APP_BUNDLE_PATH" "$BACKUP_PATH"
fi

mv "$TMP_TARGET" "$APP_BUNDLE_PATH"
open "$APP_BUNDLE_PATH" >/dev/null 2>&1 || true
`;

    fs.writeFileSync(scriptPath, scriptContent, "utf8");
    fs.chmodSync(scriptPath, 0o755);

    const worker = spawn("/bin/bash", [scriptPath, appBundlePath, zipPath, String(process.pid)], {
      detached: true,
      stdio: "ignore",
    });
    worker.unref();

    return { started: true, method: "mac-self-update", appBundlePath, zipPath };
  }

  getUpdateRepo() {
    const owner = (process.env.OPENWHISPR_UPDATE_OWNER || "GravityPoet").trim();
    const repo = (process.env.OPENWHISPR_UPDATE_REPO || "ChordVox").trim();
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
      const { owner, repo } = this.getUpdateRepo();
      const release = await this.fetchJson(
        `https://api.github.com/repos/${owner}/${repo}/releases/latest`
      );
      const latestTag = String(release.tag_name || "").trim();
      const latestVersion = latestTag.replace(/^v/i, "");
      if (!latestVersion) {
        return null;
      }

      const currentVersion = app.getVersion();
      const isNewer = this.compareVersions(latestVersion, currentVersion) > 0;
      if (!isNewer) {
        return {
          updateAvailable: false,
          latestVersion,
          currentVersion,
          manualDownloadUrl: release.html_url || null,
        };
      }

      const info = {
        version: latestVersion,
        releaseDate: release.published_at || null,
        releaseNotes: release.body || null,
        manualDownloadUrl: release.html_url || null,
        manualOnly: true,
        source: "github-fallback",
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
    const updateOwner = (process.env.OPENWHISPR_UPDATE_OWNER || "").trim();
    const updateRepo = (process.env.OPENWHISPR_UPDATE_REPO || "").trim();
    if (updateOwner && updateRepo) {
      autoUpdater.setFeedURL({
        provider: "github",
        owner: updateOwner,
        repo: updateRepo,
        private: false,
      });
    }

    // Production default: download updates automatically after detection.
    // Can be disabled with OPENWHISPR_AUTO_DOWNLOAD_UPDATES=false.
    autoUpdater.autoDownload =
      String(process.env.OPENWHISPR_AUTO_DOWNLOAD_UPDATES || "true").toLowerCase() !== "false";

    // Enable auto-install on quit - if user ignores update and quits normally,
    // the update will install automatically (best UX)
    // User can also manually trigger install with "Install & Restart" button
    autoUpdater.autoInstallOnAppQuit = true;

    // Enable logging in production for debugging (logs are user-accessible)
    autoUpdater.logger = console;

    // Set up event handlers
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    const handlers = {
      "checking-for-update": () => {
        this.notifyRenderers("checking-for-update");
      },
      "update-available": (info) => {
        this.updateAvailable = true;
        this.manualUpdateDownloadUrl = null;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
            manualDownloadUrl: info.manualDownloadUrl || null,
            manualOnly: info.manualOnly === true,
          };
        }
        this.notifyRenderers("update-available", info);
      },
      "update-not-available": (info) => {
        this.updateAvailable = false;
        this.updateDownloaded = false;
        this.isDownloading = false;
        this.manualUpdateDownloadUrl = null;
        this.lastUpdateInfo = null;
        this.notifyRenderers("update-not-available", info);
      },
      error: (err) => {
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
        console.log("✅ Update downloaded successfully:", info?.version);
        this.updateDownloaded = true;
        this.isDownloading = false;
        this.manualUpdateDownloadUrl = null;
        this.isInstalling = false;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-downloaded", info);
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
          releaseNotes: result.updateInfo.releaseNotes,
          manualDownloadUrl: null,
          manualOnly: false,
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
        error: error?.message || String(error),
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
        await shell.openExternal(this.manualUpdateDownloadUrl);
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

      // Remove listeners that prevent windows from closing
      // so quitAndInstall can shut down cleanly
      app.removeAllListeners("window-all-closed");
      BrowserWindow.getAllWindows().forEach((win) => {
        win.removeAllListeners("close");
      });

      const isSilent = process.platform === "win32";
      let installTriggered = false;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (installTriggered) {
            return;
          }
          this.isInstalling = false;
          const fallbackUrl =
            this.manualUpdateDownloadUrl ||
            this.lastUpdateInfo?.manualDownloadUrl ||
            `https://github.com/${this.getUpdateRepo().owner}/${this.getUpdateRepo().repo}/releases/latest`;
          this.manualUpdateDownloadUrl = fallbackUrl;
          reject(
            new Error(
              `AUTO_INSTALL_NOT_TRIGGERED: automatic installer did not start. Fallback URL: ${fallbackUrl}`
            )
          );
        }, 12000);

        const markTriggered = () => {
          installTriggered = true;
          clearTimeout(timeout);
          resolve(true);
        };

        autoUpdater.once("before-quit-for-update", markTriggered);

        try {
          autoUpdater.quitAndInstall(isSilent, true);
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      return { success: true, message: "Update installation started" };
    } catch (error) {
      this.isInstalling = false;
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
        this.checkForUpdates()
          .then((result) => {
            if (result?.updateAvailable && !result.manualOnly && autoUpdater.autoDownload === false) {
              return this.downloadUpdate().catch((downloadError) => {
                console.error("Startup auto-download failed:", downloadError);
                return null;
              });
            }
            return null;
          })
          .catch((err) => {
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
