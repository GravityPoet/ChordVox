import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Module = require("module");

describe("nativeGlass", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalGetSystemVersion = process.getSystemVersion;
  const originalModuleLoad = Module._load;

  beforeEach(() => {
    vi.resetModules();
    delete require.cache[require.resolve("./nativeGlass")];
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.getSystemVersion = () => "26.0.0";
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    process.getSystemVersion = originalGetSystemVersion;
    vi.restoreAllMocks();
  });

  it("keeps an attached liquid-glass view when only variant application fails", () => {
    const liquidGlass = {
      addView: vi.fn(() => 42),
      unstable_setVariant: vi.fn(() => {
        throw new Error("unsupported variant");
      }),
    };
    vi.spyOn(Module, "_load").mockImplementation((request, parent, isMain) => {
      if (request === "electron-liquid-glass") {
        return liquidGlass;
      }
      return originalModuleLoad.call(Module, request, parent, isMain);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { applyGlass } = require("./nativeGlass");
    const win = {
      getNativeWindowHandle: () => Buffer.from("native-window"),
      isDestroyed: () => false,
      setVibrancy: vi.fn(),
    };

    expect(applyGlass(win, { variant: 8 })).toEqual({ method: "liquid-glass", glassId: 42 });
    expect(win.setVibrancy).not.toHaveBeenCalled();
  });
});
