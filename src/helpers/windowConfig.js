const path = require("path");
const DICTATION_WINDOW_LAYOUT = require("../config/dictationWindowLayout.json");
const { resolveElectronEntry } = require("./electronBundlePaths");
const MAIN_WINDOW_STATE_LAYOUT_VERSION = 2;

function normalizeDictationAnimationStyle(style) {
  return Object.prototype.hasOwnProperty.call(DICTATION_WINDOW_LAYOUT.styles, style)
    ? style
    : DICTATION_WINDOW_LAYOUT.defaultStyle;
}

function getDictationWindowSize(style) {
  return DICTATION_WINDOW_LAYOUT.styles[normalizeDictationAnimationStyle(style)];
}

function clampWindowPositionToWorkArea(position, size, workArea) {
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - size.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - size.height);
  return {
    x: Math.max(workArea.x, Math.min(Math.round(position.x), maxX)),
    y: Math.max(workArea.y, Math.min(Math.round(position.y), maxY)),
  };
}

function clampVisiblePanelPosition(position, size, workArea, displayBounds = workArea) {
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - size.width);
  const maxY = Math.max(workArea.y, displayBounds.y + displayBounds.height - size.height);
  return {
    x: Math.max(workArea.x, Math.min(Math.round(position.x), maxX)),
    y: Math.max(workArea.y, Math.min(Math.round(position.y), maxY)),
  };
}

function clampRestoredPanelPosition(
  position,
  size,
  workArea,
  displayBounds = workArea,
  layoutVersion = 0,
  platform = process.platform
) {
  return platform === "darwin" && Number(layoutVersion) >= MAIN_WINDOW_STATE_LAYOUT_VERSION
    ? clampVisiblePanelPosition(position, size, workArea, displayBounds)
    : clampWindowPositionToWorkArea(position, size, workArea);
}

function getMainWindowAnchorHeight(size) {
  return Number(size?.height);
}

function getMainWindowResizePosition(newSize, anchorCenterX, anchorBottomY) {
  const anchorHeight = getMainWindowAnchorHeight(newSize);

  return {
    anchorHeight,
    position: {
      x: anchorCenterX - newSize.width / 2,
      y: anchorBottomY - anchorHeight,
    },
  };
}

const WINDOW_SIZES = {
  BASE: { width: 96, height: 96 },
  ACTIVE: getDictationWindowSize("flow"),
  NEBULA: getDictationWindowSize("nebula"),
  WITH_MENU: { width: 560, height: 250 },
  WITH_TOAST: { width: 560, height: 520 },
  EXPANDED: { width: 560, height: 520 },
  COMMAND_MENU: { width: 188, height: 98 },
  COMPLETION_ALERT: { width: 460, height: 220 },
};

// Main dictation window configuration
const MAIN_WINDOW_CONFIG = {
  width: WINDOW_SIZES.BASE.width,
  height: WINDOW_SIZES.BASE.height,
  title: "Voice Recorder",
  webPreferences: {
    preload: resolveElectronEntry("preload.js"),
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
  acceptFirstMouse: true, // Accept clicks even when not focused
  type: process.platform === "darwin" ? "panel" : "normal", // Panel on macOS preserves floating behavior
};

// Control panel window configuration
const CONTROL_PANEL_CONFIG = {
  width: 1200,
  height: 800,
  webPreferences: {
    preload: resolveElectronEntry("preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
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
  transparent: process.platform === "darwin", // Required for native Liquid Glass on macOS
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
    preload: resolveElectronEntry("preload.js"),
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

const COMPLETION_ALERT_WINDOW_CONFIG = {
  width: WINDOW_SIZES.COMPLETION_ALERT.width,
  height: WINDOW_SIZES.COMPLETION_ALERT.height,
  webPreferences: {
    preload: resolveElectronEntry("preload.js"),
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
  closable: true,
  fullscreenable: false,
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
    const BOTTOM_OFFSET = 24;
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = Math.round(workArea.y + workArea.height - height - BOTTOM_OFFSET);
    return { x, y, width, height };
  }

  static setupAlwaysOnTop(window) {
    if (process.platform === "darwin") {
      // macOS: Use panel level for proper floating behavior
      // This ensures the window stays on top across spaces and fullscreen apps
      window.setAlwaysOnTop(true, "status", 1);
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true, // Keep Dock/Command-Tab behaviour
      });
      window.setFullScreenable(false);

      if (window.isVisible()) {
        window.setAlwaysOnTop(true, "status", 1);
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
  COMPLETION_ALERT_WINDOW_CONFIG,
  DICTATION_WINDOW_LAYOUT,
  MAIN_WINDOW_STATE_LAYOUT_VERSION,
  WINDOW_SIZES,
  WindowPositionUtil,
  clampVisiblePanelPosition,
  clampRestoredPanelPosition,
  clampWindowPositionToWorkArea,
  getDictationWindowSize,
  getMainWindowAnchorHeight,
  getMainWindowResizePosition,
  normalizeDictationAnimationStyle,
};
