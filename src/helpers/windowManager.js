const { app, screen, BrowserWindow, shell, dialog, globalShortcut } = require("electron");
const HotkeyManager = require("./hotkeyManager");
const { isModifierOnlyHotkey, isRightSideModifier } = require("./hotkeyManager");
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const { i18nMain } = require("./i18nMain");
const { DEV_SERVER_PORT } = DevServerManager;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  COMMAND_MENU_WINDOW_CONFIG,
  WINDOW_SIZES,
  WindowPositionUtil,
} = require("./windowConfig");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.commandMenuWindow = null;
    this.tray = null;
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this.isQuitting = false;
    this.isMainWindowInteractive = false;
    this.loadErrorShown = false;
    this.macCompoundPushState = null;
    this.winPushState = null;
    this.secondaryHotkey = "";
    this.secondaryHotkeyAccelerator = null;
    this.licenseManager = null;
    this._cachedActivationMode = "tap";
    this.commandMenuState = {
      isVisible: false,
      isRecording: false,
      canStop: false,
    };
    app.on("before-quit", () => {
      this.isQuitting = true;
    });
  }

  setLicenseManager(licenseManager) {
    this.licenseManager = licenseManager || null;
  }

  async hasProAccess() {
    if (!this.licenseManager?.getStatus) {
      return true;
    }

    try {
      const status = await this.licenseManager.getStatus();
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
    const position = WindowPositionUtil.getMainWindowPosition(display);

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
        } else {
          this.showLoadFailureDialog("Dictation panel", errorCode, errorDescription, validatedURL);
        }
      }
    );

    this.mainWindow.webContents.on("did-finish-load", () => {
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
      this.enforceMainWindowOnTop();
    });

    await this.loadMainWindow();
    await this.initializeHotkey();
    await this.initializeSecondaryHotkey();
    this.dragManager.setTargetWindow(this.mainWindow);
    MenuManager.setupMainMenu();
  }

  setMainWindowInteractivity(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    this.isMainWindowInteractive = shouldCapture;
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
    // Use last valid center to avoid drifting from reading mid-animation bounds
    let currentCenterX = this.lastTargetCenterX || currentBounds.x + currentBounds.width / 2;

    // Safety check - if window moved significantly (>50px) by user drag, reset center
    const actualCenterX = currentBounds.x + currentBounds.width / 2;
    if (Math.abs(actualCenterX - currentCenterX) > 50) {
      currentCenterX = actualCenterX;
    }

    const currentBottomY = currentBounds.y + currentBounds.height;

    const display = screen.getDisplayNearestPoint({ x: currentCenterX, y: currentBottomY });
    const workArea = display.workArea || display.bounds;

    let newX = Math.round(currentCenterX - newSize.width / 2);
    let newY = Math.round(currentBottomY - newSize.height);

    newX = Math.max(workArea.x, Math.min(newX, workArea.x + workArea.width - newSize.width));
    newY = Math.max(workArea.y, Math.min(newY, workArea.y + workArea.height - newSize.height));

    this.mainWindow.setBounds({
      x: newX,
      y: newY,
      width: newSize.width,
      height: newSize.height,
    });

    this.lastTargetCenterX = newX + newSize.width / 2;

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

      const fs = require("fs");
      if (!fs.existsSync(fileInfo.path)) {
        throw new Error(`HTML file not found: ${fileInfo.path}`);
      }

      await window.loadFile(fileInfo.path, { query: fileInfo.query });
    }
  }

  async loadMainWindow() {
    await this.loadWindowContent(this.mainWindow, false);
  }

  async loadCommandMenuWindow() {
    await this.loadWindowContent(this.commandMenuWindow, false, { commandMenu: "true" });
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

      const activationMode = this.getActivationMode();
      const currentHotkey =
        profileId === "secondary" ? this.secondaryHotkey : this.hotkeyManager.getCurrentHotkey?.();

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
        if (profileId === "secondary") {
          // Secondary profile uses global shortcuts only, so keep it usable in push mode.
          this.showDictationPanel();
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

      this.showDictationPanel({ focus: true });
      this.mainWindow.webContents.send("toggle-dictation", { profileId });
    };
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
    const MAX_PUSH_DURATION_MS = 300000; // 5 minutes max recording
    const downTime = Date.now();

    this.showDictationPanel({ focus: true });

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

    this.showDictationPanel({ focus: true });

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
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.showDictationPanel({ focus: true });
      this.mainWindow.webContents.send("start-dictation", { profileId });
    }
  }

  sendStopDictation(profileId = "primary") {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation", { profileId });
    }
  }

  getActivationMode() {
    return this._cachedActivationMode;
  }

  setActivationModeCache(mode) {
    this._cachedActivationMode = mode === "push" ? "push" : "tap";
  }

  setHotkeyListeningMode(enabled) {
    this.hotkeyManager.setListeningMode(enabled);
  }

  isSecondaryHotkeySupported(hotkey) {
    if (!hotkey || hotkey === "GLOBE") return false;
    if (isRightSideModifier(hotkey)) return false;
    if (isModifierOnlyHotkey(hotkey)) return false;
    return true;
  }

  async initializeSecondaryHotkey() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    try {
      const secondaryHotkey = await this.mainWindow.webContents.executeJavaScript(
        `localStorage.getItem("dictationKeySecondary") || ""`
      );
      if (!secondaryHotkey || !secondaryHotkey.trim()) return;
      if (!(await this.hasProAccess())) return;
      await this.updateSecondaryHotkey(secondaryHotkey.trim());
    } catch (error) {
      // Non-fatal: app should still work with primary hotkey.
      console.warn("[WindowManager] Failed to initialize secondary hotkey:", error.message);
    }
  }

  async unregisterSecondaryHotkey() {
    if (this.secondaryHotkeyAccelerator) {
      try {
        globalShortcut.unregister(this.secondaryHotkeyAccelerator);
      } catch (_error) {
        // ignore
      }
    }
    this.secondaryHotkey = "";
    this.secondaryHotkeyAccelerator = null;
  }

  async updateSecondaryHotkey(hotkey) {
    const normalizedHotkey = typeof hotkey === "string" ? hotkey.trim() : "";
    const previousHotkey = this.secondaryHotkey;
    const previousAccelerator = this.secondaryHotkeyAccelerator;

    if (!normalizedHotkey) {
      await this.unregisterSecondaryHotkey();
      return { success: true, message: "Secondary hotkey cleared" };
    }

    if (!this.isSecondaryHotkeySupported(normalizedHotkey)) {
      return {
        success: false,
        message: "Secondary hotkey cannot be Globe, right-side modifier, or modifier-only.",
      };
    }

    const proAccess = await this.ensureProAccess();
    if (!proAccess.allowed) {
      await this.unregisterSecondaryHotkey();
      return {
        success: false,
        code: "LICENSE_REQUIRED",
        message:
          proAccess.status?.message ||
          i18nMain.t("settingsPage.general.hotkey.secondary.requiresProDescription"),
      };
    }

    const accelerator = normalizedHotkey.startsWith("Fn+")
      ? normalizedHotkey.slice(3)
      : normalizedHotkey;

    if (previousHotkey && previousHotkey === normalizedHotkey && previousAccelerator) {
      return { success: true, message: `Secondary hotkey updated to: ${normalizedHotkey}` };
    }

    const primaryHotkey = this.hotkeyManager.getCurrentHotkey?.() || "";
    const primaryAccelerator = primaryHotkey.startsWith("Fn+")
      ? primaryHotkey.slice(3)
      : primaryHotkey;
    if (primaryAccelerator && primaryAccelerator === accelerator) {
      return { success: false, message: "Secondary hotkey must be different from primary hotkey." };
    }

    await this.unregisterSecondaryHotkey();

    const callback = this.createHotkeyCallback("secondary");
    const registered = globalShortcut.register(accelerator, callback);
    if (!registered) {
      if (previousHotkey && previousAccelerator) {
        const previousCallback = this.createHotkeyCallback("secondary");
        const restored = globalShortcut.register(previousAccelerator, previousCallback);
        if (restored) {
          this.secondaryHotkey = previousHotkey;
          this.secondaryHotkeyAccelerator = previousAccelerator;
        }
      }
      return {
        success: false,
        message: `Failed to register secondary hotkey: ${normalizedHotkey}`,
      };
    }

    this.secondaryHotkey = normalizedHotkey;
    this.secondaryHotkeyAccelerator = accelerator;
    return { success: true, message: `Secondary hotkey updated to: ${normalizedHotkey}` };
  }

  async initializeHotkey() {
    await this.hotkeyManager.initializeHotkey(this.mainWindow, this.createHotkeyCallback());
  }

  async updateHotkey(hotkey) {
    const result = await this.hotkeyManager.updateHotkey(hotkey, this.createHotkeyCallback());
    if (result?.success && this.secondaryHotkey) {
      await this.updateSecondaryHotkey(this.secondaryHotkey);
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
    return await this.dragManager.stopWindowDrag();
  }

  openExternalUrl(url, showError = true) {
    shell.openExternal(url).catch((error) => {
      if (showError) {
        dialog.showErrorBox(
          i18nMain.t("dialog.openLink.title"),
          i18nMain.t("dialog.openLink.message", { url, error: error.message })
        );
      }
    });
  }

  async createControlPanelWindow() {
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      if (this.controlPanelWindow.isMinimized()) {
        this.controlPanelWindow.restore();
      }
      if (!this.controlPanelWindow.isVisible()) {
        this.controlPanelWindow.show();
      }
      this.controlPanelWindow.focus();
      return;
    }

    this.controlPanelWindow = new BrowserWindow(CONTROL_PANEL_CONFIG);

    this.controlPanelWindow.webContents.on("will-navigate", (event, url) => {
      const appUrl = DevServerManager.getAppUrl(true);
      const controlPanelUrl = appUrl.startsWith("http") ? appUrl : `file://${appUrl}`;

      if (
        url.startsWith(controlPanelUrl) ||
        url.startsWith("file://") ||
        url.startsWith("devtools://")
      ) {
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

    const visibilityTimer = setTimeout(() => {
      if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
        return;
      }
      if (!this.controlPanelWindow.isVisible()) {
        this.controlPanelWindow.show();
        this.controlPanelWindow.focus();
      }
    }, 10000);

    const clearVisibilityTimer = () => {
      clearTimeout(visibilityTimer);
    };

    this.controlPanelWindow.once("ready-to-show", () => {
      clearVisibilityTimer();
      if (process.platform === "darwin" && app.dock) {
        app.dock.show();
      }
      this.controlPanelWindow.show();
      this.controlPanelWindow.focus();
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
    });

    MenuManager.setupControlPanelMenu(this.controlPanelWindow);

    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      clearVisibilityTimer();
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    });

    this.controlPanelWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        clearVisibilityTimer();
        if (process.env.NODE_ENV !== "development") {
          this.showLoadFailureDialog("Control panel", errorCode, errorDescription, validatedURL);
        }
        if (!this.controlPanelWindow.isVisible()) {
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
      const menuUrl = DevServerManager.getAppUrl(false, { commandMenu: "true" }) || "";
      const normalizedMenuUrl = menuUrl.startsWith("http") ? menuUrl : `file://${menuUrl}`;
      if (
        url.startsWith(normalizedMenuUrl) ||
        url.startsWith("file://") ||
        url.startsWith("devtools://")
      ) {
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

  async loadControlPanel() {
    await this.loadWindowContent(this.controlPanelWindow, true);
  }

  showDictationPanel(options = {}) {
    const { focus = false } = options;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const currentBounds = this.mainWindow.getBounds();
      if (
        !this.mainWindow.isVisible() &&
        currentBounds.width <= WINDOW_SIZES.BASE.width + 4 &&
        currentBounds.height <= WINDOW_SIZES.BASE.height + 4
      ) {
        this.resizeMainWindow("ACTIVE");
      }
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      if (!this.mainWindow.isVisible()) {
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      }
      if (focus) {
        this.mainWindow.focus();
      }
      this.repositionCommandMenuWindow();
    }
  }

  hideControlPanelToTray() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return;
    }

    this.controlPanelWindow.hide();

    if (process.platform === "darwin" && app.dock) {
      app.dock.hide();
    }
  }

  hideDictationPanel() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.hideCommandMenuWindow();
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
    });

    this.mainWindow.on("resize", () => {
      this.repositionCommandMenuWindow();
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
