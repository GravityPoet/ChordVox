import { afterEach, describe, expect, it, vi } from "vitest";
import contextSummaryService from "./ContextSummaryService";

type PostJsonCapable = {
  postJson: (
    endpoint: string,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal
  ) => Promise<unknown>;
};

const originalWindow = globalThis.window;

describe("ContextSummaryService", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("forwards AbortSignal cancellation to the main-process reasoning proxy", async () => {
    vi.useFakeTimers();
    let requestId = "";
    const proxyReasoningRequest = vi.fn(
      (payload: { requestId?: string }) =>
        new Promise((resolve) => {
          requestId = payload.requestId || "";
          setTimeout(() => resolve({ success: true, status: 200, body: "{}" }), 25);
        })
    );
    const cancelReasoningProxyRequest = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(globalThis, "window", {
      value: {
        electronAPI: {
          proxyReasoningRequest,
          cancelReasoningProxyRequest,
        },
      },
      configurable: true,
      writable: true,
    });

    const service = contextSummaryService as unknown as PostJsonCapable;
    const controller = new AbortController();
    const request = service.postJson(
      "https://example.test/vision",
      { "content-type": "application/json" },
      "{}",
      controller.signal
    );

    controller.abort();
    await Promise.resolve();

    expect(cancelReasoningProxyRequest).toHaveBeenCalledWith({ requestId });
    await vi.advanceTimersByTimeAsync(25);
    await expect(request).resolves.toEqual({});
  });

  it("does not start a proxy request when the signal is already aborted", async () => {
    const proxyReasoningRequest = vi.fn().mockResolvedValue({
      success: true,
      status: 200,
      body: "{}",
    });
    const cancelReasoningProxyRequest = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(globalThis, "window", {
      value: {
        electronAPI: {
          proxyReasoningRequest,
          cancelReasoningProxyRequest,
        },
      },
      configurable: true,
      writable: true,
    });

    const service = contextSummaryService as unknown as PostJsonCapable;
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.postJson(
        "https://example.test/vision",
        { "content-type": "application/json" },
        "{}",
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(proxyReasoningRequest).not.toHaveBeenCalled();
    expect(cancelReasoningProxyRequest).not.toHaveBeenCalled();
  });
});
