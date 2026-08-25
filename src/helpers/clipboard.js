const { clipboard, dialog, systemPreferences } = require("electron");
const { spawn, spawnSync } = require("child_process");
const { killProcess } = require("../utils/process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");
const { i18nMain } = require("./i18nMain");

const CACHE_TTL_MS = 30000;

// macOS accessibility: once granted, permissions persist across app sessions,
// so use a long TTL. Denied results re-check quickly so granting takes effect fast.
const ACCESSIBILITY_GRANTED_TTL_MS = 24 * 60 * 60 * 1000;
const ACCESSIBILITY_DENIED_TTL_MS = 5000;

const getLinuxDesktopEnv = () =>
  [process.env.XDG_CURRENT_DESKTOP, process.env.XDG_SESSION_DESKTOP, process.env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(":")
    .toLowerCase();

const isGnomeDesktop = (desktopEnv) => desktopEnv.includes("gnome");

const isKdeDesktop = (desktopEnv) => desktopEnv.includes("kde");

const isWlrootsCompositor = (desktopEnv) => {
  const wlrootsDesktops = ["sway", "hyprland", "wayfire", "river", "dwl", "labwc", "cage"];
  return (
    wlrootsDesktops.some((wm) => desktopEnv.includes(wm)) ||
    !!process.env.SWAYSOCK ||
    !!process.env.HYPRLAND_INSTANCE_SIGNATURE
  );
};

const getLinuxSessionInfo = () => {
  const isWayland =
    (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
    !!process.env.WAYLAND_DISPLAY;
  const xwaylandAvailable = isWayland && !!process.env.DISPLAY;
  const desktopEnv = getLinuxDesktopEnv();
  const isGnome = isWayland && isGnomeDesktop(desktopEnv);
  const isKde = isWayland && isKdeDesktop(desktopEnv);
  const isWlroots = isWayland && isWlrootsCompositor(desktopEnv);

  return { isWayland, xwaylandAvailable, desktopEnv, isGnome, isKde, isWlroots };
};

const PASTE_DELAYS = {
  darwin: 120,
  win32_fast: 10,
  win32_nircmd: 30,
  win32_pwsh: 40,
  linux: 50,
};

function writeClipboardInRenderer(webContents, text) {
  if (!webContents || !webContents.executeJavaScript) {
    return Promise.reject(new Error("Invalid webContents for clipboard write"));
  }
  const escaped = JSON.stringify(text);
  return webContents.executeJavaScript(`navigator.clipboard.writeText(${escaped})`);
}

class ClipboardManager {
  constructor() {
    this.accessibilityCache = { value: null, expiresAt: 0 };
    this.accessibilityDialogDismissedForSession = false;
    this.accessibilityDialogOpen = false;
    this.activePasteRequests = new Map();
    this.commandAvailabilityCache = new Map();
    this.nircmdPath = null;
    this.nircmdChecked = false;
    this.fastPastePath = null;
    this.fastPasteChecked = false;
    this.winFastPastePath = null;
    this.winFastPasteChecked = false;
    this.linuxFastPastePath = null;
    this.linuxFastPasteChecked = false;
  }

  _isWayland() {
    if (process.platform !== "linux") return false;
    const { isWayland } = getLinuxSessionInfo();
    return isWayland;
  }

  _writeClipboardWayland(text, webContents) {
    if (this.commandExists("wl-copy")) {
      try {
        const result = spawnSync("wl-copy", ["--", text], { timeout: 2000 });
        if (result.status === 0) {
          clipboard.writeText(text);
          return;
        }
        // Don't swallow this: a non-zero wl-copy is the kind of clipboard failure
        // that ends with "text recognized but nothing pasted". Log, then fall back.
        this.safeLog("⚠️ wl-copy exited non-zero; falling back to renderer/Electron clipboard", {
          status: result.status,
        });
      } catch (error) {
        this.safeLog("⚠️ wl-copy threw; falling back to renderer/Electron clipboard", {
          error: error?.message,
        });
      }
    }

    if (webContents && !webContents.isDestroyed()) {
      writeClipboardInRenderer(webContents, text).catch((error) => {
        this.safeLog("⚠️ Renderer clipboard write failed; relying on Electron clipboard", {
          error: error?.message,
        });
      });
    }

    clipboard.writeText(text);
  }

  getNircmdPath() {
    if (this.nircmdChecked) {
      return this.nircmdPath;
    }

    this.nircmdChecked = true;

    if (process.platform !== "win32") {
      return null;
    }

    const possiblePaths = [
      path.join(process.resourcesPath, "bin", "nircmd.exe"),
      path.join(__dirname, "..", "..", "resources", "bin", "nircmd.exe"),
      path.join(process.cwd(), "resources", "bin", "nircmd.exe"),
    ];

    for (const nircmdPath of possiblePaths) {
      try {
        if (fs.existsSync(nircmdPath)) {
          this.safeLog(`✅ Found nircmd.exe at: ${nircmdPath}`);
          this.nircmdPath = nircmdPath;
          return nircmdPath;
        }
      } catch (error) {}
    }

    this.safeLog("⚠️ nircmd.exe not found, will use PowerShell fallback");
    return null;
  }

  getNircmdStatus() {
    if (process.platform !== "win32") {
      return { available: false, reason: "Not Windows" };
    }
    const nircmdPath = this.getNircmdPath();
    return {
      available: !!nircmdPath,
      path: nircmdPath,
    };
  }

  _resolveNativeBinary(binaryName, platform, cacheKeyChecked, cacheKeyPath) {
    if (this[cacheKeyChecked]) {
      return this[cacheKeyPath];
    }
    this[cacheKeyChecked] = true;

    if (process.platform !== platform) {
      return null;
    }

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of candidates) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            fs.chmodSync(candidate, 0o755);
          }
          this[cacheKeyPath] = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  resolveFastPasteBinary() {
    return this._resolveNativeBinary(
      "macos-fast-paste",
      "darwin",
      "fastPasteChecked",
      "fastPastePath"
    );
  }

  resolveWindowsFastPasteBinary() {
    return this._resolveNativeBinary(
      "windows-fast-paste.exe",
      "win32",
      "winFastPasteChecked",
      "winFastPastePath"
    );
  }

  resolveLinuxFastPasteBinary() {
    return this._resolveNativeBinary(
      "linux-fast-paste",
      "linux",
      "linuxFastPasteChecked",
      "linuxFastPastePath"
    );
  }

  _isYdotoolDaemonRunning() {
    const uid = process.getuid?.();
    const socketPaths = [
      process.env.YDOTOOL_SOCKET,
      uid != null ? `/run/user/${uid}/.ydotool_socket` : null,
      "/tmp/.ydotool_socket",
    ].filter(Boolean);

    for (const socketPath of socketPaths) {
      try {
        if (fs.statSync(socketPath)) return true;
      } catch {}
    }

    try {
      return spawnSync("pidof", ["ydotoold"], { timeout: 1000 }).status === 0;
    } catch {
      return false;
    }
  }

  _canAccessUinput() {
    if (process.platform !== "linux") return false;
    const now = Date.now();
    if (this._uinputCache && now < this._uinputCache.expiresAt) {
      return this._uinputCache.accessible;
    }
    let accessible = false;
    try {
      fs.accessSync("/dev/uinput", fs.constants.W_OK);
      accessible = true;
    } catch {}
    this._uinputCache = { accessible, expiresAt: now + 30000 };
    return accessible;
  }

  safeLog(...args) {
    if (process.env.NODE_ENV === "development") {
      try {
        console.log(...args);
      } catch (error) {
        // Silently ignore EPIPE errors in logging
        if (error.code !== "EPIPE") {
          process.stderr.write(`Log error: ${error.message}\n`);
        }
      }
    }
  }

  _createPasteCancelledError() {
    const error = new Error("Paste cancelled");
    error.code = "PASTE_CANCELLED";
    error.suppressRendererToast = true;
    return error;
  }

  _isPasteCancelledError(error) {
    return error?.code === "PASTE_CANCELLED";
  }

  _registerPasteRequest(pasteRequestId) {
    if (!pasteRequestId) {
      return null;
    }

    const normalizedId = String(pasteRequestId).trim();
    if (!normalizedId) {
      return null;
    }

    const request = {
      id: normalizedId,
      cancelled: false,
      activeTimer: null,
      activeProcess: null,
      cancelHandler: null,
    };
    this.activePasteRequests.set(normalizedId, request);
    return request;
  }

  _clearPasteRequestTimer(pasteRequest) {
    if (pasteRequest?.activeTimer) {
      clearTimeout(pasteRequest.activeTimer);
      pasteRequest.activeTimer = null;
    }
  }

  _setPasteRequestTimer(pasteRequest, timer) {
    if (!pasteRequest) {
      return;
    }

    this._clearPasteRequestTimer(pasteRequest);
    pasteRequest.activeTimer = timer;
  }

  _attachPasteRequestProcess(pasteRequest, processRef) {
    if (!pasteRequest) {
      return;
    }

    pasteRequest.activeProcess = processRef;
  }

  _setPasteRequestCancelHandler(pasteRequest, cancelHandler) {
    if (!pasteRequest) {
      return;
    }

    pasteRequest.cancelHandler = cancelHandler;
  }

  _clearPasteRequestCancelHandler(pasteRequest) {
    if (!pasteRequest) {
      return;
    }

    pasteRequest.cancelHandler = null;
  }

  _detachPasteRequestProcess(pasteRequest, processRef = null) {
    if (!pasteRequest) {
      return;
    }

    if (!processRef || pasteRequest.activeProcess === processRef) {
      pasteRequest.activeProcess = null;
    }
  }

  _ensurePasteRequestActive(pasteRequest) {
    if (pasteRequest?.cancelled) {
      throw this._createPasteCancelledError();
    }
  }

  _finalizePasteRequest(pasteRequest) {
    if (!pasteRequest) {
      return;
    }

    this._clearPasteRequestTimer(pasteRequest);
    this._detachPasteRequestProcess(pasteRequest);
    this._clearPasteRequestCancelHandler(pasteRequest);
    this.activePasteRequests.delete(pasteRequest.id);
  }

  cancelPasteRequest(pasteRequestId) {
    const normalizedId = String(pasteRequestId || "").trim();
    if (!normalizedId) {
      return { cancelled: false };
    }

    const pasteRequest = this.activePasteRequests.get(normalizedId);
    if (!pasteRequest) {
      return { cancelled: false };
    }

    pasteRequest.cancelled = true;
    this._clearPasteRequestTimer(pasteRequest);

    if (pasteRequest.activeProcess) {
      try {
        killProcess(pasteRequest.activeProcess, "SIGKILL");
      } catch {}
    }

    pasteRequest.cancelHandler?.();
    this._clearPasteRequestCancelHandler(pasteRequest);

    return { cancelled: true };
  }

  _runCancelableDelay(pasteRequest, delayMs, operation) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this._clearPasteRequestTimer(pasteRequest);
        this._clearPasteRequestCancelHandler(pasteRequest);
        callback(value);
      };

      this._setPasteRequestCancelHandler(pasteRequest, () => {
        finish(reject, this._createPasteCancelledError());
      });

      const begin = async () => {
        this._clearPasteRequestTimer(pasteRequest);
        try {
          this._ensurePasteRequestActive(pasteRequest);
          const result = await operation();
          finish(resolve, result);
        } catch (error) {
          finish(reject, error);
        }
      };

      const timer = setTimeout(
        () => {
          void begin();
        },
        Math.max(0, delayMs)
      );
      this._setPasteRequestTimer(pasteRequest, timer);
    });
  }

  commandExists(cmd) {
    const commandName = String(cmd || "").trim();
    if (!/^[A-Za-z0-9._+-]+$/.test(commandName)) {
      return false;
    }
    const now = Date.now();
    const cached = this.commandAvailabilityCache.get(commandName);
    if (cached && now < cached.expiresAt) {
      return cached.exists;
    }
    try {
      const res = spawnSync("which", [commandName], {
        stdio: "ignore",
        timeout: 1000,
      });
      const exists = res.status === 0;
      this.commandAvailabilityCache.set(commandName, {
        exists,
        expiresAt: now + CACHE_TTL_MS,
      });
      return exists;
    } catch {
      this.commandAvailabilityCache.set(commandName, {
        exists: false,
        expiresAt: now + CACHE_TTL_MS,
      });
      return false;
    }
  }

  async pasteText(text, options = {}) {
    const startTime = Date.now();
    const platform = process.platform;
    let method = "unknown";
    const webContents = options.webContents;
    const suppressAccessibilityDialog = Boolean(options.suppressAccessibilityDialog);
    const pasteRequest = this._registerPasteRequest(options.pasteRequestId);

    try {
      this._ensurePasteRequestActive(pasteRequest);
      const originalClipboard = clipboard.readText();
      this.safeLog(
        "💾 Saved original clipboard content:",
        originalClipboard.substring(0, 50) + "..."
      );

      if (platform === "linux" && this._isWayland()) {
        this._writeClipboardWayland(text, webContents);
      } else {
        clipboard.writeText(text);
      }
      this.safeLog("📋 Text copied to clipboard:", text.substring(0, 50) + "...");

      if (platform === "darwin") {
        this._ensurePasteRequestActive(pasteRequest);
        method = this.resolveFastPasteBinary() ? "cgevent" : "applescript";
        this.safeLog("🔍 Checking accessibility permissions for paste operation...");
        const permissionState = await this.checkAccessibilityPermissions({
          showDialog: !suppressAccessibilityDialog,
          returnMeta: true,
        });
        const hasPermissions =
          typeof permissionState === "object" ? permissionState.allowed : Boolean(permissionState);
        const dialogShown = permissionState?.dialogShown === true;

        if (!hasPermissions) {
          this.safeLog("⚠️ No accessibility permissions - text copied to clipboard only");
          throw this._createAccessibilityPasteError("", {
            ...this._buildAccessibilityUiState({ dialogShown }),
          });
        }

        this.safeLog("✅ Permissions granted, attempting to paste...");
        await this.pasteMacOS(originalClipboard, { ...options, pasteRequest });
      } else if (platform === "win32") {
        this._ensurePasteRequestActive(pasteRequest);
        const winFastPaste = this.resolveWindowsFastPasteBinary();
        if (winFastPaste) {
          method = "sendinput";
        } else {
          const nircmdPath = this.getNircmdPath();
          method = nircmdPath ? "nircmd" : "powershell";
        }
        await this.pasteWindows(originalClipboard, pasteRequest);
      } else {
        this._ensurePasteRequestActive(pasteRequest);
        method = this.resolveLinuxFastPasteBinary() ? "linux-xtest" : "linux-tools";
        await this.pasteLinux(originalClipboard, { ...options, pasteRequest });
      }

      this.safeLog("✅ Paste operation complete", {
        platform,
        method,
        elapsedMs: Date.now() - startTime,
        textLength: text.length,
      });
    } catch (error) {
      this.safeLog("❌ Paste operation failed", {
        platform,
        method,
        elapsedMs: Date.now() - startTime,
        error: error.message,
      });
      throw error;
    } finally {
      this._finalizePasteRequest(pasteRequest);
    }
  }

  _isMacAccessibilityError(rawError = "") {
    const normalized = String(rawError || "").toLowerCase();
    return (
      normalized.includes("not authorized to send apple events") ||
      normalized.includes("not allowed assistive access") ||
      normalized.includes("system events got an error") ||
      (normalized.includes("osascript") && normalized.includes("not authorized")) ||
      normalized.includes("(-1719)") ||
      normalized.includes("(-1743)") ||
      normalized.includes("(-25211)") ||
      normalized.includes("accessibility permissions required")
    );
  }

  _createAccessibilityPasteError(rawError = "", options = {}) {
    const detail = String(rawError || "").trim();
    const suffix = detail
      ? ` ${i18nMain.t("hooks.clipboard.pasteFailed.detailPrefix")}${detail}`
      : "";
    const error = new Error(
      i18nMain.t("hooks.clipboard.pasteFailed.autoPasteAccessibilityRequired") + suffix
    );
    error.code = "PASTE_ACCESSIBILITY_REQUIRED";
    error.requiresAccessibilityPermission = true;
    error.handledBySystemDialog = Boolean(options.handledBySystemDialog);
    error.suppressRendererToast = Boolean(options.suppressRendererToast);
    return error;
  }

  _shouldPresentAccessibilityDialog(showDialog) {
    return (
      showDialog !== false &&
      !this.accessibilityDialogDismissedForSession &&
      !this.accessibilityDialogOpen
    );
  }

  shouldSuppressAccessibilityUiForSession() {
    if (process.platform !== "darwin" || !this.accessibilityDialogDismissedForSession) {
      return false;
    }

    try {
      const allowed = Boolean(systemPreferences?.isTrustedAccessibilityClient?.(false));
      if (allowed) {
        this.accessibilityDialogDismissedForSession = false;
        this.accessibilityCache = {
          value: true,
          expiresAt: Date.now() + ACCESSIBILITY_GRANTED_TTL_MS,
        };
        return false;
      }
    } catch {
      // Ignore and fall back to the last denied state.
    }

    return true;
  }

  _buildAccessibilityUiState({ dialogShown = false } = {}) {
    return {
      handledBySystemDialog: dialogShown,
      suppressRendererToast: dialogShown || this.shouldSuppressAccessibilityUiForSession(),
    };
  }

  async pasteMacOS(originalClipboard, options = {}) {
    const fastPasteBinary = this.resolveFastPasteBinary();
    const useFastPaste = !!fastPasteBinary;
    const pasteDelay = options.fromStreaming ? (useFastPaste ? 15 : 50) : PASTE_DELAYS.darwin;
    const pasteRequest = options.pasteRequest || null;

    return new Promise((resolve, reject) => {
      this._setPasteRequestCancelHandler(pasteRequest, () => {
        reject(this._createPasteCancelledError());
      });

      const beginPaste = () => {
        try {
          this._ensurePasteRequestActive(pasteRequest);
        } catch (error) {
          this._clearPasteRequestCancelHandler(pasteRequest);
          reject(error);
          return;
        }

        const pasteProcess = useFastPaste
          ? spawn(fastPasteBinary)
          : spawn("osascript", [
              "-e",
              'tell application "System Events" to key code 9 using command down',
            ]);
        this._attachPasteRequestProcess(pasteRequest, pasteProcess);

        let errorOutput = "";
        let hasTimedOut = false;

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();
          this._detachPasteRequestProcess(pasteRequest, pasteProcess);
          this._clearPasteRequestCancelHandler(pasteRequest);

          if (pasteRequest?.cancelled) {
            reject(this._createPasteCancelledError());
            return;
          }

          if (code === 0) {
            this.safeLog(`Text pasted successfully via ${useFastPaste ? "CGEvent" : "osascript"}`);
            this.safeLog("📌 Keeping transcribed text in clipboard");
            resolve();
          } else if (useFastPaste) {
            this.safeLog(
              code === 2
                ? "CGEvent binary lacks accessibility trust, falling back to osascript"
                : `CGEvent paste failed (code ${code}), falling back to osascript`
            );
            this.fastPasteChecked = true;
            this.fastPastePath = null;
            this.pasteMacOSWithOsascript(originalClipboard, options).then(resolve).catch(reject);
          } else {
            this.accessibilityCache = { value: null, expiresAt: 0 };
            if (this._isMacAccessibilityError(errorOutput)) {
              const dialogShown =
                !options.suppressAccessibilityDialog && this.showAccessibilityDialog(errorOutput);
              reject(
                this._createAccessibilityPasteError(errorOutput, {
                  ...this._buildAccessibilityUiState({ dialogShown }),
                })
              );
              return;
            }
            const errorMsg = `Paste failed (code ${code}). Text is copied to clipboard - please paste manually with Cmd+V.`;
            reject(new Error(errorMsg));
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();
          this._detachPasteRequestProcess(pasteRequest, pasteProcess);
          this._clearPasteRequestCancelHandler(pasteRequest);

          if (pasteRequest?.cancelled) {
            reject(this._createPasteCancelledError());
            return;
          }

          if (useFastPaste) {
            this.safeLog("CGEvent paste error, falling back to osascript");
            this.fastPasteChecked = true;
            this.fastPastePath = null;
            this.pasteMacOSWithOsascript(originalClipboard, options).then(resolve).catch(reject);
          } else {
            const errorMsg = `Paste command failed: ${error.message}. Text is copied to clipboard - please paste manually with Cmd+V.`;
            reject(new Error(errorMsg));
          }
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          this._detachPasteRequestProcess(pasteRequest, pasteProcess);
          this._clearPasteRequestCancelHandler(pasteRequest);
          const errorMsg =
            "Paste operation timed out. Text is copied to clipboard - please paste manually with Cmd+V.";
          reject(new Error(errorMsg));
        }, 3000);
      };

      const delayTimer = setTimeout(() => {
        this._clearPasteRequestTimer(pasteRequest);
        beginPaste();
      }, pasteDelay);
      this._setPasteRequestTimer(pasteRequest, delayTimer);
    });
  }

  async pasteMacOSWithOsascript(originalClipboard, options = {}) {
    const pasteRequest = options.pasteRequest || null;
    return new Promise((resolve, reject) => {
      this._setPasteRequestCancelHandler(pasteRequest, () => {
        reject(this._createPasteCancelledError());
      });

      try {
        this._ensurePasteRequestActive(pasteRequest);
      } catch (error) {
        this._clearPasteRequestCancelHandler(pasteRequest);
        reject(error);
        return;
      }

      const pasteProcess = spawn("osascript", [
        "-e",
        'tell application "System Events" to key code 9 using command down',
      ]);
      this._attachPasteRequestProcess(pasteRequest, pasteProcess);

      let errorOutput = "";
      let hasTimedOut = false;

      pasteProcess.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });

      pasteProcess.on("close", (code) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        pasteProcess.removeAllListeners();
        this._detachPasteRequestProcess(pasteRequest, pasteProcess);
        this._clearPasteRequestCancelHandler(pasteRequest);

        if (pasteRequest?.cancelled) {
          reject(this._createPasteCancelledError());
          return;
        }

        if (code === 0) {
          this.safeLog("Text pasted successfully via osascript fallback");
          this.safeLog("📌 Keeping transcribed text in clipboard");
          resolve();
        } else {
          this.accessibilityCache = { value: null, expiresAt: 0 };
          if (this._isMacAccessibilityError(errorOutput)) {
            const dialogShown =
              !options.suppressAccessibilityDialog && this.showAccessibilityDialog(errorOutput);
            reject(
              this._createAccessibilityPasteError(errorOutput, {
                ...this._buildAccessibilityUiState({ dialogShown }),
              })
            );
            return;
          }
          const errorMsg = `Paste failed (code ${code}). Text is copied to clipboard - please paste manually with Cmd+V.`;
          reject(new Error(errorMsg));
        }
      });

      pasteProcess.on("error", (error) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        pasteProcess.removeAllListeners();
        this._detachPasteRequestProcess(pasteRequest, pasteProcess);
        this._clearPasteRequestCancelHandler(pasteRequest);

        if (pasteRequest?.cancelled) {
          reject(this._createPasteCancelledError());
          return;
        }
        if (this._isMacAccessibilityError(error.message)) {
          this.accessibilityCache = { value: null, expiresAt: 0 };
          const dialogShown =
            !options.suppressAccessibilityDialog && this.showAccessibilityDialog(error.message);
          reject(
            this._createAccessibilityPasteError(error.message, {
              ...this._buildAccessibilityUiState({ dialogShown }),
            })
          );
          return;
        }
        const errorMsg = `Paste command failed: ${error.message}. Text is copied to clipboard - please paste manually with Cmd+V.`;
        reject(new Error(errorMsg));
      });

      const timeoutId = setTimeout(() => {
        hasTimedOut = true;
        killProcess(pasteProcess, "SIGKILL");
        pasteProcess.removeAllListeners();
        this._detachPasteRequestProcess(pasteRequest, pasteProcess);
        this._clearPasteRequestCancelHandler(pasteRequest);
        reject(
          new Error(
            "Paste operation timed out. Text is copied to clipboard - please paste manually with Cmd+V."
          )
        );
      }, 3000);
    });
  }

  async pasteWindows(originalClipboard, pasteRequest = null) {
    const fastPastePath = this.resolveWindowsFastPasteBinary();

    if (fastPastePath) {
      return this.pasteWithFastPaste(fastPastePath, originalClipboard, pasteRequest);
    }

    return this.pasteWithNircmdOrPowerShell(originalClipboard, pasteRequest);
  }

  async pasteWithFastPaste(fastPastePath, originalClipboard, pasteRequest = null) {
    return this._runCancelableDelay(pasteRequest, PASTE_DELAYS.win32_fast, () => {
      return new Promise((resolve, reject) => {
        let hasTimedOut = false;
        let finished = false;
        const startTime = Date.now();

        this.safeLog("⚡ Windows fast-paste starting");

        const pasteProcess = spawn(fastPastePath, [], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        this._attachPasteRequestProcess(pasteRequest, pasteProcess);

        let stdoutData = "";
        let stderrData = "";

        const cleanup = () => {
          clearTimeout(timeoutId);
          this._detachPasteRequestProcess(pasteRequest, pasteProcess);
        };

        const fallback = () => {
          if (finished) return;
          finished = true;
          cleanup();
          if (pasteRequest?.cancelled) {
            reject(this._createPasteCancelledError());
            return;
          }
          this.pasteWithNircmdOrPowerShell(originalClipboard, pasteRequest)
            .then(resolve)
            .catch(reject);
        };

        pasteProcess.stdout.on("data", (data) => {
          stdoutData += data.toString();
        });

        pasteProcess.stderr.on("data", (data) => {
          stderrData += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (finished) return;
          if (pasteRequest?.cancelled) {
            finished = true;
            cleanup();
            reject(this._createPasteCancelledError());
            return;
          }
          if (hasTimedOut) return;

          const elapsed = Date.now() - startTime;
          const output = stdoutData.trim();

          if (code === 0) {
            finished = true;
            cleanup();
            this.safeLog("✅ Windows fast-paste success", {
              elapsedMs: elapsed,
              output,
            });
            this.safeLog("📌 Keeping transcribed text in clipboard");
            resolve();
          } else {
            this.safeLog(
              `❌ Windows fast-paste failed (code ${code}), falling back to nircmd/PowerShell`,
              { elapsedMs: elapsed, stderr: stderrData.trim() }
            );
            fallback();
          }
        });

        pasteProcess.on("error", (error) => {
          if (finished || hasTimedOut) return;
          this.safeLog("❌ Windows fast-paste error, falling back to nircmd/PowerShell", {
            elapsedMs: Date.now() - startTime,
            error: error.message,
          });
          fallback();
        });

        const timeoutId = setTimeout(() => {
          if (finished) return;
          hasTimedOut = true;
          this.safeLog("⏱️ Windows fast-paste timeout, falling back to nircmd/PowerShell");
          killProcess(pasteProcess, "SIGKILL");
          fallback();
        }, 2000);
      });
    });
  }

  async pasteWithNircmdOrPowerShell(originalClipboard, pasteRequest = null) {
    this._ensurePasteRequestActive(pasteRequest);
    const nircmdPath = this.getNircmdPath();
    if (nircmdPath) {
      return this.pasteWithNircmd(nircmdPath, originalClipboard, pasteRequest);
    }
    return this.pasteWithPowerShell(originalClipboard, pasteRequest);
  }

  async pasteWithNircmd(nircmdPath, originalClipboard, pasteRequest = null) {
    const pasteDelay = PASTE_DELAYS.win32_nircmd;
    return this._runCancelableDelay(pasteRequest, pasteDelay, () => {
      return new Promise((resolve, reject) => {
        let hasTimedOut = false;
        let finished = false;
        const startTime = Date.now();

        this.safeLog(`⚡ nircmd paste starting (delay: ${pasteDelay}ms)`);

        const pasteProcess = spawn(nircmdPath, ["sendkeypress", "ctrl+v"]);
        this._attachPasteRequestProcess(pasteRequest, pasteProcess);

        let errorOutput = "";

        const cleanup = () => {
          clearTimeout(timeoutId);
          this._detachPasteRequestProcess(pasteRequest, pasteProcess);
        };

        const fallback = () => {
          if (finished) return;
          finished = true;
          cleanup();
          if (pasteRequest?.cancelled) {
            reject(this._createPasteCancelledError());
            return;
          }
          this.pasteWithPowerShell(originalClipboard, pasteRequest).then(resolve).catch(reject);
        };

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (finished) return;
          if (pasteRequest?.cancelled) {
            finished = true;
            cleanup();
            reject(this._createPasteCancelledError());
            return;
          }
          if (hasTimedOut) return;

          const elapsed = Date.now() - startTime;

          if (code === 0) {
            finished = true;
            cleanup();
            this.safeLog(`✅ nircmd paste success`, {
              elapsedMs: elapsed,
            });
            this.safeLog("📌 Keeping transcribed text in clipboard");
            resolve();
          } else {
            this.safeLog(`❌ nircmd failed (code ${code}), falling back to PowerShell`, {
              elapsedMs: elapsed,
              stderr: errorOutput,
            });
            fallback();
          }
        });

        pasteProcess.on("error", (error) => {
          if (finished || hasTimedOut) return;
          const elapsed = Date.now() - startTime;
          this.safeLog(`❌ nircmd error, falling back to PowerShell`, {
            elapsedMs: elapsed,
            error: error.message,
          });
          fallback();
        });

        const timeoutId = setTimeout(() => {
          if (finished) return;
          hasTimedOut = true;
          const elapsed = Date.now() - startTime;
          this.safeLog(`⏱️ nircmd timeout, falling back to PowerShell`, { elapsedMs: elapsed });
          killProcess(pasteProcess, "SIGKILL");
          fallback();
        }, 2000);
      });
    });
  }

  async pasteWithPowerShell(originalClipboard, pasteRequest = null) {
    const pasteDelay = PASTE_DELAYS.win32_pwsh;
    return this._runCancelableDelay(pasteRequest, pasteDelay, () => {
      return new Promise((resolve, reject) => {
        let hasTimedOut = false;
        let finished = false;
        const startTime = Date.now();

        this.safeLog(`🪟 PowerShell paste starting (delay: ${pasteDelay}ms)`);

        const pasteProcess = spawn("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.SendKeys]::SendWait('^v')",
        ]);
        this._attachPasteRequestProcess(pasteRequest, pasteProcess);

        let errorOutput = "";

        const cleanup = () => {
          clearTimeout(timeoutId);
          this._detachPasteRequestProcess(pasteRequest, pasteProcess);
        };

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (finished) return;
          if (pasteRequest?.cancelled) {
            finished = true;
            cleanup();
            reject(this._createPasteCancelledError());
            return;
          }
          if (hasTimedOut) return;
          finished = true;
          cleanup();

          const elapsed = Date.now() - startTime;

          if (code === 0) {
            this.safeLog(`✅ PowerShell paste success`, {
              elapsedMs: elapsed,
            });
            this.safeLog("📌 Keeping transcribed text in clipboard");
            resolve();
          } else {
            this.safeLog(`❌ PowerShell paste failed`, {
              code,
              elapsedMs: elapsed,
              stderr: errorOutput,
            });
            reject(
              new Error(
                `Windows paste failed with code ${code}. Text is copied to clipboard - please paste manually with Ctrl+V.`
              )
            );
          }
        });

        pasteProcess.on("error", (error) => {
          if (finished || hasTimedOut) return;
          finished = true;
          cleanup();
          const elapsed = Date.now() - startTime;
          this.safeLog(`❌ PowerShell paste error`, {
            elapsedMs: elapsed,
            error: error.message,
          });
          reject(
            new Error(
              `Windows paste failed: ${error.message}. Text is copied to clipboard - please paste manually with Ctrl+V.`
            )
          );
        });

        const timeoutId = setTimeout(() => {
          if (finished) return;
          finished = true;
          hasTimedOut = true;
          const elapsed = Date.now() - startTime;
          this.safeLog(`⏱️ PowerShell paste timeout`, { elapsedMs: elapsed });
          killProcess(pasteProcess, "SIGKILL");
          cleanup();
          reject(
            new Error(
              "Paste operation timed out. Text is copied to clipboard - please paste manually with Ctrl+V."
            )
          );
        }, 5000);
      });
    });
  }

  async pasteLinux(originalClipboard, options = {}) {
    const { isWayland, xwaylandAvailable, isGnome, isKde, isWlroots } = getLinuxSessionInfo();
    const webContents = options.webContents;
    const pasteRequest = options.pasteRequest || null;
    this._ensurePasteRequestActive(pasteRequest);
    const xdotoolExists = this.commandExists("xdotool");
    const wtypeExists = this.commandExists("wtype");
    const ydotoolExists = this.commandExists("ydotool");
    const ydotoolDaemonRunning = ydotoolExists && this._isYdotoolDaemonRunning();
    const linuxFastPaste = this.resolveLinuxFastPasteBinary();

    debugLogger.debug(
      "Linux paste environment",
      {
        isWayland,
        xwaylandAvailable,
        isGnome,
        isKde,
        isWlroots,
        linuxFastPaste: !!linuxFastPaste,
        canAccessUinput: this._canAccessUinput(),
        xdotoolExists,
        wtypeExists,
        ydotoolExists,
        ydotoolDaemonRunning,
        display: process.env.DISPLAY,
        waylandDisplay: process.env.WAYLAND_DISPLAY,
        xdgSessionType: process.env.XDG_SESSION_TYPE,
        xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP,
      },
      "clipboard"
    );

    const keepClipboard = () => {
      this.safeLog("📌 Keeping transcribed text in clipboard");
    };

    const terminalClasses = [
      "konsole",
      "gnome-terminal",
      "terminal",
      "kitty",
      "alacritty",
      "terminator",
      "xterm",
      "urxvt",
      "rxvt",
      "tilix",
      "terminology",
      "wezterm",
      "foot",
      "st",
      "yakuake",
      "ghostty",
      "guake",
      "tilda",
      "hyper",
      "tabby",
      "sakura",
      "warp",
    ];

    // Pre-detect the target window BEFORE our window takes focus or blurs,
    // so the fast-paste binary and fallback tools know where to send keystrokes.
    const preDetectTargetWindow = () => {
      if (!xdotoolExists || (isWayland && !xwaylandAvailable)) return null;
      try {
        const result = spawnSync("xdotool", ["getactivewindow"]);
        return result.status === 0 ? result.stdout.toString().trim() || null : null;
      } catch {
        return null;
      }
    };

    const preDetectWindowClass = (windowId) => {
      if (!xdotoolExists || (isWayland && !xwaylandAvailable)) return null;
      try {
        const args = windowId
          ? ["getwindowclassname", windowId]
          : ["getactivewindow", "getwindowclassname"];
        const result = spawnSync("xdotool", args);
        return result.status === 0 ? result.stdout.toString().toLowerCase().trim() || null : null;
      } catch {
        return null;
      }
    };

    const targetWindowId = preDetectTargetWindow();
    const xdotoolWindowClass = preDetectWindowClass(targetWindowId);

    if (linuxFastPaste) {
      const earlyIsTerminal = xdotoolWindowClass
        ? terminalClasses.some((t) => xdotoolWindowClass.includes(t))
        : false;

      const spawnFastPaste = (args, label) =>
        new Promise((resolve, reject) => {
          try {
            this._ensurePasteRequestActive(pasteRequest);
          } catch (error) {
            reject(error);
            return;
          }
          debugLogger.debug(
            `Attempting native linux-fast-paste (${label})`,
            { linuxFastPaste, args, targetWindowId, xdotoolWindowClass, earlyIsTerminal },
            "clipboard"
          );
          const proc = spawn(linuxFastPaste, args);
          this._attachPasteRequestProcess(pasteRequest, proc);
          let stderr = "";

          const cleanup = () => {
            clearTimeout(timeoutId);
            this._detachPasteRequestProcess(pasteRequest, proc);
          };

          proc.stderr?.on("data", (data) => {
            stderr += data.toString();
          });

          let timedOut = false;
          const timeoutId = setTimeout(() => {
            timedOut = true;
            killProcess(proc, "SIGKILL");
          }, 2000);

          proc.on("close", (code) => {
            cleanup();
            if (pasteRequest?.cancelled) {
              reject(this._createPasteCancelledError());
              return;
            }
            if (timedOut) return reject(new Error("linux-fast-paste timed out"));
            if (code === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `linux-fast-paste exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
                )
              );
            }
          });

          proc.on("error", (error) => {
            if (timedOut) return;
            cleanup();
            if (pasteRequest?.cancelled) {
              reject(this._createPasteCancelledError());
              return;
            }
            reject(error);
          });
        });

      if (isWayland) {
        const uinputArgs = ["--uinput"];
        if (earlyIsTerminal) uinputArgs.push("--terminal");

        try {
          await spawnFastPaste(uinputArgs, "uinput");
          this.safeLog("✅ Paste successful using native linux-fast-paste (uinput)");
          debugLogger.info(
            "Paste successful",
            { tool: "linux-fast-paste", method: "uinput" },
            "clipboard"
          );
          keepClipboard();
          return;
        } catch (uinputError) {
          if (this._isPasteCancelledError(uinputError)) throw uinputError;
          debugLogger.warn("uinput paste failed", { error: uinputError?.message }, "clipboard");

          if (xwaylandAvailable) {
            const xtestArgs = [];
            if (targetWindowId) xtestArgs.push("--window", targetWindowId);
            if (earlyIsTerminal) xtestArgs.push("--terminal");

            try {
              await spawnFastPaste(xtestArgs, "XTest/XWayland fallback");
              this.safeLog("✅ Paste successful using native linux-fast-paste (XTest/XWayland)");
              debugLogger.info(
                "Paste successful",
                { tool: "linux-fast-paste", method: "xtest-xwayland" },
                "clipboard"
              );
              keepClipboard();
              return;
            } catch (xtestError) {
              if (this._isPasteCancelledError(xtestError)) throw xtestError;
              debugLogger.warn(
                "XTest/XWayland fallback also failed",
                { error: xtestError?.message },
                "clipboard"
              );
            }
          }

          this.safeLog(
            `⚠️ Native linux-fast-paste failed: ${uinputError?.message || uinputError}, falling back to system tools`
          );
        }
      } else {
        const xtestArgs = [];
        if (targetWindowId) xtestArgs.push("--window", targetWindowId);
        if (earlyIsTerminal) xtestArgs.push("--terminal");

        try {
          await spawnFastPaste(xtestArgs, "XTest");
          this.safeLog("✅ Paste successful using native linux-fast-paste (XTest)");
          debugLogger.info(
            "Paste successful",
            { tool: "linux-fast-paste", method: "xtest" },
            "clipboard"
          );
          keepClipboard();
          return;
        } catch (error) {
          if (this._isPasteCancelledError(error)) throw error;
          this.safeLog(
            `⚠️ Native linux-fast-paste failed: ${error?.message || error}, falling back to system tools`
          );
          debugLogger.warn(
            "Native linux-fast-paste failed, falling back",
            { error: error?.message },
            "clipboard"
          );
        }
      }
    }

    // Terminals use Ctrl+Shift+V instead of Ctrl+V
    const isTerminal = () => {
      if (xdotoolWindowClass) {
        const isTerminalWindow = terminalClasses.some((term) => xdotoolWindowClass.includes(term));
        if (isTerminalWindow) {
          this.safeLog(`🖥️ Terminal detected via xdotool: ${xdotoolWindowClass}`);
        }
        return isTerminalWindow;
      }

      try {
        if (this.commandExists("kdotool")) {
          const windowIdResult = spawnSync("kdotool", ["getactivewindow"]);
          if (windowIdResult.status === 0) {
            const windowId = windowIdResult.stdout.toString().trim();
            const classResult = spawnSync("kdotool", ["getwindowclassname", windowId]);
            if (classResult.status === 0) {
              const className = classResult.stdout.toString().toLowerCase().trim();
              const isTerminalWindow = terminalClasses.some((term) => className.includes(term));
              if (isTerminalWindow) {
                this.safeLog(`🖥️ Terminal detected via kdotool: ${className}`);
              }
              return isTerminalWindow;
            }
          }
        }
      } catch {}
      return false;
    };

    const inTerminal = isTerminal();
    const pasteKeys = inTerminal ? "ctrl+shift+v" : "ctrl+v";

    const canUseWtype = isWayland && isWlroots;
    const canUseYdotool = ydotoolDaemonRunning;
    const canUseXdotool = isWayland ? xwaylandAvailable && xdotoolExists : xdotoolExists;

    // windowactivate ensures the target window (not ours) receives the keystroke
    const xdotoolArgs = targetWindowId
      ? ["windowactivate", "--sync", targetWindowId, "key", pasteKeys]
      : ["key", pasteKeys];

    if (targetWindowId) {
      this.safeLog(
        `🎯 Targeting window ID ${targetWindowId} for paste (class: ${xdotoolWindowClass})`
      );
    }

    // Raw keycodes work across both ydotool 0.1.x and 1.0.x (key names silently fail on 1.0.x)
    // 29 = KEY_LEFTCTRL, 42 = KEY_LEFTSHIFT, 47 = KEY_V
    const ydotoolArgs = inTerminal
      ? ["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"]
      : ["key", "29:1", "47:1", "47:0", "29:0"];

    const wtypeEntry = canUseWtype
      ? [
          inTerminal
            ? {
                cmd: "wtype",
                args: ["-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl"],
              }
            : { cmd: "wtype", args: ["-M", "ctrl", "-k", "v", "-m", "ctrl"] },
        ]
      : [];
    const xdotoolEntry = canUseXdotool ? [{ cmd: "xdotool", args: xdotoolArgs }] : [];
    const ydotoolEntry = canUseYdotool ? [{ cmd: "ydotool", args: ydotoolArgs }] : [];

    // Compositor-aware priority ordering
    let candidates;
    if (!isWayland) {
      // X11: xdotool is native and needs no daemon; ydotool as fallback
      candidates = [...xdotoolEntry, ...ydotoolEntry];
    } else if (isWlroots) {
      // wlroots (Sway, Hyprland, etc.): wtype is native; then xdotool for XWayland; ydotool last
      candidates = [...wtypeEntry, ...xdotoolEntry, ...ydotoolEntry];
    } else {
      // GNOME, KDE, or unknown Wayland: xdotool for XWayland apps first; ydotool fallback; wtype last resort
      candidates = [...xdotoolEntry, ...ydotoolEntry, ...wtypeEntry];
    }

    const available = candidates.filter((c) => this.commandExists(c.cmd));

    debugLogger.debug(
      "Available paste tools",
      {
        candidateTools: candidates.map((c) => c.cmd),
        availableTools: available.map((c) => c.cmd),
        targetWindowId,
        xdotoolWindowClass,
        inTerminal,
        pasteKeys,
      },
      "clipboard"
    );

    const pasteWith = (tool) => {
      const delay = isWayland ? 0 : PASTE_DELAYS.linux;
      return this._runCancelableDelay(pasteRequest, delay, () => {
        return new Promise((resolve, reject) => {
          debugLogger.debug(
            "Attempting paste",
            {
              cmd: tool.cmd,
              args: tool.args,
              delay,
              isWayland,
            },
            "clipboard"
          );

          const proc = spawn(tool.cmd, tool.args);
          this._attachPasteRequestProcess(pasteRequest, proc);
          let stderr = "";
          let stdout = "";

          const cleanup = () => {
            clearTimeout(timeoutId);
            this._detachPasteRequestProcess(pasteRequest, proc);
          };

          proc.stderr?.on("data", (data) => {
            stderr += data.toString();
          });

          proc.stdout?.on("data", (data) => {
            stdout += data.toString();
          });

          let timedOut = false;
          const timeoutId = setTimeout(() => {
            timedOut = true;
            killProcess(proc, "SIGKILL");
            debugLogger.warn(
              "Paste tool timed out",
              {
                cmd: tool.cmd,
                timeoutMs: 2000,
              },
              "clipboard"
            );
          }, 2000);

          proc.on("close", (code) => {
            cleanup();
            if (pasteRequest?.cancelled) {
              reject(this._createPasteCancelledError());
              return;
            }
            if (timedOut) return reject(new Error(`Paste with ${tool.cmd} timed out`));

            if (code === 0) {
              debugLogger.debug("Paste successful", { cmd: tool.cmd }, "clipboard");
              keepClipboard();
              resolve();
            } else {
              debugLogger.error(
                "Paste command failed",
                {
                  cmd: tool.cmd,
                  args: tool.args,
                  exitCode: code,
                  stderr: stderr.trim(),
                  stdout: stdout.trim(),
                },
                "clipboard"
              );
              reject(
                new Error(
                  `${tool.cmd} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
                )
              );
            }
          });

          proc.on("error", (error) => {
            if (timedOut) return;
            cleanup();
            if (pasteRequest?.cancelled) {
              reject(this._createPasteCancelledError());
              return;
            }
            debugLogger.error(
              "Paste command spawn error",
              {
                cmd: tool.cmd,
                error: error.message,
                code: error.code,
              },
              "clipboard"
            );
            reject(error);
          });
        });
      });
    };

    const failedAttempts = [];
    for (const tool of available) {
      try {
        await pasteWith(tool);
        this.safeLog(`✅ Paste successful using ${tool.cmd}`);
        debugLogger.info("Paste successful", { tool: tool.cmd }, "clipboard");
        return;
      } catch (error) {
        if (this._isPasteCancelledError(error)) throw error;
        const failureInfo = {
          tool: tool.cmd,
          args: tool.args,
          error: error?.message || String(error),
        };
        failedAttempts.push(failureInfo);
        this.safeLog(`⚠️ Paste with ${tool.cmd} failed:`, error?.message || error);
        debugLogger.warn("Paste tool failed, trying next", failureInfo, "clipboard");
      }
    }

    debugLogger.error("All paste tools failed", { failedAttempts }, "clipboard");

    // xdotool type fallback for terminals where Ctrl+Shift+V simulation fails
    if (inTerminal && xdotoolExists && !isWayland) {
      debugLogger.debug(
        "Trying xdotool type fallback for terminal",
        {
          textLength: clipboard.readText().length,
          targetWindowId,
        },
        "clipboard"
      );
      this.safeLog("🔄 Trying xdotool type fallback for terminal...");
      const textToType = clipboard.readText();
      const typeArgs = targetWindowId
        ? ["windowactivate", "--sync", targetWindowId, "type", "--clearmodifiers", "--", textToType]
        : ["type", "--clearmodifiers", "--", textToType];

      try {
        await pasteWith({ cmd: "xdotool", args: typeArgs });
        this.safeLog("✅ Paste successful using xdotool type fallback");
        debugLogger.info("Terminal paste successful via xdotool type", {}, "clipboard");
        return;
      } catch (error) {
        if (this._isPasteCancelledError(error)) throw error;
        const fallbackFailure = {
          tool: "xdotool type",
          args: typeArgs,
          error: error?.message || String(error),
        };
        failedAttempts.push(fallbackFailure);
        this.safeLog(`⚠️ xdotool type fallback failed:`, error?.message || error);
        debugLogger.warn("xdotool type fallback failed", fallbackFailure, "clipboard");
      }
    }

    this._ensurePasteRequestActive(pasteRequest);

    const failureSummary =
      failedAttempts.length > 0
        ? `\n\nAttempted tools: ${failedAttempts.map((f) => `${f.tool} (${f.error})`).join(", ")}`
        : "";

    let errorMsg;
    if (isWayland) {
      if (isGnome || isKde) {
        if (!xwaylandAvailable && !ydotoolDaemonRunning) {
          errorMsg =
            "Clipboard copied, but automatic pasting on Wayland requires xdotool (with XWayland) or ydotool (with ydotoold daemon running). Please paste manually with Ctrl+V.";
        } else if (!xdotoolExists && !ydotoolDaemonRunning) {
          errorMsg =
            "Clipboard copied, but automatic pasting requires xdotool (recommended) or ydotool. Please install xdotool or paste manually with Ctrl+V.";
        } else {
          errorMsg =
            "Clipboard copied, but paste simulation failed. Please paste manually with Ctrl+V.";
        }
      } else if (isWlroots) {
        if (!wtypeExists && !xdotoolExists && !ydotoolDaemonRunning) {
          errorMsg =
            "Clipboard copied, but automatic pasting requires wtype (recommended for your compositor) or xdotool. Please install one or paste manually with Ctrl+V.";
        } else {
          errorMsg =
            "Clipboard copied, but paste simulation failed. Please paste manually with Ctrl+V.";
        }
      } else {
        errorMsg =
          "Clipboard copied, but paste simulation failed on Wayland. Please install xdotool or paste manually with Ctrl+V.";
      }
    } else {
      errorMsg =
        "Clipboard copied, but paste simulation failed on X11. Please install xdotool or paste manually with Ctrl+V.";
    }

    if (ydotoolExists && !ydotoolDaemonRunning) {
      errorMsg +=
        "\n\nNote: ydotool is installed but the ydotoold daemon is not running. Start it with: sudo systemctl enable --now ydotool";
    }

    const err = new Error(errorMsg + failureSummary);
    err.code = "PASTE_SIMULATION_FAILED";
    err.failedAttempts = failedAttempts;
    debugLogger.error(
      "Throwing paste simulation failed error",
      {
        errorMsg,
        failedAttempts,
        isWayland,
        isGnome,
        isKde,
        isWlroots,
      },
      "clipboard"
    );
    throw err;
  }

  async checkAccessibilityPermissions(options = {}) {
    if (process.platform !== "darwin") return true;
    const showDialog = options.showDialog !== false;
    const returnMeta = options.returnMeta === true;
    const formatResult = (allowed, dialogShown = false) =>
      returnMeta ? { allowed, dialogShown } : allowed;

    const now = Date.now();
    if (now < this.accessibilityCache.expiresAt && this.accessibilityCache.value !== null) {
      let dialogShown = false;
      if (!this.accessibilityCache.value && showDialog) {
        dialogShown = this.showAccessibilityDialog("");
      }
      return formatResult(this.accessibilityCache.value, dialogShown);
    }

    if (typeof systemPreferences?.isTrustedAccessibilityClient === "function") {
      try {
        const allowed = Boolean(systemPreferences.isTrustedAccessibilityClient(false));
        this.accessibilityCache = {
          value: allowed,
          expiresAt:
            Date.now() + (allowed ? ACCESSIBILITY_GRANTED_TTL_MS : ACCESSIBILITY_DENIED_TTL_MS),
        };
        let dialogShown = false;
        if (!allowed && this._shouldPresentAccessibilityDialog(showDialog)) {
          dialogShown = this.showAccessibilityDialog("");
        }
        return formatResult(allowed, dialogShown);
      } catch (error) {
        this.safeLog("⚠️ Native accessibility check failed, falling back to AppleScript probe", {
          error: error?.message || String(error),
        });
      }
    }

    return new Promise((resolve) => {
      const testProcess = spawn("osascript", [
        "-e",
        'tell application "System Events" to get name of first process',
      ]);

      let testOutput = "";
      let testError = "";
      let hasTimedOut = false;

      const timeoutId = setTimeout(() => {
        hasTimedOut = true;
        killProcess(testProcess, "SIGKILL");
        testProcess.removeAllListeners();
        this.safeLog("⚠️ Accessibility probe timed out");
        this.accessibilityCache = {
          value: false,
          expiresAt: Date.now() + ACCESSIBILITY_DENIED_TTL_MS,
        };
        resolve(formatResult(false, false));
      }, 3000);

      testProcess.stdout.on("data", (data) => {
        testOutput += data.toString();
      });

      testProcess.stderr.on("data", (data) => {
        testError += data.toString();
      });

      testProcess.on("close", (code) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        const allowed = code === 0;
        this.accessibilityCache = {
          value: allowed,
          expiresAt:
            Date.now() + (allowed ? ACCESSIBILITY_GRANTED_TTL_MS : ACCESSIBILITY_DENIED_TTL_MS),
        };
        let dialogShown = false;
        if (!allowed && this._shouldPresentAccessibilityDialog(showDialog)) {
          dialogShown = this.showAccessibilityDialog(testError);
        }
        resolve(formatResult(allowed, dialogShown));
      });

      testProcess.on("error", (error) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        this.accessibilityCache = {
          value: false,
          expiresAt: Date.now() + ACCESSIBILITY_DENIED_TTL_MS,
        };
        resolve(formatResult(false, false));
      });
    });
  }

  showAccessibilityDialog(testError) {
    if (!this._shouldPresentAccessibilityDialog(true)) {
      return false;
    }

    const isStuckPermission =
      testError.includes("not allowed assistive access") ||
      testError.includes("(-1719)") ||
      testError.includes("(-25006)");

    const translationKey = isStuckPermission
      ? "hooks.clipboard.accessibilityDialog.stuck"
      : "hooks.clipboard.accessibilityDialog.standard";

    this.accessibilityDialogOpen = true;

    void dialog
      .showMessageBox({
        type: "warning",
        buttons: [i18nMain.t("common.cancel"), i18nMain.t("common.openSystemSettings")],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        title: i18nMain.t(`${translationKey}.title`),
        message: i18nMain.t(`${translationKey}.message`),
        detail: i18nMain.t(`${translationKey}.detail`),
      })
      .then(({ response }) => {
        if (response === 1) {
          this.accessibilityDialogDismissedForSession = false;
          this.openSystemSettings();
        } else {
          this.accessibilityDialogDismissedForSession = true;
        }
      })
      .catch(() => {})
      .finally(() => {
        this.accessibilityDialogOpen = false;
      });
    return true;
  }

  openSystemSettings() {
    const settingsCommands = [
      ["open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]],
      ["open", ["-b", "com.apple.systempreferences"]],
      ["open", ["/System/Library/PreferencePanes/Security.prefPane"]],
    ];

    let commandIndex = 0;
    const tryNextCommand = () => {
      if (commandIndex < settingsCommands.length) {
        const [cmd, args] = settingsCommands[commandIndex];
        const settingsProcess = spawn(cmd, args);

        settingsProcess.on("error", (error) => {
          commandIndex++;
          tryNextCommand();
        });

        settingsProcess.on("close", (settingsCode) => {
          if (settingsCode !== 0) {
            commandIndex++;
            tryNextCommand();
          }
        });
      } else {
        spawn("open", ["-a", "System Preferences"]).on("error", () => {
          spawn("open", ["-a", "System Settings"]).on("error", () => {});
        });
      }
    };

    tryNextCommand();
  }

  preWarmAccessibility() {
    if (process.platform === "linux") {
      this.resolveLinuxFastPasteBinary();
      return;
    }
    if (process.platform !== "darwin") return;
    this.checkAccessibilityPermissions({ showDialog: false }).catch(() => {});
    this.resolveFastPasteBinary();
  }

  async readClipboard() {
    return clipboard.readText();
  }

  async writeClipboard(text, webContents = null) {
    if (process.platform === "linux" && this._isWayland()) {
      this._writeClipboardWayland(text, webContents);
    } else {
      clipboard.writeText(text);
    }
    return { success: true };
  }

  checkPasteTools() {
    const platform = process.platform;

    if (platform === "darwin") {
      const fastPaste = this.resolveFastPasteBinary();
      return {
        platform: "darwin",
        available: true,
        method: fastPaste ? "cgevent" : "applescript",
        requiresPermission: true,
        tools: [],
      };
    }

    if (platform === "win32") {
      const winFastPaste = this.resolveWindowsFastPasteBinary();
      return {
        platform: "win32",
        available: true,
        method: winFastPaste ? "sendinput" : "powershell",
        requiresPermission: false,
        terminalAware: !!winFastPaste,
        tools: [],
      };
    }

    const { isWayland, xwaylandAvailable, isGnome, isKde, isWlroots } = getLinuxSessionInfo();
    const linuxFastPaste = this.resolveLinuxFastPasteBinary();
    const hasNativeBinary = !!linuxFastPaste;

    const tools = [];
    const canUseWtype = isWayland && isWlroots;
    const canUseYdotool = this.commandExists("ydotool") && this._isYdotoolDaemonRunning();
    const canUseXdotool = !isWayland || xwaylandAvailable;

    if (!isWayland) {
      if (canUseXdotool && this.commandExists("xdotool")) tools.push("xdotool");
      if (canUseYdotool) tools.push("ydotool");
    } else if (isWlroots) {
      if (canUseWtype && this.commandExists("wtype")) tools.push("wtype");
      if (canUseXdotool && this.commandExists("xdotool")) tools.push("xdotool");
      if (canUseYdotool) tools.push("ydotool");
    } else {
      if (canUseXdotool && this.commandExists("xdotool")) tools.push("xdotool");
      if (canUseYdotool) tools.push("ydotool");
      if (canUseWtype && this.commandExists("wtype")) tools.push("wtype");
    }

    const hasUinput = this._canAccessUinput();
    const nativeBinaryUsable = hasNativeBinary && (!isWayland || hasUinput || xwaylandAvailable);
    const available = nativeBinaryUsable || tools.length > 0;
    let recommendedInstall;
    if (!nativeBinaryUsable && tools.length === 0) {
      if (!isWayland) {
        recommendedInstall = "xdotool";
      } else if (isWlroots) {
        recommendedInstall = "wtype";
      } else {
        recommendedInstall = "xdotool";
      }
    } else if (isWayland && hasNativeBinary && !hasUinput && tools.length === 0) {
      recommendedInstall = "usermod -aG input $USER";
    }

    return {
      platform: "linux",
      available,
      method: nativeBinaryUsable
        ? isWayland && hasUinput
          ? "uinput"
          : "xtest"
        : available
          ? tools[0]
          : null,
      requiresPermission: false,
      isWayland,
      xwaylandAvailable,
      hasNativeBinary,
      hasUinput,
      tools,
      recommendedInstall,
    };
  }
}

module.exports = ClipboardManager;
