import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { shouldHideDictationWindowBeforePaste } = require("./pasteTargetFocus");

function createWindow({ destroyed = false, focused = false, visible = false } = {}) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    isFocused: vi.fn(() => focused),
    isVisible: vi.fn(() => visible),
  };
}

describe("shouldHideDictationWindowBeforePaste", () => {
  it("hides the focused overlay on every platform", () => {
    expect(
      shouldHideDictationWindowBeforePaste(createWindow({ focused: true, visible: true }), "darwin")
    ).toBe(true);
  });

  it("hides a visible Windows overlay even when Electron focus state is stale", () => {
    expect(
      shouldHideDictationWindowBeforePaste(createWindow({ focused: false, visible: true }), "win32")
    ).toBe(true);
  });

  it("does not hide an unfocused overlay on non-Windows platforms", () => {
    expect(
      shouldHideDictationWindowBeforePaste(createWindow({ focused: false, visible: true }), "linux")
    ).toBe(false);
  });

  it("ignores missing, destroyed, and already hidden windows", () => {
    expect(shouldHideDictationWindowBeforePaste(null, "win32")).toBe(false);
    expect(
      shouldHideDictationWindowBeforePaste(
        createWindow({ destroyed: true, focused: true, visible: true }),
        "win32"
      )
    ).toBe(false);
    expect(
      shouldHideDictationWindowBeforePaste(
        createWindow({ focused: false, visible: false }),
        "win32"
      )
    ).toBe(false);
  });
});
