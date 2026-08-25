import { describe, it, expect } from "vitest";
import { normalizeWhisperModelId, DEFAULT_WHISPER_MODEL_ID } from "./whisperModelSelection";

describe("DEFAULT_WHISPER_MODEL_ID", () => {
  it("locks default whisper model ID to turbo", () => {
    expect(DEFAULT_WHISPER_MODEL_ID).toBe("turbo");
  });
});

describe("normalizeWhisperModelId", () => {
  it("preserves valid model IDs registered in model registry", () => {
    expect(normalizeWhisperModelId("large")).toBe("large");
    expect(normalizeWhisperModelId("turbo")).toBe("turbo");
    expect(normalizeWhisperModelId("belle-whisper-large-v3-zh-punct-full")).toBe(
      "belle-whisper-large-v3-zh-punct-full"
    );
  });

  it("identifies and preserves custom model file paths", () => {
    // Ends with .bin
    expect(normalizeWhisperModelId("custom-model.bin")).toBe("custom-model.bin");
    // Contains forward slash
    expect(normalizeWhisperModelId("/Users/user/models/custom")).toBe("/Users/user/models/custom");
    // Contains backward slash
    expect(normalizeWhisperModelId("C:\\models\\custom")).toBe("C:\\models\\custom");
  });

  it("redirects removed whisper models to the default model", () => {
    expect(normalizeWhisperModelId("tiny")).toBe(DEFAULT_WHISPER_MODEL_ID);
    expect(normalizeWhisperModelId("base")).toBe(DEFAULT_WHISPER_MODEL_ID);
    expect(normalizeWhisperModelId("small")).toBe(DEFAULT_WHISPER_MODEL_ID);
    expect(normalizeWhisperModelId("medium")).toBe(DEFAULT_WHISPER_MODEL_ID);
  });

  it("falls back to default for invalid or empty IDs", () => {
    expect(normalizeWhisperModelId("invalid-model")).toBe(DEFAULT_WHISPER_MODEL_ID);
    expect(normalizeWhisperModelId("")).toBe(DEFAULT_WHISPER_MODEL_ID);
    expect(normalizeWhisperModelId(null)).toBe(DEFAULT_WHISPER_MODEL_ID);
    expect(normalizeWhisperModelId(undefined)).toBe(DEFAULT_WHISPER_MODEL_ID);
  });
});
