import { describe, it, expect } from "vitest";
import {
  validateHotkey,
  normalizeHotkey,
  getReservedShortcuts,
  getValidationMessage,
  VALIDATION_RULES,
} from "./hotkeyValidator";

describe("VALIDATION_RULES", () => {
  it("locks the rules list", () => {
    expect(VALIDATION_RULES).toEqual([
      "Uses three keys or fewer",
      "Includes at least one modifier or non-alphanumeric key",
      "Does not mix left and right versions of the same modifier",
      "Is not reserved by the system",
    ]);
  });
});

describe("normalizeHotkey", () => {
  it("normalizes modifier names and order based on platform", () => {
    // Sort order: Control, Command, Alt, Shift, Super, Fn
    expect(normalizeHotkey("Shift+Control+Alt+A", "darwin")).toBe("Control+Alt+Shift+A");
    expect(normalizeHotkey("CmdOrCtrl+A", "darwin")).toBe("Command+A");
    expect(normalizeHotkey("CmdOrCtrl+A", "win32")).toBe("Control+A");
    expect(normalizeHotkey("Win+A", "win32")).toBe("Super+A");
    expect(normalizeHotkey("meta+A", "darwin")).toBe("Command+A");
    expect(normalizeHotkey("Option+A", "darwin")).toBe("Alt+A");
  });

  it("normalizes special key tokens", () => {
    expect(normalizeHotkey("Control+arrowleft", "darwin")).toBe("Control+Left");
    expect(normalizeHotkey("Control+escape", "darwin")).toBe("Control+Esc");
    expect(normalizeHotkey("Control+print", "darwin")).toBe("Control+PrintScreen");
    expect(normalizeHotkey("Control+pgup", "darwin")).toBe("Control+PageUp");
    expect(normalizeHotkey("Control+del", "darwin")).toBe("Control+Delete");
    expect(normalizeHotkey("Control+ins", "darwin")).toBe("Control+Insert");
    expect(normalizeHotkey("Control+space", "darwin")).toBe("Control+Space");
    expect(normalizeHotkey("Control+f5", "darwin")).toBe("Control+F5");
    expect(normalizeHotkey("Control+a", "darwin")).toBe("Control+A");
  });

  it("handles right-side modifiers", () => {
    expect(normalizeHotkey("rightctrl+A", "win32")).toBe("RightControl+A");
    expect(normalizeHotkey("RightOption+A", "darwin")).toBe("RightOption+A");
    expect(normalizeHotkey("rightwin+A", "win32")).toBe("RightSuper+A");
  });

  it("handles empty or blank values", () => {
    expect(normalizeHotkey("", "darwin")).toBe("");
    expect(normalizeHotkey(null as any, "darwin")).toBe("");
  });
});

describe("getReservedShortcuts", () => {
  it("returns platform specific reserved keys", () => {
    expect(getReservedShortcuts("darwin")).toContain("Command+C");
    expect(getReservedShortcuts("win32")).toContain("Control+C");
    expect(getReservedShortcuts("linux")).toContain("Control+C");
    // @ts-expect-error - testing invalid platform
    expect(getReservedShortcuts("invalid")).toEqual([]);
  });
});

describe("validateHotkey", () => {
  it("rejects empty or blank values", () => {
    expect(validateHotkey("", "darwin")).toEqual({
      valid: false,
      error: "Please enter a valid shortcut.",
    });
    expect(validateHotkey("   ", "darwin")).toEqual({
      valid: false,
      error: "Please enter a valid shortcut.",
    });
  });

  it("validates Globe and Fn keys correctly on darwin", () => {
    expect(validateHotkey("GLOBE", "darwin")).toEqual({ valid: true });
    expect(validateHotkey("Fn", "darwin")).toEqual({ valid: true });

    expect(validateHotkey("GLOBE", "win32")).toEqual({
      valid: false,
      error: "The Globe/Fn key is only available on macOS.",
      errorCode: "INVALID_GLOBE",
    });
  });

  it("rejects shortcuts with too many keys", () => {
    expect(validateHotkey("Control+Alt+Shift+A", "darwin")).toEqual({
      valid: false,
      error: "Shortcuts are limited to three keys.",
      errorCode: "TOO_MANY_KEYS",
    });
  });

  it("rejects mixing left and right versions of the same modifier", () => {
    expect(validateHotkey("leftctrl+rightctrl+A", "win32")).toEqual({
      valid: false,
      error: "Do not mix left and right versions of the same modifier in one shortcut.",
      errorCode: "LEFT_RIGHT_MIX",
    });
  });

  it("rejects shortcuts without modifier or special keys", () => {
    expect(validateHotkey("A", "darwin")).toEqual({
      valid: false,
      error:
        "Shortcuts must include a modifier or a non-alphanumeric key (like arrows, space, or function keys).",
      errorCode: "NO_MODIFIER_OR_SPECIAL",
    });
  });

  it("validates modifier-only shortcuts", () => {
    // Single left-modifier hotkey: invalid
    expect(validateHotkey("Control", "darwin")).toEqual({
      valid: false,
      error:
        "Single modifier hotkeys must use the right-side key (e.g., RightOption). Or use two modifiers (e.g., Control+Alt).",
      errorCode: "LEFT_MODIFIER_ONLY",
    });

    // Single right-modifier hotkey: valid on mac and windows, invalid on linux
    expect(validateHotkey("RightOption", "darwin")).toEqual({ valid: true });
    expect(validateHotkey("RightControl", "win32")).toEqual({ valid: true });
    expect(validateHotkey("RightOption", "linux")).toEqual({
      valid: false,
      error:
        "Right-side single modifier hotkeys are not supported on Linux. Use two modifiers (e.g., Control+Alt) instead.",
      errorCode: "LEFT_MODIFIER_ONLY",
    });

    // Two modifiers: valid
    expect(validateHotkey("Control+Alt", "darwin")).toEqual({ valid: true });
  });

  it("rejects duplicate hotkeys", () => {
    expect(validateHotkey("Control+Shift+K", "darwin", ["control+shift+k"])).toEqual({
      valid: false,
      error: "That shortcut is already in use.",
      errorCode: "DUPLICATE",
    });
  });

  it("rejects reserved hotkeys", () => {
    expect(validateHotkey("Command+C", "darwin")).toEqual({
      valid: false,
      error: "That shortcut is reserved by your system.",
      errorCode: "RESERVED",
    });
  });
});

describe("getValidationMessage", () => {
  it("returns null for valid hotkeys", () => {
    expect(getValidationMessage("Control+Shift+K", "darwin")).toBeNull();
  });

  it("returns specific system reserved message for reserved hotkeys", () => {
    expect(getValidationMessage("Command+C", "darwin")).toBe("Cmd+C is reserved by the system");
  });

  it("returns general error message for other validation failures", () => {
    expect(getValidationMessage("A", "darwin")).toBe(
      "Shortcuts must include a modifier or a non-alphanumeric key (like arrows, space, or function keys)."
    );
  });
});
