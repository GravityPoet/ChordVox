import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const ClipboardManager = require("./clipboard");

describe("ClipboardManager paste cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a delayed paste before any keystroke process starts", async () => {
    vi.useFakeTimers();
    const manager = new ClipboardManager();
    const request = manager._registerPasteRequest("delayed-paste");
    const operation = vi.fn().mockResolvedValue(undefined);

    const pending = manager._runCancelableDelay(request, 250, operation);
    expect(manager.cancelPasteRequest("delayed-paste")).toEqual({ cancelled: true });
    await expect(pending).rejects.toMatchObject({ code: "PASTE_CANCELLED" });

    await vi.advanceTimersByTimeAsync(300);
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects and terminates a paste process that has already started", async () => {
    vi.useFakeTimers();
    const manager = new ClipboardManager();
    const request = manager._registerPasteRequest("active-paste");
    const fakeProcess = {
      exitCode: null,
      pid: 12345,
      kill: vi.fn(),
    };

    const pending = manager._runCancelableDelay(request, 0, () => {
      manager._attachPasteRequestProcess(request, fakeProcess);
      return new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.cancelPasteRequest("active-paste")).toEqual({ cancelled: true });
    await expect(pending).rejects.toMatchObject({ code: "PASTE_CANCELLED" });
    if (process.platform !== "win32") {
      expect(fakeProcess.kill).toHaveBeenCalledWith("SIGKILL");
    }
  });
});
