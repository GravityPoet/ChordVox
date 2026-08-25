/**
 * Native Liquid Glass helper for macOS Tahoe (26+).
 * Wraps electron-liquid-glass with capability detection and fallback chain.
 *
 * Fallback chain: liquidGlass → vibrancy → CSS-only (no-op).
 * Windows: acrylic (Win11 22H2+) → CSS-only.
 */

const NATIVE_GLASS_MIN_MACOS = 26;
const NATIVE_GLASS_MIN_WIN_BUILD = 22621; // Windows 11 22H2

let _liquidGlass = null;
let _loadAttempted = false;

/**
 * Lazy-load electron-liquid-glass. Returns null if unavailable.
 */
function getLiquidGlassModule() {
  if (_loadAttempted) return _liquidGlass;
  _loadAttempted = true;
  try {
    _liquidGlass = require("electron-liquid-glass");
  } catch (_err) {
    // Module not available (e.g. Windows, Linux, or missing native binary)
    _liquidGlass = null;
  }
  return _liquidGlass;
}

/**
 * Detect whether the current system supports native glass.
 * Returns: { supported: boolean, method: "liquid-glass" | "vibrancy" | "css-only", macOSVersion: number }
 */
function detectCapability() {
  if (process.platform === "win32") {
    const release = process.getSystemVersion(); // e.g. "10.0.22621"
    const build = parseInt(release.split(".")[2], 10) || 0;
    if (build >= NATIVE_GLASS_MIN_WIN_BUILD) {
      return { supported: true, method: "acrylic", macOSVersion: 0 };
    }
    return { supported: false, method: "css-only", macOSVersion: 0 };
  }

  if (process.platform !== "darwin") {
    return { supported: false, method: "css-only", macOSVersion: 0 };
  }

  const versionStr = process.getSystemVersion();
  const major = parseInt(versionStr.split(".")[0], 10) || 0;

  if (major >= NATIVE_GLASS_MIN_MACOS) {
    const lg = getLiquidGlassModule();
    if (lg) {
      return { supported: true, method: "liquid-glass", macOSVersion: major };
    }
    // macOS 26+ but module missing → vibrancy fallback
    return { supported: true, method: "vibrancy", macOSVersion: major };
  }

  // Older macOS → vibrancy fallback
  return { supported: false, method: "vibrancy", macOSVersion: major };
}

/**
 * Apply glass effect to a BrowserWindow.
 * @param {Electron.BrowserWindow} win
 * @param {object} [options]
 * @param {number} [options.cornerRadius]
 * @param {string} [options.tintColor] — hex #RRGGBB or #RRGGBBAA
 * @param {boolean} [options.opaque]
 * @param {number} [options.variant] — glass variant (0=regular, 1=clear, 8=controlCenter, etc.)
 * @returns {{ method: string, glassId: number|null }}
 */
function applyGlass(win, options = {}) {
  if (!win || win.isDestroyed()) {
    return { method: "css-only", glassId: null };
  }

  const cap = detectCapability();

  if (cap.method === "liquid-glass") {
    const lg = getLiquidGlassModule();
    try {
      const glassId = lg.addView(win.getNativeWindowHandle(), {
        cornerRadius: options.cornerRadius ?? 0,
        tintColor: options.tintColor,
        opaque: options.opaque ?? false,
      });

      if (options.variant !== undefined) {
        try {
          lg.unstable_setVariant(glassId, options.variant);
        } catch (err) {
          console.warn(
            "[nativeGlass] liquid-glass variant failed; keeping default view:",
            err.message
          );
        }
      }

      return { method: "liquid-glass", glassId };
    } catch (err) {
      console.warn("[nativeGlass] liquid-glass failed, falling back to vibrancy:", err.message);
      // Fall through to vibrancy
    }
  }

  // Windows acrylic
  if (cap.method === "acrylic") {
    try {
      win.setBackgroundMaterial("acrylic");
      return { method: "acrylic", glassId: null };
    } catch (err) {
      console.warn("[nativeGlass] acrylic failed, falling back to css-only:", err.message);
    }
  }

  // Vibrancy fallback for older macOS or if liquid-glass failed
  if (cap.method === "vibrancy" || cap.macOSVersion > 0) {
    try {
      win.setVibrancy("under-window");
      return { method: "vibrancy", glassId: null };
    } catch (err) {
      console.warn("[nativeGlass] vibrancy failed:", err.message);
    }
  }

  return { method: "css-only", glassId: null };
}

/**
 * Configure a window for native glass before it loads content.
 * Call this BEFORE win.loadURL/loadFile.
 * @param {Electron.BrowserWindow} win
 */
function prepareWindowForGlass(win) {
  if (!win || win.isDestroyed()) return;
  if (process.platform !== "darwin") return;

  const cap = detectCapability();
  if (cap.method === "liquid-glass") {
    // Must be transparent for liquid glass
    // (already set via windowConfig, but ensure it)
    win.setWindowButtonVisibility(true);
  }
}

module.exports = {
  detectCapability,
  applyGlass,
  prepareWindowForGlass,
  NATIVE_GLASS_MIN_MACOS,
};
