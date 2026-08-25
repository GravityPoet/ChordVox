import { describe, expect, it } from "vitest";
import { recordRendererE2eEvent } from "./e2eRendererEvents";

describe("e2eRendererEvents", () => {
  it("records only when the E2E preload probe is exposed", () => {
    const originalWindow = globalThis.window;
    globalThis.window = {};
    try {
      recordRendererE2eEvent("recording-start-requested", { mode: "batch" });
      expect(globalThis.window.__CHORDVOX_E2E_RENDERER_EVENTS).toBeUndefined();

      globalThis.window.electronAPI = { getE2eListenerRegistrations: () => ({}) };
      recordRendererE2eEvent("recording-start-requested", { mode: "batch" });
      expect(globalThis.window.__CHORDVOX_E2E_RENDERER_EVENTS).toMatchObject([
        {
          type: "recording-start-requested",
          payload: { mode: "batch" },
        },
      ]);
    } finally {
      if (originalWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = originalWindow;
      }
    }
  });
});
