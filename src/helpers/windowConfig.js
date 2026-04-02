const path = require("path");

const WINDOW_SIZES = {
  BASE: { width: 96, height: 96 },
  ACTIVE: { width: 492, height: 88 },
  WITH_MENU: { width: 560, height: 250 },
  WITH_TOAST: { width: 560, height: 520 },
  EXPANDED: { width: 560, height: 520 },
  COMMAND_MENU: { width: 188, height: 98 },
};

// Main dictation window configuration
const MAIN_WINDOW_CONFIG = {
  width: WINDOW_SIZES.BASE.width,
  height: WINDOW_SIZES.BASE.height,
  title: "Voice Recorder",
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
  frame: false,
  alwaysOnTop: true,
  resizable: false,
  transparent: true,
  show: false, // Start hidden, show after setup
  skipTaskbar: false, // Keep visible in Dock/taskbar so app stays discoverable
  focusable: true,
  visibleOnAllWorkspaces: process.platform !== "win32",
  fullScreenable: false,
  hasShadow: false, // Remove shadow for cleaner look
  acceptsFirstMouse: true, // Accept clicks even when not focused
  type: process.platform === "darwin" ? "panel" : "normal", // Panel on macOS preserves floating behavior
};

// Control panel window configuration
const CONTROL_PANEL_CONFIG = {
  width: 1200,
  height: 800,
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    // sandbox: false is required because the preload script bridges IPC
    // between the renderer and main process.
    sandbox: false,
    // webSecurity: false disables same-origin policy. Required because in
    // production the renderer loads from a file:// origin but makes
    // cross-origin fetch calls to Neon Auth, Gemini, OpenAI, and Groq APIs
    // directly from the browser. These would be blocked by CORS otherwise.
    webSecurity: false,
    spellcheck: false,
  },
  title: "Control Panel",
  resizable: true,
  show: false,
  frame: false,
  ...(process.platform === "darwin" && {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 20 },
  }),
  transparent: false,
  minimizable: true,
  maximizable: true,
  closable: true,
  fullscreenable: true,
  skipTaskbar: false,
  alwaysOnTop: false,
  visibleOnAllWorkspaces: false,
  type: "normal",
};

const COMMAND_MENU_WINDOW_CONFIG = {
  width: WINDOW_SIZES.COMMAND_MENU.width,
  height: WINDOW_SIZES.COMMAND_MENU.height,
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
  frame: false,
  transparent: true,
  show: false,
  resizable: false,
  minimizable: false,
  maximizable: false,
  closable: false,
  fullscreenable: false,
  movable: false,
  skipTaskbar: true,
  focusable: true,
  alwaysOnTop: true,
  hasShadow: false,
  visibleOnAllWorkspaces: process.platform !== "win32",
  type: process.platform === "darwin" ? "panel" : "toolbar",
};

class WindowPositionUtil {
  static getMainWindowPosition(display, customSize = null) {
    const { width, height } = customSize || WINDOW_SIZES.BASE;
    const workArea = display.workArea || display.bounds;
    const BOTTOM_OFFSET = 48;
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = Math.round(workArea.y + workArea.height - height - BOTTOM_OFFSET);
    return { x, y, width, height };
  }

  static setupAlwaysOnTop(window) {
    if (process.platform === "darwin") {
      // macOS: Use panel level for proper floating behavior
      // This ensures the window stays on top across spaces and fullscreen apps
      window.setAlwaysOnTop(true, "floating", 1);
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true, // Keep Dock/Command-Tab behaviour
      });
      window.setFullScreenable(false);

      if (window.isVisible()) {
        window.setAlwaysOnTop(true, "floating", 1);
      }
    } else if (process.platform === "win32") {
      window.setAlwaysOnTop(true, "pop-up-menu");
    } else {
      window.setAlwaysOnTop(true, "screen-saver");
    }
  }
}

module.exports = {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  COMMAND_MENU_WINDOW_CONFIG,
  WINDOW_SIZES,
  WindowPositionUtil,
};
