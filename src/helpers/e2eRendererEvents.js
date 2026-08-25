export function recordRendererE2eEvent(type, payload = {}) {
  try {
    if (
      typeof window === "undefined" ||
      typeof window.electronAPI?.getE2eListenerRegistrations !== "function"
    ) {
      return;
    }
    if (!Array.isArray(window.__CHORDVOX_E2E_RENDERER_EVENTS)) {
      window.__CHORDVOX_E2E_RENDERER_EVENTS = [];
    }
    window.__CHORDVOX_E2E_RENDERER_EVENTS.push({
      type,
      payload,
      at: Date.now(),
    });
  } catch {
    // E2E diagnostics must never affect product behavior.
  }
}
