import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const WindowManager = require("./windowManager");
const DevServerManager = require("./devServerManager");

const originalNodeEnv = process.env.NODE_ENV;
const originalGetAppFilePath = DevServerManager.getAppFilePath;

afterEach(() => {
  DevServerManager.getAppFilePath = originalGetAppFilePath;
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

function createManager(loadFile) {
  const manager = Object.create(WindowManager.prototype);
  Object.assign(manager, {
    isQuitting: false,
    activeLocalFileLoads: new WeakSet(),
    waitForLocalFile: vi.fn(async () => true),
  });

  const window = {
    isDestroyed: () => false,
    loadFile,
  };
  return { manager, window };
}

describe("WindowManager packaged renderer loading", () => {
  it("retries a transient ERR_FAILED without racing the did-fail-load handler", async () => {
    process.env.NODE_ENV = "production";
    DevServerManager.getAppFilePath = () => ({
      path: "/packaged/app.asar/src/dist/index.html",
      query: { panel: "true" },
    });

    const loadFile = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("navigation interrupted"), { code: "ERR_FAILED" })
      )
      .mockResolvedValueOnce(undefined);
    const { manager, window } = createManager(loadFile);

    await manager.loadWindowContent(window, true);

    expect(loadFile).toHaveBeenCalledTimes(2);
    expect(loadFile).toHaveBeenLastCalledWith("/packaged/app.asar/src/dist/index.html", {
      query: { panel: "true" },
    });
    expect(manager.activeLocalFileLoads.has(window)).toBe(false);
  });

  it("does not retry non-transient renderer load errors", async () => {
    process.env.NODE_ENV = "production";
    DevServerManager.getAppFilePath = () => ({
      path: "/packaged/app.asar/src/dist/index.html",
      query: {},
    });

    const error = Object.assign(new Error("renderer rejected the document"), {
      code: "ERR_ABORTED",
    });
    const loadFile = vi.fn().mockRejectedValue(error);
    const { manager, window } = createManager(loadFile);

    await expect(manager.loadWindowContent(window)).rejects.toBe(error);
    expect(loadFile).toHaveBeenCalledOnce();
    expect(manager.activeLocalFileLoads.has(window)).toBe(false);
  });

  it("stops loading quietly when shutdown has already started", async () => {
    process.env.NODE_ENV = "production";
    DevServerManager.getAppFilePath = () => ({
      path: "/packaged/app.asar/src/dist/index.html",
      query: {},
    });

    const loadFile = vi.fn();
    const { manager, window } = createManager(loadFile);
    manager.isQuitting = true;

    await manager.loadWindowContent(window);

    expect(loadFile).not.toHaveBeenCalled();
  });
});
