import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetry, createApiRetryStrategy, createFileRetryStrategy } from "./retry";

describe("withRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns value on first attempt if it succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withRetry(fn);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds when a later attempt succeeds", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt < 3) {
        throw new Error(`error-${attempt}`);
      }
      return "success";
    });

    const promise = withRetry(fn, {
      maxRetries: 3,
      initialDelay: 100,
      backoffMultiplier: 2,
    });

    // Run timers to let all retries proceed
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops retrying and throws the last error when maxRetries is reached", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockImplementation(async () => {
      throw new Error("always-fails");
    });

    const promise = withRetry(fn, {
      maxRetries: 2,
      initialDelay: 100,
      backoffMultiplier: 2,
    });
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow("always-fails");
    expect(fn).toHaveBeenCalledTimes(3); // 1 original + 2 retries
  });

  it("does not retry if shouldRetry returns false", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockImplementation(async () => {
      throw new Error("fatal-error");
    });
    const shouldRetry = vi.fn().mockReturnValue(false);

    const promise = withRetry(fn, {
      maxRetries: 3,
      initialDelay: 100,
      shouldRetry,
    });
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow("fatal-error");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });
});

describe("createApiRetryStrategy", () => {
  const strategy = createApiRetryStrategy();

  it("shouldRetry returns true for HTTP server errors (5xx)", () => {
    expect(strategy.shouldRetry({ status: 500 })).toBe(true);
    expect(strategy.shouldRetry({ statusCode: 503 })).toBe(true);
    expect(strategy.shouldRetry({ response: { status: 502 } })).toBe(true);
  });

  it("shouldRetry returns true for specific retriable 4xx errors", () => {
    // 408 Timeout, 409 Conflict, 425 Too Early, 429 Too Many Requests
    expect(strategy.shouldRetry({ status: 408 })).toBe(true);
    expect(strategy.shouldRetry({ status: 409 })).toBe(true);
    expect(strategy.shouldRetry({ status: 425 })).toBe(true);
    expect(strategy.shouldRetry({ status: 429 })).toBe(true);
  });

  it("shouldRetry returns true for network errors (no response)", () => {
    expect(strategy.shouldRetry({ message: "Network Error" })).toBe(true);
  });

  it("shouldRetry returns false for other HTTP client errors", () => {
    expect(strategy.shouldRetry({ status: 400 })).toBe(false);
    expect(strategy.shouldRetry({ status: 401 })).toBe(false);
    expect(strategy.shouldRetry({ status: 403 })).toBe(false);
    expect(strategy.shouldRetry({ status: 404 })).toBe(false);
  });
});

describe("createFileRetryStrategy", () => {
  const strategy = createFileRetryStrategy();

  it("shouldRetry returns true only for retriable file system errors", () => {
    expect(strategy.shouldRetry({ code: "EBUSY" })).toBe(true);
    expect(strategy.shouldRetry({ code: "ENOENT" })).toBe(true);
    expect(strategy.shouldRetry({ code: "EPERM" })).toBe(true);
    expect(strategy.shouldRetry({ code: "EAGAIN" })).toBe(true);

    expect(strategy.shouldRetry({ code: "EEXIST" })).toBe(false);
  });

  it("returns correct retry count and initial delay config", () => {
    expect(strategy.maxRetries).toBe(2);
    expect(strategy.initialDelay).toBe(500);
  });
});
