// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { determineTranscriptionRoute } from "./transcriptionRouting";

class MemoryStorage {
  constructor() {
    this.data = new Map();
  }
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key) {
    return this.data.get(key) ?? null;
  }
  key(index) {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key) {
    this.data.delete(key);
  }
  setItem(key, value) {
    this.data.set(key, value);
  }
}

const mockStorage = new MemoryStorage();

describe("determineTranscriptionRoute Characterization Tests", () => {
  beforeAll(() => {
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
  });

  beforeEach(() => {
    mockStorage.clear();
  });

  it("routes to local-streaming if sourceType is file and shouldUseLocalStreaming is true", () => {
    const settingsMap = {
      useLocalWhisper: "false",
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: null,
      sourceType: "file",
      shouldUseLocalStreaming: true,
      uiLanguage: "en",
      storedCloudTranscriptionProvider: "",
      isSignedIn: false,
    });

    expect(route.provider).toBe("local-streaming");
    expect(route.activeModel).toBeNull();
  });

  it("routes to local Provider when useLocalWhisper is true", () => {
    const settingsMap = {
      useLocalWhisper: "true",
      localTranscriptionProvider: "nvidia",
      parakeetModel: "my-parakeet-model",
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: null,
      sourceType: "mic",
      shouldUseLocalStreaming: false,
      uiLanguage: "en",
      storedCloudTranscriptionProvider: "",
      isSignedIn: false,
    });

    expect(route.provider).toBe("nvidia");
    expect(route.activeModel).toBe("my-parakeet-model");
    expect(route.useLocalWhisper).toBe(true);
  });

  it("routes to local Paraformer when useLocalWhisper is true and local provider is paraformer", () => {
    const settingsMap = {
      useLocalWhisper: "true",
      localTranscriptionProvider: "paraformer",
      paraformerModel: "my-paraformer-model",
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: null,
      sourceType: "mic",
      shouldUseLocalStreaming: false,
      uiLanguage: "zh",
      storedCloudTranscriptionProvider: "",
      isSignedIn: false,
    });

    expect(route.provider).toBe("paraformer");
    expect(route.activeModel).toBe("my-paraformer-model");
  });

  it("routes to the selected local Cohere runtime instead of silently falling back to Whisper", () => {
    const settingsMap = {
      useLocalWhisper: "true",
      localTranscriptionProvider: "cohere",
      cohereModel: "cohere-transcribe-test",
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: null,
      sourceType: "file",
      shouldUseLocalStreaming: false,
      uiLanguage: "en",
      storedCloudTranscriptionProvider: "",
      isSignedIn: false,
    });

    expect(route.provider).toBe("cohere");
    expect(route.activeModel).toBe("cohere-transcribe-test");
  });

  it("routes to local Whisper (default) when local provider is whisper", () => {
    const settingsMap = {
      useLocalWhisper: "true",
      localTranscriptionProvider: "whisper",
      whisperModel: "turbo",
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: null,
      sourceType: "mic",
      shouldUseLocalStreaming: false,
      uiLanguage: "en",
      storedCloudTranscriptionProvider: "",
      isSignedIn: false,
    });

    expect(route.provider).toBe("whisper");
    expect(route.activeModel).toBe("turbo");
  });

  it("forces batch fallback route when provided", () => {
    const settingsMap = {
      useLocalWhisper: "false", // should be ignored
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: {
        provider: "paraformer",
        model: "forced-paraformer-model",
      },
      sourceType: "mic",
      shouldUseLocalStreaming: false,
      uiLanguage: "en",
      storedCloudTranscriptionProvider: "",
      isSignedIn: false,
    });

    expect(route.provider).toBe("paraformer");
    expect(route.activeModel).toBe("forced-paraformer-model");
    expect(route.useLocalWhisper).toBe(true);
  });

  it("falls back to local transcription when an unavailable hosted mode is still stored", () => {
    const settingsMap = {
      useLocalWhisper: "false",
      localTranscriptionProvider: "whisper",
      whisperModel: "turbo",
      cloudTranscriptionMode: "chordvox_cloud",
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: null,
      sourceType: "mic",
      shouldUseLocalStreaming: false,
      uiLanguage: "en",
      storedCloudTranscriptionProvider: "", // not explicit BYOK provider
      isSignedIn: true,
    });

    expect(route.provider).toBe("whisper");
    expect(route.activeModel).toBe("turbo");
    expect(route.useLocalWhisper).toBe(true);
    expect(route.useCloud).toBe(false);
  });

  it("uses configured BYOK instead of an unavailable hosted mode", () => {
    const settingsMap = {
      useLocalWhisper: "false",
      cloudTranscriptionMode: "chordvox_cloud",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionModel: "gpt-4o-mini-transcribe",
      openaiApiKey: "sk-test-key",
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: null,
      sourceType: "mic",
      shouldUseLocalStreaming: false,
      uiLanguage: "en",
      storedCloudTranscriptionProvider: "openai",
      isSignedIn: true,
    });

    expect(route.provider).toBe("openai");
    expect(route.activeModel).toBe("gpt-4o-mini-transcribe");
    expect(route.useLocalWhisper).toBe(false);
    expect(route.cloudTranscriptionMode).toBe("byok");
    expect(route.useCloud).toBe(false);
  });

  it("routes to BYOK Cloud mode when explicit BYOK provider is stored", () => {
    const settingsMap = {
      useLocalWhisper: "false",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionModel: "gpt-4o",
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: null,
      sourceType: "mic",
      shouldUseLocalStreaming: false,
      uiLanguage: "en",
      storedCloudTranscriptionProvider: "openai", // explicit BYOK
      isSignedIn: false,
    });

    expect(route.provider).toBe("openai");
    expect(route.activeModel).toBe("gpt-4o");
    expect(route.useCloud).toBe(false);
  });

  it("routes to BYOK Cloud mode with default model for provider when model setting is empty", () => {
    const settingsMap = {
      useLocalWhisper: "false",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "groq",
      cloudTranscriptionModel: "",
    };

    const route = determineTranscriptionRoute({
      getSettingValue: (key, fb) => settingsMap[key] ?? fb,
      forcedBatchFallbackRoute: null,
      sourceType: "mic",
      shouldUseLocalStreaming: false,
      uiLanguage: "en",
      storedCloudTranscriptionProvider: "groq",
      isSignedIn: false,
    });

    expect(route.provider).toBe("groq");
    expect(route.activeModel).toBe("whisper-large-v3-turbo");
  });
});
