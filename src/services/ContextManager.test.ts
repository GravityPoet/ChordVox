import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateSummary = vi.hoisted(() => vi.fn());

vi.mock("./ContextSummaryService", () => ({
  default: { generateSummary },
}));

import { ContextManager, type ContextCaptureOptions } from "./ContextManager";

const originalWindow = globalThis.window;

const defaultOptions: ContextCaptureOptions = {
  enabled: true,
  textEnabled: true,
  visionEnabled: true,
  provider: "openai",
  model: "gpt-4o",
  apiKey: "test-key",
};

function installElectronApi(api: Record<string, unknown>) {
  Object.defineProperty(globalThis, "window", {
    value: { electronAPI: api },
    configurable: true,
    writable: true,
  });
}

describe("ContextManager", () => {
  beforeEach(() => {
    generateSummary.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
    }
  });

  it("does not pretend context capture is available on unsupported platforms", async () => {
    const captureContext = vi.fn();
    installElectronApi({
      checkContextPermissions: vi.fn().mockResolvedValue({
        accessibility: false,
        screenRecording: false,
        platform: "win32",
      }),
      captureContext,
    });

    const result = await new ContextManager().startCapture(defaultOptions);

    expect(result.error).toBe("platform-unsupported");
    expect(captureContext).not.toHaveBeenCalled();
  });

  it("captures only the layers that both the user and OS permissions allow", async () => {
    const captureContext = vi.fn().mockResolvedValue({
      appName: "Mail",
      visibleText: "Draft",
      layer1Success: true,
      layer2Success: false,
    });
    installElectronApi({
      checkContextPermissions: vi.fn().mockResolvedValue({
        accessibility: true,
        screenRecording: false,
        platform: "darwin",
      }),
      captureContext,
    });

    const result = await new ContextManager().startCapture(defaultOptions);

    expect(captureContext).toHaveBeenCalledWith({
      textEnabled: true,
      visionEnabled: false,
    });
    expect(result.captureResult?.visibleText).toBe("Draft");
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("aborts an in-flight vision summary when capture is cancelled", async () => {
    let receivedSignal: AbortSignal | undefined;
    let notifySummaryStarted: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      notifySummaryStarted = resolve;
    });

    generateSummary.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          receivedSignal = signal;
          notifySummaryStarted?.();
          signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        })
    );
    installElectronApi({
      checkContextPermissions: vi.fn().mockResolvedValue({
        accessibility: true,
        screenRecording: true,
        platform: "darwin",
      }),
      captureContext: vi.fn().mockResolvedValue({
        appName: "Browser",
        screenshotBase64: "image-data",
        screenshotMimeType: "image/png",
        layer1Success: true,
        layer2Success: true,
      }),
    });

    const manager = new ContextManager();
    const capture = manager.startCapture(defaultOptions);
    await summaryStarted;
    manager.cancelCapture();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(capture).resolves.toMatchObject({
      visionUsed: false,
    });
  });
});
