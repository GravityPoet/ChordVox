const { app, screen, BrowserWindow, shell, dialog, globalShortcut } = require("electron");
const HotkeyManager = require("./hotkeyManager");
const { isModifierOnlyHotkey, isRightSideModifier } = require("./hotkeyManager");
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const debugLogger = require("./debugLogger");
const { atomicWriteFile, readJsonWithBackup } = require("./atomicFile");
const DevServerManager = require("./devServerManager");
const { i18nMain } = require("./i18nMain");
const { openSafeExternalUrl } = require("./urlSecurity");
const { detectCapability, applyGlass, prepareWindowForGlass } = require("./nativeGlass");
const { DEV_SERVER_PORT } = DevServerManager;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  COMMAND_MENU_WINDOW_CONFIG,
  COMPLETION_ALERT_WINDOW_CONFIG,
  MAIN_WINDOW_STATE_LAYOUT_VERSION,
  WINDOW_SIZES,
  WindowPositionUtil,
  clampRestoredPanelPosition,
  clampVisiblePanelPosition,
  clampWindowPositionToWorkArea,
  getDictationWindowSize,
  getMainWindowAnchorHeight,
  getMainWindowResizePosition,
  normalizeDictationAnimationStyle,
} = require("./windowConfig");

const LOCAL_FILE_LOAD_RETRY_DELAY_MS = 500;
const LOCAL_FILE_LOAD_MAX_RETRIES = 20;
const DICTATION_UI_PREPARE_TIMEOUT_MS = 180;
const ERR_FAILED = -2;

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.commandMenuWindow = null;
    this.completionAlertWindow = null;
    this.completionAlertPayload = null;
    this.completionAlertHideTimer = null;
    this.tray = null;
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this.isQuitting = false;
    this.isMainWindowInteractive = false;
    this.loadErrorShown = false;
    this.loadRetryAttempts = new Map();
    // A startup load owns its retry loop.  did-fail-load is still useful for
    // navigations after startup, but retrying from both places can race and
    // surface a transient ERR_FAILED as a fatal startup error.
    this.activeLocalFileLoads = new WeakSet();
    this.macCompoundPushState = null;
    this.winPushState = null;
    this.secondaryHotkey = "";
    this.secondaryHotkeyAccelerator = null;
    this.workflowHotkeys = new Map();
    this.workflowHotkeysChangedHandler = null;
    this.globalShortcut = globalShortcut;
    this.licenseManager = null;
    this._cachedActivationMode = "tap";
    this._cachedRecordingAnimationStyle = normalizeDictationAnimationStyle(null);
    this._dictationUiPreparationSequence = 0;
    this._pendingDictationUiPreparation = null;
    this._dictationPanelShowGeneration = 0;
    this._scheduledDictationPanelShow = null;
    this._dictationPanelRevealTimer = null;
    this.commandMenuState = {
      isVisible: false,
      isRecording: false,
      isStarting: false,
      canStop: false,
    };
    app.on("before-quit", () => {
      this.isQuitting = true;
    });
  }

  setLicenseManager(licenseManager) {
    this.licenseManager = licenseManager || null;
  }

  setWorkflowHotkeysChangedHandler(handler) {
    this.workflowHotkeysChangedHandler = typeof handler === "function" ? handler : null;
  }

  notifyWorkflowHotkeysChanged() {
    if (!this.workflowHotkeysChangedHandler) return;

    try {
      this.workflowHotkeysChangedHandler(Array.from(this.workflowHotkeys.values()));
    } catch (error) {
      debugLogger.warn("[WindowManager] Workflow hotkey change notification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  hasMacPushWorkflowHotkeys(activationMode) {
    return (
      activationMode === "push" &&
      Array.from(this.workflowHotkeys.values()).some(
        (workflow) => typeof workflow?.hotkey === "string" && workflow.hotkey.includes("+")
      )
    );
  }

  isMenuBarTrayEnabled() {
    if (process.platform !== "darwin") {
      return false;
    }
    return process.env.TRAY_ICON_ENABLED !== "false";
  }

  applyMacPresentationMode({ preferDock = false } = {}) {
    if (process.platform !== "darwin") {
      return;
    }

    // Keep the Dock icon available while the control panel is open, but fall back
    // to menu-bar-only background mode after the window is closed when the tray
    // icon is available.
    const shouldShowDock = Boolean(preferDock) || !this.isMenuBarTrayEnabled();

    try {
      app.setActivationPolicy(shouldShowDock ? "regular" : "accessory");
    } catch (error) {
      console.warn("[WindowManager] Failed to update activation policy:", error?.message || error);
    }

    if (!app.dock) {
      return;
    }

    try {
      if (shouldShowDock) {
        app.dock.show();
      } else {
        app.dock.hide();
      }
    } catch (error) {
      console.warn("[WindowManager] Failed to update dock visibility:", error?.message || error);
    }
  }

  async hasProAccess() {
    if (!this.licenseManager?.getStatus) {
      return true;
    }

    try {
      const status = await this.licenseManager.getStatus({
        allowKeychain: false,
        passive: true,
      });
      return Boolean(status?.isActive);
    } catch (error) {
      console.warn("[WindowManager] Failed to verify Pro access:", error.message);
      return false;
    }
  }

  async ensureProAccess() {
    if (!this.licenseManager?.ensureProAccess) {
      return { allowed: true, status: null };
    }

    try {
      const status = await this.licenseManager.ensureProAccess();
      return { allowed: Boolean(status?.isActive), status: status || null };
    } catch (error) {
      console.warn("[WindowManager] Failed to start Pro trial:", error.message);
      return { allowed: false, status: null };
    }
  }

  async createMainWindow() {
    const display = screen.getPrimaryDisplay();
    const position =
      (await this.restoreMainWindowPosition()) || WindowPositionUtil.getMainWindowPosition(display);

    this.mainWindow = new BrowserWindow({
      ...MAIN_WINDOW_CONFIG,
      ...position,
    });

    // Main window (dictation overlay) should never appear in dock/taskbar
    // On macOS, users access the app via the menu bar tray icon
    // On Windows/Linux, the control panel stays in the taskbar when minimized
    this.mainWindow.setSkipTaskbar(true);

    this.setMainWindowInteractivity(false);
    this.registerMainWindowEvents();

    // Register load event handlers BEFORE loading to catch all events
    this.mainWindow.webContents.on(
      "did-fail-load",
      async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (
          process.env.NODE_ENV === "development" &&
          validatedURL &&
          validatedURL.includes(`localhost:${DEV_SERVER_PORT}`)
        ) {
          setTimeout(async () => {
            const isReady = await DevServerManager.waitForDevServer();
            if (isReady) {
              this.mainWindow.reload();
            }
          }, 2000);
        } else if (
          !this.retryLocalFileLoad(
            this.mainWindow,
            "Dictation panel",
            errorCode,
            errorDescription,
            validatedURL,
            () => this.loadWindowContent(this.mainWindow, false)
          )
        ) {
          this.showLoadFailureDialog("Dictation panel", errorCode, errorDescription, validatedURL);
        }
      }
    );

    this.mainWindow.webContents.on("did-finish-load", () => {
      this.clearLoadRetryState("Dictation panel");
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
      this.enforceMainWindowOnTop();
    });

    await this.loadMainWindow();
    await this.initializeHotkey();
    await this.initializeHotkeyWorkflows();
    this.dragManager.setTargetWindow(this.mainWindow);
    MenuManager.setupMainMenu();
  }

  setMainWindowInteractivity(shouldCapture, options = {}) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
      if (options?.focus === true && this.mainWindow.isVisible()) {
        this.mainWindow.focus();
      }
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    this.isMainWindowInteractive = shouldCapture;
  }

  getMainWindowStatePath() {
    return path.join(app.getPath("userData"), "main-window-state.json");
  }

  // Restore the bottom-center anchor the user last dragged the window to, so
  // the personalized position survives app restarts. Returns BASE-sized
  // bounds, or null when nothing valid is stored (first run, bad file).
  async restoreMainWindowPosition() {
    try {
      const { value } = await readJsonWithBackup(this.getMainWindowStatePath());
      const centerX = Number(value?.anchorCenterX);
      const bottomY = Number(value?.anchorBottomY);
      const layoutVersion = Number(value?.layoutVersion) || 0;
      if (!Number.isFinite(centerX) || !Number.isFinite(bottomY)) {
        return null;
      }
      const display = screen.getDisplayNearestPoint({
        x: Math.round(centerX),
        y: Math.round(bottomY),
      });
      const workArea = display.workArea || display.bounds;
      const displayBounds = display.bounds || workArea;
      const { width, height } = WINDOW_SIZES.BASE;
      const rawPosition = {
        x: centerX - width / 2,
        y: bottomY - height,
      };
      const desiredPosition = clampRestoredPanelPosition(
        rawPosition,
        { width, height },
        workArea,
        displayBounds,
        layoutVersion,
        process.platform
      );
      // Legacy anchors were saved while the renderer occupied only the top of
      // the transparent BrowserWindow, so restoring them into the corrected
      // full-height layout could bury the overlay behind the Dock. New-version
      // anchors preserve deliberate full-display placement.
      this.userAnchorCenterX = desiredPosition.x + width / 2;
      this.userAnchorBottomY = desiredPosition.y + height;
      const initialPosition = clampWindowPositionToWorkArea(
        desiredPosition,
        { width, height },
        workArea
      );
      debugLogger.debug("[WindowManager] Restored window anchor", {
        centerX,
        bottomY,
        layoutVersion,
        desiredPosition,
        initialPosition,
      });
      return { ...initialPosition, width, height };
    } catch (error) {
      debugLogger.warn("[WindowManager] Failed to restore window position", {
        error: error.message,
      });
      return null;
    }
  }

  persistMainWindowAnchor() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }
    const bounds = this.mainWindow.getBounds();
    const anchorHeight = getMainWindowAnchorHeight(bounds);
    const anchor = {
      layoutVersion: MAIN_WINDOW_STATE_LAYOUT_VERSION,
      anchorCenterX: bounds.x + bounds.width / 2,
      anchorBottomY: bounds.y + anchorHeight,
    };
    // The user just dragged the window: this is now the authoritative visual anchor
    // that resizeMainWindow honors on every later summon/resize this session,
    // independent of the externallyMoved heuristic.
    this.userAnchorCenterX = anchor.anchorCenterX;
    this.userAnchorBottomY = anchor.anchorBottomY;
    atomicWriteFile(this.getMainWindowStatePath(), JSON.stringify(anchor)).catch((error) => {
      debugLogger.warn("[WindowManager] Failed to persist window anchor", {
        error: error.message,
      });
    });
  }

  applyVisibleUserAnchor() {
    if (
      process.platform !== "darwin" ||
      !this.mainWindow ||
      this.mainWindow.isDestroyed() ||
      !Number.isFinite(this.userAnchorCenterX) ||
      !Number.isFinite(this.userAnchorBottomY)
    ) {
      return null;
    }

    const currentBounds = this.mainWindow.getBounds();
    const anchorHeight = getMainWindowAnchorHeight(currentBounds);
    const display = screen.getDisplayNearestPoint({
      x: Math.round(this.userAnchorCenterX),
      y: Math.round(this.userAnchorBottomY - 1),
    });
    const workArea = display.workArea || display.bounds;
    const displayBounds = display.bounds || workArea;
    const { x, y } = clampVisiblePanelPosition(
      {
        x: this.userAnchorCenterX - currentBounds.width / 2,
        y: this.userAnchorBottomY - anchorHeight,
      },
      { width: currentBounds.width, height: currentBounds.height },
      workArea,
      displayBounds
    );

    if (currentBounds.x !== x || currentBounds.y !== y) {
      this.mainWindow.setBounds({ ...currentBounds, x, y });
    }
    this.lastAppliedCenterX = x + currentBounds.width / 2;
    this.lastAppliedBottomY = y + currentBounds.height;
    return { x, y, width: currentBounds.width, height: currentBounds.height };
  }

  resizeMainWindow(sizeKeyOrSize) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    const isCustomSize =
      sizeKeyOrSize &&
      typeof sizeKeyOrSize === "object" &&
      Number.isFinite(Number(sizeKeyOrSize.width)) &&
      Number.isFinite(Number(sizeKeyOrSize.height));

    const newSize = isCustomSize
      ? {
          width: Math.max(96, Math.min(1200, Math.round(Number(sizeKeyOrSize.width)))),
          height: Math.max(96, Math.min(900, Math.round(Number(sizeKeyOrSize.height)))),
        }
      : WINDOW_SIZES[sizeKeyOrSize] || WINDOW_SIZES.BASE;
    const currentBounds = this.mainWindow.getBounds();
    const actualCenterX = currentBounds.x + currentBounds.width / 2;
    const actualBottomY = currentBounds.y + currentBounds.height;

    // `userAnchor*` is the user's remembered drag spot — seeded from disk on
    // restore and rewritten ONLY when the user actually drags the window
    // (persistMainWindowAnchor). It is the absolute source of truth and is
    // never overwritten by a resize: macOS `type:"panel"` windows briefly
    // report a recentred getBounds() right after hide→show, and adopting that
    // actual position here used to poison the anchor back to screen-centre —
    // the "snaps back to default on next summon" bug. When no anchor is stored
    // yet (first run, never dragged), fall back to the externally-moved actual
    // position, or the last target so transient clamped sizes (the ACTIVE
    // pre-show resize, wide toasts near a screen edge) don't shift the window.
    const hasUserAnchor =
      Number.isFinite(this.userAnchorCenterX) && Number.isFinite(this.userAnchorBottomY);
    const externallyMoved =
      this.lastAppliedCenterX == null ||
      this.lastAppliedBottomY == null ||
      Math.abs(actualCenterX - this.lastAppliedCenterX) > 4 ||
      Math.abs(actualBottomY - this.lastAppliedBottomY) > 4;
    const anchorCenterX = hasUserAnchor
      ? this.userAnchorCenterX
      : externallyMoved
        ? actualCenterX
        : this.lastTargetCenterX;
    const anchorBottomY = hasUserAnchor
      ? this.userAnchorBottomY
      : externallyMoved
        ? actualBottomY
        : this.lastTargetBottomY;

    const display = screen.getDisplayNearestPoint({ x: anchorCenterX, y: anchorBottomY });
    const workArea = display.workArea || display.bounds;
    const displayBounds = display.bounds || workArea;

    // macOS clamps a hidden panel back above the Dock when it becomes visible.
    // Use that same work-area boundary before showing it.
    const { position: rawPosition, anchorHeight } = getMainWindowResizePosition(
      newSize,
      anchorCenterX,
      anchorBottomY
    );
    const { x: newX, y: newY } =
      process.platform === "darwin" && this.mainWindow.isVisible()
        ? clampVisiblePanelPosition(rawPosition, newSize, workArea, displayBounds)
        : clampWindowPositionToWorkArea(rawPosition, newSize, workArea);

    this.mainWindow.setBounds({
      x: newX,
      y: newY,
      width: newSize.width,
      height: newSize.height,
    });

    this.lastTargetCenterX = anchorCenterX;
    this.lastTargetBottomY = anchorBottomY;
    this.lastAppliedCenterX = newX + newSize.width / 2;
    this.lastAppliedBottomY = newY + newSize.height;

    debugLogger.debug("[WindowManager] resizeMainWindow", {
      size: sizeKeyOrSize,
      actual: { centerX: actualCenterX, bottomY: actualBottomY },
      externallyMoved,
      anchorHeight,
      anchor: { centerX: anchorCenterX, bottomY: anchorBottomY },
      applied: { x: newX, y: newY, width: newSize.width, height: newSize.height },
      displayId: display.id,
    });

    return { success: true, bounds: { x: newX, y: newY, ...newSize } };
  }

  async loadWindowContent(window, isControlPanel = false, query = {}) {
    if (process.env.NODE_ENV === "development") {
      const appUrl = DevServerManager.getAppUrl(isControlPanel, query);
      await DevServerManager.waitForDevServer();
      await window.loadURL(appUrl);
    } else {
      // Production: use loadFile() for better compatibility with Electron 36+
      const fileInfo = DevServerManager.getAppFilePath(isControlPanel, query);
      if (!fileInfo) {
        throw new Error("Failed to get app file path");
      }

      const fileReady = await this.waitForLocalFile(fileInfo.path);
      if (!fileReady) {
        throw new Error(`HTML file not found: ${fileInfo.path}`);
      }

      // Electron can reject loadFile() with ERR_FAILED when the renderer is
      // interrupted by a bundle replacement, relaunch, or shutdown.  The
      // did-fail-load handler cannot safely own this first load because the
      // loadFile() rejection would otherwise escape to startApp() first.
      // Retry the bounded transient case here, while keeping permanent errors
      // visible to the existing startup error path.
      if (!this.activeLocalFileLoads) {
        this.activeLocalFileLoads = new WeakSet();
      }
      this.activeLocalFileLoads.add(window);
      let lastError = null;
      try {
        for (let attempt = 0; attempt <= LOCAL_FILE_LOAD_MAX_RETRIES; attempt += 1) {
          if (this.isQuitting || window.isDestroyed?.()) {
            return;
          }

          try {
            await window.loadFile(fileInfo.path, { query: fileInfo.query });
            return;
          } catch (error) {
            lastError = error;
            const errorCode = error?.code ?? error?.errno;
            if (this.isQuitting || errorCode !== "ERR_FAILED") {
              throw error;
            }

            if (attempt === LOCAL_FILE_LOAD_MAX_RETRIES) {
              break;
            }

            debugLogger.warn("Renderer local file load rejected; retrying", {
              windowName: isControlPanel ? "Control panel" : "Dictation panel",
              errorCode,
              error: error?.message || String(error),
              attempt: attempt + 1,
              maxAttempts: LOCAL_FILE_LOAD_MAX_RETRIES,
            });
            await new Promise((resolve) => setTimeout(resolve, LOCAL_FILE_LOAD_RETRY_DELAY_MS));
          }
        }
      } finally {
        this.activeLocalFileLoads.delete(window);
      }

      throw lastError || new Error(`Failed to load ${fileInfo.path}`);
    }
  }

  async waitForLocalFile(filePath) {
    for (let attempt = 0; attempt <= LOCAL_FILE_LOAD_MAX_RETRIES; attempt += 1) {
      if (fs.existsSync(filePath)) {
        return true;
      }

      if (attempt === LOCAL_FILE_LOAD_MAX_RETRIES) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, LOCAL_FILE_LOAD_RETRY_DELAY_MS));
    }

    return false;
  }

  getLocalFilePathFromUrl(url) {
    if (!url) {
      return "";
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "file:") {
        return "";
      }
      return fileURLToPath(parsed);
    } catch {
      return "";
    }
  }

  clearLoadRetryState(windowName) {
    for (const key of this.loadRetryAttempts.keys()) {
      if (key.startsWith(`${windowName}:`)) {
        this.loadRetryAttempts.delete(key);
      }
    }
  }

  retryLocalFileLoad(window, windowName, errorCode, errorDescription, validatedURL, loadAgain) {
    if (process.env.NODE_ENV === "development" || errorCode !== ERR_FAILED) {
      return false;
    }

    if (this.activeLocalFileLoads?.has(window)) {
      return true;
    }

    const filePath = this.getLocalFilePathFromUrl(validatedURL);
    if (!filePath) {
      return false;
    }

    const retryKey = `${windowName}:${validatedURL}`;
    const attempts = this.loadRetryAttempts.get(retryKey) || 0;
    if (attempts >= LOCAL_FILE_LOAD_MAX_RETRIES) {
      this.loadRetryAttempts.delete(retryKey);
      return false;
    }

    const nextAttempt = attempts + 1;
    this.loadRetryAttempts.set(retryKey, nextAttempt);
    debugLogger.warn("Renderer local file load failed; scheduling retry", {
      windowName,
      errorCode,
      errorDescription,
      validatedURL,
      attempt: nextAttempt,
      maxAttempts: LOCAL_FILE_LOAD_MAX_RETRIES,
    });

    setTimeout(async () => {
      if (!window || window.isDestroyed()) {
        return;
      }

      if (!fs.existsSync(filePath)) {
        this.retryLocalFileLoad(
          window,
          windowName,
          errorCode,
          `${errorDescription}; local file still missing`,
          validatedURL,
          loadAgain
        );
        return;
      }

      try {
        await loadAgain();
        this.loadRetryAttempts.delete(retryKey);
      } catch (error) {
        debugLogger.warn("Renderer local file retry failed", {
          windowName,
          validatedURL,
          attempt: nextAttempt,
          error: error?.message || String(error),
        });

        if (nextAttempt < LOCAL_FILE_LOAD_MAX_RETRIES) {
          this.retryLocalFileLoad(
            window,
            windowName,
            errorCode,
            error?.message || errorDescription,
            validatedURL,
            loadAgain
          );
        } else {
          this.loadRetryAttempts.delete(retryKey);
          this.showLoadFailureDialog(
            windowName,
            errorCode,
            error?.message || errorDescription,
            validatedURL
          );
        }
      }
    }, LOCAL_FILE_LOAD_RETRY_DELAY_MS);

    return true;
  }

  getAllowedAppNavigationPrefixes(isControlPanel = false, query = {}) {
    if (process.env.NODE_ENV === "development") {
      const appUrl = DevServerManager.getAppUrl(isControlPanel, query);
      return appUrl ? [appUrl] : [];
    }

    const fileInfo = DevServerManager.getAppFilePath(isControlPanel, query);
    if (!fileInfo) {
      return [];
    }

    const { pathToFileURL } = require("url");
    const appUrl = pathToFileURL(fileInfo.path);
    Object.entries(fileInfo.query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        appUrl.searchParams.set(key, String(value));
      }
    });
    return [appUrl.toString()];
  }

  isAllowedAppNavigation(url, isControlPanel = false, query = {}) {
    if (String(url || "").startsWith("devtools://")) {
      return true;
    }

    let targetUrl;
    try {
      targetUrl = new URL(url);
    } catch {
      return false;
    }

    return this.getAllowedAppNavigationPrefixes(isControlPanel, query).some((allowed) => {
      let allowedUrl;
      try {
        allowedUrl = new URL(allowed);
      } catch {
        return false;
      }

      if (targetUrl.protocol !== allowedUrl.protocol) return false;
      if (targetUrl.origin !== allowedUrl.origin) return false;
      if (targetUrl.pathname !== allowedUrl.pathname) return false;

      for (const [key, value] of allowedUrl.searchParams.entries()) {
        if (targetUrl.searchParams.get(key) !== value) return false;
      }

      return true;
    });
  }

  async loadMainWindow() {
    await this.loadWindowContent(this.mainWindow, false);
  }

  async loadCommandMenuWindow() {
    await this.loadWindowContent(this.commandMenuWindow, false, { commandMenu: "true" });
  }

  async loadCompletionAlertWindow() {
    await this.loadWindowContent(this.completionAlertWindow, false, {
      completionAlert: "fileTranscription",
    });
  }

  createHotkeyCallback(profileId = "primary") {
    let lastToggleTime = 0;
    const DEBOUNCE_MS = 150;

    return async () => {
      console.log("[WindowManager] Hotkey callback fired", { profileId });
      if (this.hotkeyManager.isInListeningMode()) {
        console.log("[WindowManager] Ignoring hotkey because listening mode is enabled");
        return;
      }

      if (profileId !== "primary") {
        const hasAccess = await this.hasProAccess();
        if (!hasAccess) {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send("secondary-hotkey-locked", {
              profileId,
            });
          }
          return;
        }
      }

      const activationMode = this.getActivationMode();
      const currentHotkey =
        profileId === "primary"
          ? this.hotkeyManager.getCurrentHotkey?.()
          : this.workflowHotkeys.get(profileId)?.hotkey || "";

      if (
        process.platform === "darwin" &&
        activationMode === "push" &&
        currentHotkey &&
        currentHotkey !== "GLOBE" &&
        currentHotkey.includes("+")
      ) {
        this.startMacCompoundPushToTalk(currentHotkey, profileId);
        return;
      }

      // Windows push mode: always defer to native listener (globalShortcut can't detect key-up)
      if (process.platform === "win32" && activationMode === "push") {
        if (profileId !== "primary") {
          // Workflow hotkeys use global shortcuts only, so keep them usable in push mode.
          this.showDictationPanel({ profileId });
          this.mainWindow.webContents.send("toggle-dictation", { profileId });
        }
        return;
      }

      const now = Date.now();
      if (now - lastToggleTime < DEBOUNCE_MS) {
        console.log("[WindowManager] Ignoring hotkey due to debounce");
        return;
      }
      lastToggleTime = now;

      this.prepareDictationUi(profileId);
      this.showDictationPanel({ focus: false });
      this.mainWindow.webContents.send("toggle-dictation", { profileId });
    };
  }

  prepareDictationUi(profileId = "primary") {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return null;
    }

    if (this.mainWindow.isVisible() || this._scheduledDictationPanelShow) {
      this.mainWindow.webContents.send("prepare-dictation-ui", { profileId });
      return null;
    }

    if (this._pendingDictationUiPreparation) {
      return this._pendingDictationUiPreparation.requestId;
    }

    const requestId = ++this._dictationUiPreparationSequence;
    this._pendingDictationUiPreparation = {
      requestId,
      profileId,
      readySize: null,
      showOptions: null,
      timeoutId: null,
    };
    this.mainWindow.webContents.send("prepare-dictation-ui", { profileId, requestId });
    return requestId;
  }

  completeDictationUiPreparation(payload = {}) {
    const requestId = Number(payload?.requestId);
    const pending = this._pendingDictationUiPreparation;
    if (!Number.isSafeInteger(requestId) || !pending || pending.requestId !== requestId) {
      return { success: false, ignored: true };
    }

    if (payload?.animationStyle != null) {
      this.setRecordingAnimationStyleCache(payload.animationStyle);
    }
    const width = Number(payload?.size?.width);
    const height = Number(payload?.size?.height);
    pending.readySize =
      Number.isFinite(width) && Number.isFinite(height)
        ? { width, height }
        : this.getPreparedDictationWindowSize();

    if (pending.showOptions) {
      this._showPreparedDictationPanel();
    }

    return { success: true };
  }

  _clearDictationUiPreparation() {
    const pending = this._pendingDictationUiPreparation;
    if (pending?.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    this._pendingDictationUiPreparation = null;
  }

  _showPreparedDictationPanel() {
    const pending = this._pendingDictationUiPreparation;
    if (!pending?.showOptions) {
      return;
    }

    const size = pending.readySize || this.getPreparedDictationWindowSize();
    const options = pending.showOptions;
    this._clearDictationUiPreparation();
    this.resizeMainWindow(size);
    this._scheduleDictationPanelShow(options);
  }

  _scheduleDictationPanelShow(options = {}) {
    const generation = ++this._dictationPanelShowGeneration;
    this._scheduledDictationPanelShow = {
      generation,
      focus: Boolean(options.focus),
    };

    setImmediate(() => {
      const scheduled = this._scheduledDictationPanelShow;
      if (!scheduled || scheduled.generation !== generation) {
        return;
      }
      this._scheduledDictationPanelShow = null;

      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        return;
      }
      const gateMacReveal =
        process.platform === "darwin" &&
        Number.isFinite(this.userAnchorCenterX) &&
        Number.isFinite(this.userAnchorBottomY);
      if (gateMacReveal) {
        this.mainWindow.setOpacity(0);
      }
      if (typeof this.mainWindow.showInactive === "function") {
        this.mainWindow.showInactive();
      } else {
        this.mainWindow.show();
      }
      this.applyVisibleUserAnchor();
      if (gateMacReveal) {
        if (this._dictationPanelRevealTimer) {
          clearTimeout(this._dictationPanelRevealTimer);
        }
        this._dictationPanelRevealTimer = setTimeout(() => {
          this._dictationPanelRevealTimer = null;
          if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isVisible()) {
            this.mainWindow.setOpacity(1);
          }
        }, 24);
      }
      if (scheduled.focus) {
        this.mainWindow.focus();
      }
      this.repositionCommandMenuWindow();
    });
  }

  startMacCompoundPushToTalk(hotkey, profileId = "primary") {
    if (this.macCompoundPushState?.active) {
      return;
    }

    const requiredModifiers = this.getMacRequiredModifiers(hotkey);
    if (requiredModifiers.size === 0) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const MAX_PUSH_DURATION_MS = 60 * 60 * 1000; // 60-minute safety cap for missed key-up events
    const downTime = Date.now();

    this.prepareDictationUi(profileId);
    this.showDictationPanel({ focus: false });

    const safetyTimeoutId = setTimeout(() => {
      if (this.macCompoundPushState?.active) {
        console.warn("[WindowManager] Compound PTT safety timeout triggered - stopping recording");
        this.forceStopMacCompoundPush("timeout");
      }
    }, MAX_PUSH_DURATION_MS);

    this.macCompoundPushState = {
      active: true,
      profileId,
      downTime,
      isRecording: false,
      requiredModifiers,
      safetyTimeoutId,
    };

    setTimeout(() => {
      if (!this.macCompoundPushState || this.macCompoundPushState.downTime !== downTime) {
        return;
      }

      if (!this.macCompoundPushState.isRecording) {
        this.macCompoundPushState.isRecording = true;
        this.sendStartDictation(this.macCompoundPushState.profileId || "primary");
      }
    }, MIN_HOLD_DURATION_MS);
  }

  handleMacPushModifierUp(modifier) {
    if (!this.macCompoundPushState?.active) {
      return;
    }

    if (!this.macCompoundPushState.requiredModifiers.has(modifier)) {
      return;
    }

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    const profileId = this.macCompoundPushState.profileId || "primary";
    this.macCompoundPushState = null;

    if (wasRecording) {
      this.sendStopDictation(profileId);
    } else {
      this.hideDictationPanel();
    }
  }

  forceStopMacCompoundPush(reason = "manual") {
    if (!this.macCompoundPushState) {
      return;
    }

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    const profileId = this.macCompoundPushState.profileId || "primary";
    this.macCompoundPushState = null;

    if (wasRecording) {
      this.sendStopDictation(profileId);
    }
    this.hideDictationPanel();

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("compound-ptt-force-stopped", { reason });
    }
  }

  getMacRequiredModifiers(hotkey) {
    const required = new Set();
    const parts = hotkey.split("+").map((part) => part.trim());

    for (const part of parts) {
      switch (part) {
        case "Command":
        case "Cmd":
        case "CommandOrControl":
        case "Super":
        case "Meta":
          required.add("command");
          break;
        case "Control":
        case "Ctrl":
          required.add("control");
          break;
        case "Alt":
        case "Option":
          required.add("option");
          break;
        case "Shift":
          required.add("shift");
          break;
        case "Fn":
          required.add("fn");
          break;
        default:
          break;
      }
    }

    return required;
  }

  startWindowsPushToTalk(profileId = "primary") {
    if (this.winPushState?.active) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const downTime = Date.now();

    this.prepareDictationUi(profileId);
    this.showDictationPanel({ focus: false });

    this.winPushState = {
      active: true,
      profileId,
      downTime,
      isRecording: false,
    };

    setTimeout(() => {
      if (!this.winPushState || this.winPushState.downTime !== downTime) {
        return;
      }

      if (!this.winPushState.isRecording) {
        this.winPushState.isRecording = true;
        this.sendStartDictation(this.winPushState.profileId || "primary");
      }
    }, MIN_HOLD_DURATION_MS);
  }

  handleWindowsPushKeyUp() {
    if (!this.winPushState?.active) {
      return;
    }

    const wasRecording = this.winPushState.isRecording;
    const profileId = this.winPushState.profileId || "primary";
    this.winPushState = null;

    if (wasRecording) {
      this.sendStopDictation(profileId);
    } else {
      this.hideDictationPanel();
    }
  }

  resetWindowsPushState() {
    this.winPushState = null;
  }

  sendStartDictation(profileId = "primary") {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    this.prepareDictationUi(profileId);
    this.showDictationPanel({ focus: false });

    const sentWebContents = new Set();
    const targets = [this.mainWindow, this.controlPanelWindow];
    for (const target of targets) {
      if (!target || target.isDestroyed?.()) {
        continue;
      }
      const webContentsId = target.webContents?.id;
      if (!webContentsId || sentWebContents.has(webContentsId)) {
        continue;
      }
      sentWebContents.add(webContentsId);
      target.webContents.send("start-dictation", { profileId });
    }
  }

  sendStopDictation(profileId = "primary") {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    const sentWebContents = new Set();
    const targets = [this.mainWindow, this.controlPanelWindow];
    for (const target of targets) {
      if (!target || target.isDestroyed?.()) {
        continue;
      }
      const webContentsId = target.webContents?.id;
      if (!webContentsId || sentWebContents.has(webContentsId)) {
        continue;
      }
      sentWebContents.add(webContentsId);
      target.webContents.send("stop-dictation", { profileId });
    }
  }

  getActivationMode() {
    return this._cachedActivationMode;
  }

  setActivationModeCache(mode) {
    this._cachedActivationMode = mode === "push" ? "push" : "tap";
  }

  setRecordingAnimationStyleCache(style) {
    this._cachedRecordingAnimationStyle = normalizeDictationAnimationStyle(style);
    return this._cachedRecordingAnimationStyle;
  }

  getPreparedDictationWindowSize() {
    return getDictationWindowSize(this._cachedRecordingAnimationStyle);
  }

  setHotkeyListeningMode(enabled) {
    this.hotkeyManager.setListeningMode(enabled);
  }

  isWorkflowHotkeySupported(hotkey) {
    if (!hotkey || hotkey === "GLOBE") return false;
    if (isRightSideModifier(hotkey)) return false;
    if (isModifierOnlyHotkey(hotkey)) return false;
    return true;
  }

  normalizeWorkflowHotkeyDefinitions(workflows) {
    if (!Array.isArray(workflows)) return [];

    const definitions = [];
    const seenIds = new Set();
    const seenAccelerators = new Set();
    for (const item of workflows.slice(0, 12)) {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      const hotkey = typeof item?.hotkey === "string" ? item.hotkey.trim() : "";
      if (item?.enabled === false || !hotkey) continue;
      if (!/^(secondary|workflow-[a-z0-9-]{1,72})$/i.test(id)) {
        throw new Error("Invalid workflow identifier.");
      }
      if (!this.isWorkflowHotkeySupported(hotkey)) {
        throw new Error("Workflow hotkeys cannot use Globe, right-side, or modifier-only keys.");
      }
      const accelerator = hotkey.startsWith("Fn+") ? hotkey.slice(3) : hotkey;
      const acceleratorKey = accelerator.toLowerCase();
      if (seenIds.has(id) || seenAccelerators.has(acceleratorKey)) {
        throw new Error("Every workflow needs a unique shortcut.");
      }
      seenIds.add(id);
      seenAccelerators.add(acceleratorKey);
      definitions.push({ id, hotkey, accelerator });
    }
    return definitions;
  }

  updateLegacySecondaryHotkeyState() {
    const legacy =
      this.workflowHotkeys.get("secondary") || this.workflowHotkeys.values().next().value;
    this.secondaryHotkey = legacy?.hotkey || "";
    this.secondaryHotkeyAccelerator = legacy?.accelerator || null;
  }

  unregisterWorkflowHotkeyAccelerators() {
    const shortcut = this.globalShortcut || globalShortcut;
    for (const workflow of this.workflowHotkeys.values()) {
      try {
        shortcut.unregister(workflow.accelerator);
      } catch (_error) {
        // Best effort. Registration below is authoritative.
      }
    }
  }

  registerWorkflowHotkeyDefinitions(definitions) {
    const shortcut = this.globalShortcut || globalShortcut;
    const registered = [];
    for (const definition of definitions) {
      let success = false;
      try {
        success = shortcut.register(
          definition.accelerator,
          this.createHotkeyCallback(definition.id)
        );
      } catch (_error) {
        success = false;
      }
      if (!success) {
        for (const completed of registered) {
          try {
            shortcut.unregister(completed.accelerator);
          } catch (_error) {
            // ignore rollback cleanup failure
          }
        }
        return { success: false, failed: definition };
      }
      registered.push(definition);
    }
    return { success: true };
  }

  async initializeHotkeyWorkflows() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    try {
      const stored = await this.mainWindow.webContents.executeJavaScript(
        `(() => ({ workflows: localStorage.getItem("hotkeyWorkflowsV1") || "", legacyHotkey: localStorage.getItem("dictationKeySecondary") || "" }))()`
      );
      let workflows = [];
      if (stored?.workflows) {
        try {
          workflows = JSON.parse(stored.workflows);
        } catch (_error) {
          workflows = [];
        }
      }
      if (!workflows.length && stored?.legacyHotkey?.trim()) {
        workflows = [{ id: "secondary", hotkey: stored.legacyHotkey.trim(), enabled: true }];
      }
      if (!workflows.length) return;
      if (!(await this.hasProAccess())) return;
      await this.syncHotkeyWorkflows(workflows);
    } catch (error) {
      // Non-fatal: app should still work with primary hotkey.
      console.warn("[WindowManager] Failed to initialize workflow hotkeys:", error.message);
    }
  }

  async unregisterWorkflowHotkeys({ clearDefinitions = true } = {}) {
    this.unregisterWorkflowHotkeyAccelerators();
    if (clearDefinitions) {
      this.workflowHotkeys.clear();
      this.updateLegacySecondaryHotkeyState();
      this.notifyWorkflowHotkeysChanged();
    }
  }

  resumeWorkflowHotkeys() {
    const definitions = Array.from(this.workflowHotkeys.values());
    if (!definitions.length) return { success: true };
    return this.registerWorkflowHotkeyDefinitions(definitions);
  }

  async syncHotkeyWorkflows(workflows) {
    let definitions;
    try {
      definitions = this.normalizeWorkflowHotkeyDefinitions(workflows);
    } catch (error) {
      return {
        success: false,
        message: error.message || "Invalid workflow hotkey configuration.",
      };
    }

    if (definitions.length > 0) {
      const proAccess = await this.ensureProAccess();
      if (!proAccess.allowed) {
        await this.unregisterWorkflowHotkeys();
        return {
          success: false,
          code: "LICENSE_REQUIRED",
          message:
            proAccess.status?.message ||
            i18nMain.t("settingsPage.general.hotkey.secondary.requiresProDescription"),
        };
      }
    }

    const primaryHotkey = this.hotkeyManager.getCurrentHotkey?.() || "";
    const primaryAccelerator = primaryHotkey.startsWith("Fn+")
      ? primaryHotkey.slice(3)
      : primaryHotkey;
    if (
      primaryAccelerator &&
      definitions.some(
        (definition) => definition.accelerator.toLowerCase() === primaryAccelerator.toLowerCase()
      )
    ) {
      return {
        success: false,
        message: "Workflow hotkeys must be different from the main hotkey.",
      };
    }

    const previousDefinitions = Array.from(this.workflowHotkeys.values());
    this.unregisterWorkflowHotkeyAccelerators();
    const registration = this.registerWorkflowHotkeyDefinitions(definitions);
    if (!registration.success) {
      const restored = this.registerWorkflowHotkeyDefinitions(previousDefinitions);
      if (!restored.success) {
        this.workflowHotkeys.clear();
        this.updateLegacySecondaryHotkeyState();
        this.notifyWorkflowHotkeysChanged();
      }
      return {
        success: false,
        message: `Failed to register workflow hotkey: ${registration.failed?.hotkey || "unknown"}`,
      };
    }

    this.workflowHotkeys = new Map(definitions.map((definition) => [definition.id, definition]));
    this.updateLegacySecondaryHotkeyState();
    this.notifyWorkflowHotkeysChanged();
    return {
      success: true,
      message: `${definitions.length} workflow hotkey(s) registered`,
      registered: definitions.map(({ id, hotkey }) => ({ id, hotkey })),
    };
  }

  async updateSecondaryHotkey(hotkey) {
    const normalizedHotkey = typeof hotkey === "string" ? hotkey.trim() : "";
    const workflows = Array.from(this.workflowHotkeys.values()).filter(
      (workflow) => workflow.id !== "secondary"
    );
    if (normalizedHotkey) {
      workflows.push({ id: "secondary", hotkey: normalizedHotkey, enabled: true });
    }
    return this.syncHotkeyWorkflows(workflows);
  }

  async initializeHotkey() {
    await this.hotkeyManager.initializeHotkey(this.mainWindow, this.createHotkeyCallback());
  }

  async updateHotkey(hotkey) {
    const result = await this.hotkeyManager.updateHotkey(hotkey, this.createHotkeyCallback());
    if (result?.success && this.workflowHotkeys.size > 0) {
      await this.syncHotkeyWorkflows(Array.from(this.workflowHotkeys.values()));
    }
    return result;
  }

  isUsingGnomeHotkeys() {
    return this.hotkeyManager.isUsingGnome();
  }

  async startWindowDrag() {
    return await this.dragManager.startWindowDrag();
  }

  async stopWindowDrag() {
    const result = await this.dragManager.stopWindowDrag();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      debugLogger.debug("[WindowManager] Drag stopped", {
        bounds: this.mainWindow.getBounds(),
      });
    }
    this.persistMainWindowAnchor();
    return result;
  }

  openExternalUrl(url, showError = true) {
    openSafeExternalUrl(shell, url).catch((error) => {
      if (showError) {
        dialog.showErrorBox(
          i18nMain.t("dialog.openLink.title"),
          i18nMain.t("dialog.openLink.message", { url, error: error.message })
        );
      }
    });
  }

  async createControlPanelWindow(options = {}) {
    const shouldShow = options.show !== false;
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      if (shouldShow) {
        this.applyMacPresentationMode({ preferDock: true });
        if (this.controlPanelWindow.isMinimized()) {
          this.controlPanelWindow.restore();
        }
        if (!this.controlPanelWindow.isVisible()) {
          this.controlPanelWindow.show();
        }
        this.controlPanelWindow.focus();
      }
      return;
    }

    this.controlPanelWindow = new BrowserWindow(CONTROL_PANEL_CONFIG);

    this.controlPanelWindow.webContents.on("will-navigate", (event, url) => {
      if (this.isAllowedAppNavigation(url, true)) {
        return;
      }

      event.preventDefault();
      this.openExternalUrl(url);
    });

    this.controlPanelWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternalUrl(url);
      return { action: "deny" };
    });

    this.controlPanelWindow.webContents.on("did-create-window", (childWindow, details) => {
      childWindow.close();
      if (details.url && !details.url.startsWith("devtools://")) {
        this.openExternalUrl(details.url, false);
      }
    });

    const visibilityTimer = shouldShow
      ? setTimeout(() => {
          if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
            return;
          }
          if (!this.controlPanelWindow.isVisible()) {
            this.controlPanelWindow.show();
            this.controlPanelWindow.focus();
          }
        }, 10000)
      : null;

    const clearVisibilityTimer = () => {
      clearTimeout(visibilityTimer);
    };

    this.controlPanelWindow.once("ready-to-show", () => {
      clearVisibilityTimer();
      this.applyMacPresentationMode({ preferDock: shouldShow });
      prepareWindowForGlass(this.controlPanelWindow);
      if (shouldShow) {
        this.controlPanelWindow.show();
        this.controlPanelWindow.focus();
      }
    });

    this.controlPanelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        if (process.platform === "darwin") {
          this.hideControlPanelToTray();
        } else {
          this.controlPanelWindow.minimize();
        }
      }
    });

    this.controlPanelWindow.on("closed", () => {
      clearVisibilityTimer();
      this.controlPanelWindow = null;
      this._controlPanelGlass = null;
    });

    MenuManager.setupControlPanelMenu(this.controlPanelWindow);

    // Per-window guard: did-finish-load fires again on every reload, and
    // re-applying would stack duplicate NSGlassEffectViews behind the page.
    let glassApplied = false;

    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      this.clearLoadRetryState("Control panel");
      clearVisibilityTimer();
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));

      try {
        if (!glassApplied) {
          this._controlPanelGlass = applyGlass(this.controlPanelWindow, {
            cornerRadius: 12,
            variant: 0, // regular
          });
          glassApplied = true;
          console.log("[WindowManager] Native glass applied:", this._controlPanelGlass.method);
        }

        // Renderer state resets on reload — always resend capability
        if (
          this._controlPanelGlass &&
          this.controlPanelWindow &&
          !this.controlPanelWindow.isDestroyed()
        ) {
          this.controlPanelWindow.webContents.send("native-glass-capability", {
            method: this._controlPanelGlass.method,
          });
        }
      } catch (err) {
        console.warn("[WindowManager] Failed to apply native glass:", err.message);
      }
    });

    this.controlPanelWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        clearVisibilityTimer();
        if (
          process.env.NODE_ENV !== "development" &&
          !this.retryLocalFileLoad(
            this.controlPanelWindow,
            "Control panel",
            errorCode,
            errorDescription,
            validatedURL,
            () => this.loadWindowContent(this.controlPanelWindow, true)
          )
        ) {
          this.showLoadFailureDialog("Control panel", errorCode, errorDescription, validatedURL);
        }
        if (shouldShow && !this.controlPanelWindow.isVisible()) {
          this.controlPanelWindow.show();
          this.controlPanelWindow.focus();
        }
      }
    );

    await this.loadControlPanel();
  }

  async createCommandMenuWindow() {
    if (this.commandMenuWindow && !this.commandMenuWindow.isDestroyed()) {
      return this.commandMenuWindow;
    }

    this.commandMenuWindow = new BrowserWindow(COMMAND_MENU_WINDOW_CONFIG);

    this.commandMenuWindow.webContents.on("will-navigate", (event, url) => {
      if (this.isAllowedAppNavigation(url, false, { commandMenu: "true" })) {
        return;
      }

      event.preventDefault();
      this.openExternalUrl(url);
    });

    this.commandMenuWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternalUrl(url);
      return { action: "deny" };
    });

    this.commandMenuWindow.once("ready-to-show", () => {
      this.enforceCommandMenuOnTop();
      this.syncCommandMenuState();
    });

    this.commandMenuWindow.on("blur", () => {
      this.hideCommandMenuWindow();
    });

    this.commandMenuWindow.on("closed", () => {
      this.commandMenuWindow = null;
      this.commandMenuState.isVisible = false;
    });

    await this.loadCommandMenuWindow();
    return this.commandMenuWindow;
  }

  getPreferredDisplay() {
    const focusedWindow = BrowserWindow.getFocusedWindow?.();
    if (focusedWindow && !focusedWindow.isDestroyed?.()) {
      try {
        return screen.getDisplayMatching(focusedWindow.getBounds());
      } catch {}
    }

    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
      return screen.getPrimaryDisplay();
    }
  }

  getCompletionAlertPosition() {
    const display = this.getPreferredDisplay();
    const workArea = display.workArea || display.bounds;
    const size = WINDOW_SIZES.COMPLETION_ALERT;
    const margin = 22;

    return {
      x: Math.round(workArea.x + workArea.width - size.width - margin),
      y: Math.round(workArea.y + workArea.height - size.height - margin),
      width: size.width,
      height: size.height,
    };
  }

  async createCompletionAlertWindow() {
    if (this.completionAlertWindow && !this.completionAlertWindow.isDestroyed()) {
      return this.completionAlertWindow;
    }

    this.completionAlertWindow = new BrowserWindow({
      ...COMPLETION_ALERT_WINDOW_CONFIG,
      ...this.getCompletionAlertPosition(),
    });

    this.completionAlertWindow.webContents.on("will-navigate", (event, url) => {
      if (
        this.isAllowedAppNavigation(url, false, {
          completionAlert: "fileTranscription",
        })
      ) {
        return;
      }

      event.preventDefault();
      this.openExternalUrl(url);
    });

    this.completionAlertWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternalUrl(url);
      return { action: "deny" };
    });

    this.completionAlertWindow.once("ready-to-show", () => {
      this.repositionCompletionAlertWindow();
      this.enforceCompletionAlertOnTop();
    });

    this.completionAlertWindow.on("closed", () => {
      this.completionAlertWindow = null;
      if (this.completionAlertHideTimer) {
        clearTimeout(this.completionAlertHideTimer);
        this.completionAlertHideTimer = null;
      }
    });

    await this.loadCompletionAlertWindow();
    return this.completionAlertWindow;
  }

  async loadControlPanel() {
    await this.loadWindowContent(this.controlPanelWindow, true);
  }

  showDictationPanel(options = {}) {
    const { focus = false, profileId = "primary" } = options;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }

    if (this.mainWindow.isVisible()) {
      if (focus) {
        this.mainWindow.focus();
      }
      // The renderer can auto-hide the idle capsule while the native window
      // remains visible (notably on Linux/X11). Re-arm the renderer-side idle
      // overlay whenever a caller explicitly asks to show the panel again.
      this.prepareDictationUi(profileId);
      this.repositionCommandMenuWindow();
      return;
    }

    if (this._scheduledDictationPanelShow) {
      this._scheduledDictationPanelShow.focus ||= Boolean(focus);
      return;
    }

    if (!this._pendingDictationUiPreparation) {
      this.prepareDictationUi(profileId);
    }

    const pending = this._pendingDictationUiPreparation;
    if (!pending) {
      this.resizeMainWindow(this.getPreparedDictationWindowSize());
      this._scheduleDictationPanelShow({ focus });
      return;
    }

    pending.showOptions = {
      focus: Boolean(pending.showOptions?.focus || focus),
    };

    if (pending.readySize) {
      this._showPreparedDictationPanel();
      return;
    }

    if (!pending.timeoutId) {
      pending.timeoutId = setTimeout(() => {
        if (this._pendingDictationUiPreparation?.requestId !== pending.requestId) {
          return;
        }
        debugLogger.warn(
          "[WindowManager] Dictation UI preparation timed out; using cached layout",
          {
            requestId: pending.requestId,
            animationStyle: this._cachedRecordingAnimationStyle,
          }
        );
        pending.readySize = this.getPreparedDictationWindowSize();
        this._showPreparedDictationPanel();
      }, DICTATION_UI_PREPARE_TIMEOUT_MS);
    }
  }

  hideControlPanelToTray() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return;
    }

    this.controlPanelWindow.hide();
    this.applyMacPresentationMode({ preferDock: false });
  }

  hideDictationPanel() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this._dictationPanelRevealTimer) {
        clearTimeout(this._dictationPanelRevealTimer);
        this._dictationPanelRevealTimer = null;
      }
      this.mainWindow.setOpacity(1);
      this._dictationPanelShowGeneration += 1;
      this._scheduledDictationPanelShow = null;
      this._clearDictationUiPreparation();
      this.hideCommandMenuWindow();
      // Resize to BASE *before* hiding so the window is always at BASE size
      // when invisible. This eliminates the race condition where a stale
      // "resize to BASE" IPC (sent by the renderer) arrives after the next
      // showDictationPanel call has already resized to ACTIVE and shown the
      // window — which would cause the window to momentarily shrink and
      // expose the left-edge clipping artifact.
      this.resizeMainWindow("BASE");
      this.mainWindow.hide();
    }
  }

  getCommandMenuPosition() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return null;
    }

    const mainBounds = this.mainWindow.getBounds();
    const menuSize = WINDOW_SIZES.COMMAND_MENU;
    const gap = 10;
    const menuX = Math.round(mainBounds.x + mainBounds.width - menuSize.width);
    const menuY = Math.round(mainBounds.y - menuSize.height - gap);
    const display = screen.getDisplayNearestPoint({ x: menuX, y: menuY });
    const workArea = display.workArea || display.bounds;

    return {
      x: Math.max(workArea.x, Math.min(menuX, workArea.x + workArea.width - menuSize.width)),
      y: Math.max(workArea.y, Math.min(menuY, workArea.y + workArea.height - menuSize.height)),
      width: menuSize.width,
      height: menuSize.height,
    };
  }

  repositionCommandMenuWindow() {
    if (!this.commandMenuWindow || this.commandMenuWindow.isDestroyed()) {
      return;
    }

    const bounds = this.getCommandMenuPosition();
    if (!bounds) {
      return;
    }

    this.commandMenuWindow.setBounds(bounds);
    this.enforceCommandMenuOnTop();
  }

  enforceCommandMenuOnTop() {
    if (this.commandMenuWindow && !this.commandMenuWindow.isDestroyed()) {
      WindowPositionUtil.setupAlwaysOnTop(this.commandMenuWindow);
    }
  }

  syncCommandMenuState(nextState = null) {
    if (nextState && typeof nextState === "object") {
      this.commandMenuState = {
        ...this.commandMenuState,
        ...nextState,
      };
    }

    const payload = {
      ...this.commandMenuState,
      isVisible: Boolean(this.commandMenuState.isVisible),
    };

    if (this.commandMenuWindow && !this.commandMenuWindow.isDestroyed()) {
      this.commandMenuWindow.webContents.send("command-menu-state", payload);
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("command-menu-visibility-changed", {
        isVisible: payload.isVisible,
      });
    }
  }

  async showCommandMenuWindow(nextState = null) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Main window not available" };
    }

    await this.createCommandMenuWindow();
    this.commandMenuState.isVisible = true;
    this.syncCommandMenuState(nextState);
    this.repositionCommandMenuWindow();

    if (!this.commandMenuWindow.isVisible()) {
      if (typeof this.commandMenuWindow.showInactive === "function") {
        this.commandMenuWindow.showInactive();
      } else {
        this.commandMenuWindow.show();
      }
    }

    this.commandMenuWindow.focus();
    return { success: true };
  }

  hideCommandMenuWindow() {
    this.commandMenuState.isVisible = false;
    if (this.commandMenuWindow && !this.commandMenuWindow.isDestroyed()) {
      this.commandMenuWindow.hide();
    }
    this.syncCommandMenuState();
  }

  repositionCompletionAlertWindow() {
    if (!this.completionAlertWindow || this.completionAlertWindow.isDestroyed()) {
      return;
    }
    this.completionAlertWindow.setBounds(this.getCompletionAlertPosition());
    this.enforceCompletionAlertOnTop();
  }

  enforceCompletionAlertOnTop() {
    if (this.completionAlertWindow && !this.completionAlertWindow.isDestroyed()) {
      WindowPositionUtil.setupAlwaysOnTop(this.completionAlertWindow);
    }
  }

  getCompletionAlertPayload() {
    return this.completionAlertPayload || null;
  }

  hideCompletionAlertWindow() {
    if (this.completionAlertHideTimer) {
      clearTimeout(this.completionAlertHideTimer);
      this.completionAlertHideTimer = null;
    }

    if (this.completionAlertWindow && !this.completionAlertWindow.isDestroyed()) {
      this.completionAlertWindow.hide();
    }
  }

  async showFileTranscriptionCompletionAlert(payload = {}) {
    const text = typeof payload.text === "string" ? payload.text : "";
    const title = typeof payload.title === "string" ? payload.title : "";
    const description = typeof payload.description === "string" ? payload.description : "";
    const fileName = typeof payload.fileName === "string" ? payload.fileName : "";

    if (!title && !description && !fileName) {
      return { success: false, message: "No completion alert content" };
    }

    this.completionAlertPayload = {
      id: Number.isFinite(Number(payload.id)) ? Number(payload.id) : null,
      text,
      title,
      description,
      fileName,
      createdAt: new Date().toISOString(),
    };

    const alertWindow = await this.createCompletionAlertWindow();
    this.repositionCompletionAlertWindow();
    alertWindow.webContents.send(
      "file-transcription-completion-alert",
      this.completionAlertPayload
    );

    if (!alertWindow.isVisible()) {
      if (typeof alertWindow.showInactive === "function") {
        alertWindow.showInactive();
      } else {
        alertWindow.show();
      }
    }

    this.enforceCompletionAlertOnTop();

    if (this.completionAlertHideTimer) {
      clearTimeout(this.completionAlertHideTimer);
    }
    this.completionAlertHideTimer = setTimeout(() => {
      this.hideCompletionAlertWindow();
    }, 15000);

    return { success: true };
  }

  async toggleCommandMenuWindow(nextState = null) {
    if (this.commandMenuState.isVisible) {
      this.hideCommandMenuWindow();
      return { success: true, isVisible: false };
    }

    const result = await this.showCommandMenuWindow(nextState);
    return { ...result, isVisible: true };
  }

  isDictationPanelVisible() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }

    if (this.mainWindow.isMinimized && this.mainWindow.isMinimized()) {
      return false;
    }

    return this.mainWindow.isVisible();
  }

  registerMainWindowEvents() {
    if (!this.mainWindow) {
      return;
    }

    this.mainWindow.once("ready-to-show", () => {
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.webContents.on("will-navigate", (event, url) => {
      if (this.isAllowedAppNavigation(url)) {
        return;
      }

      event.preventDefault();
      this.openExternalUrl(url);
    });

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternalUrl(url);
      return { action: "deny" };
    });

    this.mainWindow.on("show", () => {
      this.enforceMainWindowOnTop();
      this.repositionCommandMenuWindow();
    });

    this.mainWindow.on("focus", () => {
      this.enforceMainWindowOnTop();
      this.repositionCommandMenuWindow();
    });

    this.mainWindow.on("move", () => {
      this.repositionCommandMenuWindow();
      this.repositionCompletionAlertWindow();
    });

    this.mainWindow.on("resize", () => {
      this.repositionCommandMenuWindow();
      this.repositionCompletionAlertWindow();
    });

    this.mainWindow.on("hide", () => {
      this.hideCommandMenuWindow();
    });

    this.mainWindow.on("closed", () => {
      if (this.commandMenuWindow && !this.commandMenuWindow.isDestroyed()) {
        this.commandMenuWindow.close();
      }
      this.dragManager.cleanup();
      this.mainWindow = null;
      this.isMainWindowInteractive = false;
    });
  }

  enforceMainWindowOnTop() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      WindowPositionUtil.setupAlwaysOnTop(this.mainWindow);
    }
  }

  refreshLocalizedUi() {
    MenuManager.setupMainMenu();

    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      MenuManager.setupControlPanelMenu(this.controlPanelWindow);
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
    }
  }

  showLoadFailureDialog(windowName, errorCode, errorDescription, validatedURL) {
    // A load aborted while the app is quitting is not a real startup failure —
    // don't nag the user (or pop a dialog during E2E teardown when an in-flight
    // panel load is interrupted by app close).
    if (this.isQuitting) {
      return;
    }
    // Unpackaged dev/E2E runs surface load failures in the log instead of a modal
    // native dialog; the dialog is an end-user aid reserved for shipped builds.
    // Log EVERY failure here (no one-time gate) so repeated dev/E2E load issues
    // stay observable — the `loadErrorShown` throttle below is for the packaged
    // dialog only, where re-popping a modal on each retry would spam the user.
    if (!app.isPackaged) {
      debugLogger.warn("[WindowManager] Renderer load failed (dialog suppressed; unpackaged run)", {
        windowName,
        errorCode,
        errorDescription,
        validatedURL,
      });
      return;
    }
    // Packaged builds: show the native failure dialog at most once per session.
    if (this.loadErrorShown) {
      return;
    }
    this.loadErrorShown = true;
    const detailLines = [
      i18nMain.t("dialog.loadFailure.detail.window", { windowName }),
      i18nMain.t("dialog.loadFailure.detail.error", { errorCode, errorDescription }),
      validatedURL ? i18nMain.t("dialog.loadFailure.detail.url", { url: validatedURL }) : null,
      i18nMain.t("dialog.loadFailure.detail.hint"),
    ].filter(Boolean);
    dialog.showMessageBox({
      type: "error",
      title: i18nMain.t("dialog.loadFailure.title"),
      message: i18nMain.t("dialog.loadFailure.message"),
      detail: detailLines.join("\n"),
    });
  }
}

module.exports = WindowManager;
