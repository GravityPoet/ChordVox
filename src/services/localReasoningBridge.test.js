import { beforeEach, describe, expect, it, vi } from "vitest";

const modelManager = {
  ensureLlamaCpp: vi.fn(),
  getAllModels: vi.fn(),
  runInference: vi.fn(),
};

const debugLogger = {
  logReasoning: vi.fn(),
};

import localReasoningModule from "./localReasoningBridge";

const { LocalReasoningService } = localReasoningModule;
let service;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("localReasoningBridge request queue", () => {
  beforeEach(() => {
    modelManager.runInference.mockReset();
    debugLogger.logReasoning.mockReset();
    service = new LocalReasoningService(modelManager, debugLogger);
  });

  it("serializes requests so a model switch cannot race active inference", async () => {
    const firstInference = deferred();
    modelManager.runInference
      .mockImplementationOnce(() => firstInference.promise)
      .mockResolvedValueOnce("second result");

    const first = service.processText("first", "model-a");
    const second = service.processText("second", "model-b");
    await vi.waitFor(() => expect(modelManager.runInference).toHaveBeenCalledTimes(1));

    expect(modelManager.runInference).toHaveBeenNthCalledWith(
      1,
      "model-a",
      "first",
      expect.any(Object)
    );

    firstInference.resolve("first result");
    await expect(first).resolves.toBe("first result");
    await expect(second).resolves.toBe("second result");
    expect(modelManager.runInference).toHaveBeenNthCalledWith(
      2,
      "model-b",
      "second",
      expect.any(Object)
    );
  });

  it("skips a queued request that was cancelled before inference starts", async () => {
    const firstInference = deferred();
    modelManager.runInference.mockImplementationOnce(() => firstInference.promise);

    const first = service.processText("first", "model-a");
    const controller = new AbortController();
    const cancelled = service.processText("cancelled", "model-b", {
      signal: controller.signal,
    });
    controller.abort();

    firstInference.resolve("first result");
    await expect(first).resolves.toBe("first result");
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(modelManager.runInference).toHaveBeenCalledTimes(1);
  });

  it("forwards a zero thinking budget without replacing it with a default", async () => {
    modelManager.runInference.mockResolvedValueOnce("cleaned");

    await expect(
      service.processText("draft", "qwen3-8b-q5_k_m", { thinkingBudgetTokens: 0 })
    ).resolves.toBe("cleaned");

    expect(modelManager.runInference).toHaveBeenCalledWith(
      "qwen3-8b-q5_k_m",
      "draft",
      expect.objectContaining({ thinkingBudgetTokens: 0 })
    );
  });

  it("bounds queued work and supersedes the oldest waiting request", async () => {
    service = new LocalReasoningService(modelManager, debugLogger, { maxQueueLength: 1 });
    const firstInference = deferred();
    modelManager.runInference
      .mockImplementationOnce(() => firstInference.promise)
      .mockResolvedValueOnce("third result");

    const first = service.processText("first", "model-a");
    const second = service.processText("second", "model-b");
    const third = service.processText("third", "model-c");

    await expect(second).rejects.toMatchObject({ code: "ERR_LOCAL_REASONING_SUPERSEDED" });
    expect(modelManager.runInference).toHaveBeenCalledTimes(1);
    firstInference.resolve("first result");
    await expect(first).resolves.toBe("first result");
    await expect(third).resolves.toBe("third result");
    expect(modelManager.runInference).toHaveBeenCalledTimes(2);
  });

  it("forwards cancellation to an active inference", async () => {
    const activeInference = deferred();
    let forwardedSignal;
    modelManager.runInference.mockImplementationOnce((_model, _text, options) => {
      forwardedSignal = options.signal;
      return activeInference.promise;
    });

    const controller = new AbortController();
    const request = service.processText("active", "model-a", { signal: controller.signal });
    await vi.waitFor(() => expect(forwardedSignal).toBeDefined());
    controller.abort();
    expect(forwardedSignal.aborted).toBe(true);
    activeInference.resolve("cancelled result");
    await expect(request).resolves.toBe("cancelled result");
  });
});
