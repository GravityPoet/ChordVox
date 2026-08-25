const { Tray, Menu, nativeImage, app } = require("electron");
const path = require("path");
const fs = require("fs");
const { i18nMain } = require("./i18nMain");
const debugLogger = require("./debugLogger");

class TrayManager {
  static MAC_TRAY_ICON_SIZE = 26;

  constructor() {
    this.tray = null;
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.windowManager = null;
    this.attachedControlPanels = new WeakSet();
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;

    if (this.mainWindow) {
      this.mainWindow.on("show", () => this.updateTrayMenu?.());
      this.mainWindow.on("hide", () => this.updateTrayMenu?.());
      this.mainWindow.on("minimize", () => this.updateTrayMenu?.());
      this.mainWindow.on("restore", () => this.updateTrayMenu?.());
    }

    if (this.controlPanelWindow) {
      this.attachControlPanelListeners(this.controlPanelWindow);
    }

    this.updateTrayMenu?.();
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  setCreateControlPanelCallback(callback) {
    this.createControlPanelCallback = callback;
  }

  attachControlPanelListeners(window) {
    if (!window || this.attachedControlPanels.has(window)) {
      return;
    }

    this.attachedControlPanels.add(window);

    window.on("show", () => {
      this.updateTrayMenu?.();
    });

    window.on("hide", () => {
      this.updateTrayMenu?.();
    });

    window.on("destroyed", () => {
      this.controlPanelWindow = null;
      this.updateTrayMenu?.();
    });
  }

  async showControlPanelFromTray() {
    try {
      if (this.windowManager) {
        this.controlPanelWindow = this.windowManager.controlPanelWindow || this.controlPanelWindow;
      }
      this.attachControlPanelListeners(this.controlPanelWindow);

      if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
        // Show dock icon on macOS when control panel opens
        this.windowManager?.applyMacPresentationMode?.({ preferDock: true });
        if (this.controlPanelWindow.isMinimized()) {
          this.controlPanelWindow.restore();
        }
        if (!this.controlPanelWindow.isVisible()) {
          this.controlPanelWindow.show();
        }
        this.controlPanelWindow.focus();
        return;
      }

      if (this.createControlPanelCallback) {
        await this.createControlPanelCallback();
        if (this.windowManager) {
          this.controlPanelWindow =
            this.windowManager.controlPanelWindow || this.controlPanelWindow;
        }
        this.attachControlPanelListeners(this.controlPanelWindow);

        if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
          this.windowManager?.applyMacPresentationMode?.({ preferDock: true });
          this.controlPanelWindow.show();
          this.controlPanelWindow.focus();
        }
        return;
      }

      console.error("No control panel callback available");
    } catch (error) {
      console.error("Failed to open control panel:", error);
    }
  }

  async createTray() {
    if (process.platform !== "darwin" && process.platform !== "win32") return false;
    if (this.hasTray()) return true;

    try {
      debugLogger.info("Creating tray icon", { platform: process.platform }, "tray", "main");
      const trayIcon = await this.loadTrayIcon();
      if (!trayIcon || trayIcon.isEmpty()) {
        debugLogger.error("Failed to load tray icon", { platform: process.platform }, "tray");
        return false;
      }

      this.tray = new Tray(trayIcon);
      debugLogger.info("Tray icon created", { platform: process.platform }, "tray", "main");

      if (process.platform === "darwin") {
        this.tray.setIgnoreDoubleClickEvents(true);
      }

      this.updateTrayMenu();
      this.setupTrayEventHandlers();
      return true;
    } catch (error) {
      debugLogger.error(
        "Error creating tray icon",
        { error: error?.message || String(error), stack: error?.stack || null },
        "tray"
      );
      return false;
    }
  }

  hasTray() {
    return Boolean(this.tray && !(this.tray.isDestroyed?.() ?? false));
  }

  destroyTray() {
    if (!this.hasTray()) {
      this.tray = null;
      return false;
    }

    try {
      this.tray.removeAllListeners();
      this.tray.destroy();
      debugLogger.info("Tray icon destroyed", { platform: process.platform }, "tray", "main");
    } catch (error) {
      debugLogger.warn(
        "Failed to destroy tray icon cleanly",
        { error: error?.message || String(error) },
        "tray",
        "main"
      );
    } finally {
      this.tray = null;
    }

    return true;
  }

  async recreateTray() {
    this.destroyTray();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return this.createTray();
  }

  async loadTrayIcon() {
    const platform = process.platform;
    const isDevelopment = process.env.NODE_ENV === "development";

    const candidatePaths = [];

    if (platform === "darwin") {
      if (isDevelopment) {
        candidatePaths.push(
          path.join(__dirname, "..", "assets", "trayTemplate.png"),
          path.join(__dirname, "..", "assets", "trayTemplate@2x.png"),
          path.join(__dirname, "..", "assets", "iconTemplate@3x.png"),
          path.join(__dirname, "..", "assets", "trayIcon.png"),
          path.join(__dirname, "..", "assets", "icon.png")
        );
      } else {
        // trayIcon.png first — trayTemplate.png is a transparent stub, must not be used
        candidatePaths.push(
          path.join(process.resourcesPath, "src", "assets", "trayIcon.png"),
          path.join(process.resourcesPath, "assets", "trayIcon.png"),
          path.join(app.getAppPath(), "src", "assets", "trayIcon.png"),
          path.join(process.resourcesPath, "app.asar.unpacked", "src", "assets", "trayIcon.png"),
          path.join(__dirname, "..", "..", "src", "assets", "trayIcon.png"),
          path.join(process.resourcesPath, "src", "assets", "icon.png"),
          path.join(process.resourcesPath, "assets", "icon.png"),
          path.join(app.getAppPath(), "src", "assets", "icon.png"),
          path.join(__dirname, "..", "..", "src", "assets", "icon.png")
        );
      }
    } else {
      const fileName = platform === "win32" ? "icon.ico" : "icon.png";
      if (isDevelopment) {
        candidatePaths.push(
          path.join(__dirname, "..", "assets", fileName),
          path.join(__dirname, "..", "assets", "icon.png")
        );
      } else {
        candidatePaths.push(
          path.join(process.resourcesPath, "src", "assets", fileName),
          path.join(process.resourcesPath, "assets", fileName),
          path.join(process.resourcesPath, "app.asar.unpacked", "src", "assets", fileName),
          path.join(__dirname, "..", "..", "src", "assets", fileName),
          path.join(app.getAppPath(), "src", "assets", fileName)
        );
      }
    }

    for (const testPath of candidatePaths) {
      try {
        debugLogger.debug("Checking tray icon candidate", { testPath }, "tray", "main");
        if (fs.existsSync(testPath)) {
          const icon = nativeImage.createFromPath(testPath);
          if (icon && !icon.isEmpty()) {
            const shouldUseTemplate =
              platform === "darwin" && path.basename(testPath).toLowerCase().includes("template");
            icon.setTemplateImage(shouldUseTemplate);
            const normalizedIcon = platform === "darwin" ? this.normalizeMacTrayIcon(icon) : icon;
            debugLogger.info("Using tray icon", { testPath }, "tray", "main");
            return normalizedIcon;
          }
          debugLogger.warn("Tray icon candidate loaded empty", { testPath }, "tray", "main");
        }
      } catch (error) {
        debugLogger.warn(
          "Error checking tray icon path",
          { testPath, error: error?.message || String(error) },
          "tray",
          "main"
        );
      }
    }

    debugLogger.error("Could not find tray icon in any expected location", {}, "tray");
    return this.createFallbackIcon();
  }

  createFallbackIcon() {
    try {
      // Create a simple 16x16 PNG icon programmatically
      const { createCanvas } = require("canvas");
      const canvas = createCanvas(16, 16);
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.arc(8, 8, 6, 0, 2 * Math.PI);
      ctx.fill();

      const buffer = canvas.toBuffer("image/png");
      const fallbackIcon = nativeImage.createFromBuffer(buffer);
      fallbackIcon.setTemplateImage(true);
      debugLogger.warn("Created fallback tray icon via canvas", {}, "tray", "main");
      return fallbackIcon;
    } catch (fallbackError) {
      debugLogger.warn(
        "Canvas not available, creating minimal fallback icon",
        { error: fallbackError?.message || String(fallbackError) },
        "tray",
        "main"
      );
      // Create a minimal 16x16 black square PNG as fallback
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x91, 0x68, 0x36, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x28, 0x53, 0x63, 0x08,
        0x05, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      const fallbackIcon = nativeImage.createFromBuffer(pngData);
      fallbackIcon.setTemplateImage(true);
      debugLogger.warn("Created minimal fallback tray icon", {}, "tray", "main");
      return fallbackIcon;
    }
  }

  normalizeMacTrayIcon(icon) {
    try {
      // The branded tray image contains intentional transparent padding, so a
      // 28px canvas keeps the visible ChordVox glyph aligned with nearby icons.
      // Electron and macOS handle Retina scaling; do not multiply this value.
      const size = TrayManager.MAC_TRAY_ICON_SIZE;

      const sized = icon.resize({
        width: size,
        height: size,
        quality: "best",
      });
      sized.setTemplateImage(false);
      debugLogger.debug("Normalized macOS tray icon", { logicalSize: size }, "tray", "main");
      return sized;
    } catch (error) {
      debugLogger.warn(
        "Failed to normalize macOS tray icon",
        { error: error?.message || String(error) },
        "tray",
        "main"
      );
      icon.setTemplateImage(false);
      return icon;
    }
  }

  buildContextMenuTemplate() {
    const dictationVisible = this.windowManager?.isDictationPanelVisible?.() ?? false;

    return [
      {
        label: dictationVisible
          ? i18nMain.t("tray.toggleDictation.hide")
          : i18nMain.t("tray.toggleDictation.show"),
        click: () => {
          if (!this.windowManager) return;
          if (this.windowManager.isDictationPanelVisible()) {
            this.windowManager.hideDictationPanel();
          } else {
            this.windowManager.showDictationPanel({ focus: true });
          }
          this.updateTrayMenu();
        },
      },
      {
        label: i18nMain.t("tray.openControlPanel"),
        click: async () => {
          await this.showControlPanelFromTray();
        },
      },
      { type: "separator" },
      {
        label: i18nMain.t("tray.quit"),
        click: () => {
          console.log("Quitting app via tray menu");
          app.quit();
        },
      },
    ];
  }

  updateTrayMenu() {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate(this.buildContextMenuTemplate());
    this.tray.setToolTip(i18nMain.t("tray.tooltip"));
    this.tray.setContextMenu(contextMenu);
  }

  setupTrayEventHandlers() {
    if (!this.tray) {
      return;
    }

    if (process.platform === "win32") {
      this.tray.on("click", () => {
        void this.showControlPanelFromTray();
      });
      this.tray.on("right-click", () => {
        this.tray?.popUpContextMenu();
      });
    } else {
      this.tray.on("click", () => {
        this.tray?.popUpContextMenu();
      });
    }

    this.tray.on("destroyed", () => {
      console.log("Tray icon destroyed");
      this.tray = null;
    });
  }
}

module.exports = TrayManager;
