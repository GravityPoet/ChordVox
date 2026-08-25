import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCapabilityResolver } from "./ModelCapabilityResolver";

const originalWindow = globalThis.window;

describe("ModelCapabilityResolver", () => {
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

  it("reuses a successful live capability result instead of probing every dictation", async () => {
    const testVisionCapability = vi.fn().mockResolvedValue({
      supported: true,
      provider: "openai",
      model: "gpt-4o",
    });
    Object.defineProperty(globalThis, "window", {
      value: { electronAPI: { testVisionCapability } },
      configurable: true,
      writable: true,
    });

    const resolver = new ModelCapabilityResolver();
    const options = {
      provider: "OpenAI",
      model: "GPT-4o",
      apiKey: "test-key",
    };

    const first = await resolver.resolveVisionCapability(options);
    const second = await resolver.resolveVisionCapability(options);

    expect(first.supported).toBe(true);
    expect(second.supported).toBe(true);
    expect(second.testedAt).toBeTypeOf("string");
    expect(testVisionCapability).toHaveBeenCalledTimes(1);
  });

  it("uses known model capabilities without starting a separate live probe", async () => {
    const testVisionCapability = vi.fn();
    Object.defineProperty(globalThis, "window", {
      value: { electronAPI: { testVisionCapability } },
      configurable: true,
      writable: true,
    });

    const resolver = new ModelCapabilityResolver();
    const result = await resolver.resolveVisionCapability({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "test-key",
      probe: false,
    });

    expect(result.supported).toBe(true);
    expect(result.error).toContain("live probe skipped");
    expect(testVisionCapability).not.toHaveBeenCalled();
  });

  it("uses a successful settings-page test for a custom model during dictation", async () => {
    const testVisionCapability = vi.fn();
    Object.defineProperty(globalThis, "window", {
      value: { electronAPI: { testVisionCapability } },
      configurable: true,
      writable: true,
    });

    const resolver = new ModelCapabilityResolver();
    resolver.rememberVisionCapability({
      provider: "custom",
      model: "company-vision-v2",
      baseUrl: "https://example.test/v1",
    });

    const result = await resolver.resolveVisionCapability({
      provider: "custom",
      model: "company-vision-v2",
      baseUrl: "https://example.test/v1",
      probe: false,
    });

    expect(result.supported).toBe(true);
    expect(result.testedAt).toBeTypeOf("string");
    expect(testVisionCapability).not.toHaveBeenCalled();
  });
});
