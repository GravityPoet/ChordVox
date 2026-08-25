// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const contextManager = vi.hoisted(() => ({
  cancelCapture: vi.fn(),
  releaseCapture: vi.fn(),
  startCapture: vi.fn(async () => ({ visionUsed: false })),
  waitForContext: vi.fn(),
  getContextForReasoning: vi.fn(),
}));

vi.mock("../services/ContextManager", () => ({
  default: contextManager,
}));

let AudioManager;

const storage = new (class {
  constructor() {
    this.data = new Map();
  }
  getItem(key) {
    return this.data.get(key) ?? null;
  }
  setItem(key, value) {
    this.data.set(key, String(value));
  }
  removeItem(key) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
})();

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AudioManager context capture sequencing", () => {
  beforeAll(async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    AudioManager = (await import("./audioManager")).default;
  });

  beforeEach(() => {
    storage.clear();
    storage.setItem("reasoningProvider", "openai");
    storage.setItem("reasoningModel", "gpt-4o");
    contextManager.cancelCapture.mockClear();
    contextManager.startCapture.mockClear();
    contextManager.startCapture.mockImplementation(async () => {
      contextManager.cancelCapture();
      return { visionUsed: false };
    });
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  it("drops an older settings response instead of cancelling the newer capture", async () => {
    const olderSettings = deferred();
    const getContextSettings = vi
      .fn()
      .mockImplementationOnce(() => olderSettings.promise)
      .mockResolvedValueOnce({ textEnabled: true, visionEnabled: true });
    window.electronAPI = {
      getContextSettings,
      getFrontmostApp: vi.fn().mockResolvedValue(null),
    };

    const manager = new AudioManager();
    await manager.startContextCapture("older-run");
    await manager.startContextCapture("newer-run");
    await Promise.resolve();

    expect(contextManager.startCapture).toHaveBeenCalledTimes(1);
    const cancelCallsBeforeStaleResponse = contextManager.cancelCapture.mock.calls.length;

    olderSettings.resolve({ textEnabled: true, visionEnabled: true });
    await olderSettings.promise;
    await Promise.resolve();

    expect(contextManager.startCapture).toHaveBeenCalledTimes(1);
    expect(contextManager.cancelCapture).toHaveBeenCalledTimes(cancelCallsBeforeStaleResponse);
    manager.cancelContextCapture();
  });
});
