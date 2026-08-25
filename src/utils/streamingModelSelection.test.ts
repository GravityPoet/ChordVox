import { describe, it, expect } from "vitest";
import {
  getDefaultLocalStreamingModelIdForLocale,
  isRecommendedLocalStreamingModelForLocale,
  normalizeStreamingModelId,
  upgradeLegacyStreamingDefaultForLocale,
  syncRecommendedStreamingDefaultForLocale,
  DEFAULT_LOCAL_STREAMING_MODEL_ID,
  RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID,
  RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID,
  LEGACY_DEFAULT_LOCAL_STREAMING_MODEL_ID,
} from "./streamingModelSelection";

describe("streamingModelSelection constants", () => {
  it("keeps the expected default and recommended model IDs", () => {
    expect(DEFAULT_LOCAL_STREAMING_MODEL_ID).toBe("zipformer-ctc-zh-large-fp16");
    expect(RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID).toBe("zipformer-ctc-zh-large-fp16");
    expect(RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID).toBe("nemotron-streaming-en-0.6b");
    expect(LEGACY_DEFAULT_LOCAL_STREAMING_MODEL_ID).toBe("zipformer-ctc-zh-xlarge");
  });
});

describe("getDefaultLocalStreamingModelIdForLocale", () => {
  it("returns recommended Chinese model for Chinese locales", () => {
    expect(getDefaultLocalStreamingModelIdForLocale("zh")).toBe(
      RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID
    );
    expect(getDefaultLocalStreamingModelIdForLocale("zh-CN")).toBe(
      RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID
    );
    expect(getDefaultLocalStreamingModelIdForLocale("zh-TW")).toBe(
      RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID
    );
    expect(getDefaultLocalStreamingModelIdForLocale(" ZH-cn ")).toBe(
      RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID
    );
  });

  it("returns recommended English model for English locales", () => {
    expect(getDefaultLocalStreamingModelIdForLocale("en")).toBe(
      RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID
    );
    expect(getDefaultLocalStreamingModelIdForLocale("en-US")).toBe(
      RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID
    );
    expect(getDefaultLocalStreamingModelIdForLocale("en-GB")).toBe(
      RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID
    );
    expect(getDefaultLocalStreamingModelIdForLocale(" EN ")).toBe(
      RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID
    );
  });

  it("falls back to default model for other/unknown locales", () => {
    expect(getDefaultLocalStreamingModelIdForLocale("ja")).toBe(DEFAULT_LOCAL_STREAMING_MODEL_ID);
    expect(getDefaultLocalStreamingModelIdForLocale("fr")).toBe(DEFAULT_LOCAL_STREAMING_MODEL_ID);
    expect(getDefaultLocalStreamingModelIdForLocale("")).toBe(DEFAULT_LOCAL_STREAMING_MODEL_ID);
    expect(getDefaultLocalStreamingModelIdForLocale(null)).toBe(DEFAULT_LOCAL_STREAMING_MODEL_ID);
    expect(getDefaultLocalStreamingModelIdForLocale(undefined)).toBe(
      DEFAULT_LOCAL_STREAMING_MODEL_ID
    );
  });
});

describe("isRecommendedLocalStreamingModelForLocale", () => {
  it("correctly identifies recommended model for Chinese", () => {
    expect(
      isRecommendedLocalStreamingModelForLocale(
        RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID,
        "zh-CN"
      )
    ).toBe(true);
    expect(isRecommendedLocalStreamingModelForLocale("zipformer-ctc-zh-xlarge", "zh-CN")).toBe(
      false
    );
  });

  it("correctly identifies recommended model for English", () => {
    expect(
      isRecommendedLocalStreamingModelForLocale(RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID, "en")
    ).toBe(true);
    expect(
      isRecommendedLocalStreamingModelForLocale(RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID, "en")
    ).toBe(false);
  });

  it("correctly identifies recommended model for other languages", () => {
    expect(isRecommendedLocalStreamingModelForLocale(DEFAULT_LOCAL_STREAMING_MODEL_ID, "ja")).toBe(
      true
    );
  });
});

describe("normalizeStreamingModelId", () => {
  it("passes through valid model IDs", () => {
    expect(normalizeStreamingModelId("zipformer-ctc-zh-large-fp16")).toBe(
      "zipformer-ctc-zh-large-fp16"
    );
    expect(normalizeStreamingModelId("zipformer-ctc-zh-xlarge")).toBe("zipformer-ctc-zh-xlarge");
    expect(normalizeStreamingModelId("nemotron-streaming-en-0.6b")).toBe(
      "nemotron-streaming-en-0.6b"
    );
  });

  it("upgrades legacy model IDs", () => {
    expect(normalizeStreamingModelId("zipformer-small-ctc-zh")).toBe("zipformer-ctc-zh-large-fp16");
    expect(normalizeStreamingModelId("zipformer-ctc-zh")).toBe("zipformer-ctc-zh-large-fp16");
    expect(normalizeStreamingModelId("zipformer-ctc-zh-large")).toBe("zipformer-ctc-zh-large-fp16");
    expect(normalizeStreamingModelId("zipformer-ctc-zh-xlarge-fp16")).toBe(
      "zipformer-ctc-zh-xlarge"
    );
    expect(normalizeStreamingModelId("paraformer-bilingual-zh-en")).toBe(
      "nemotron-streaming-en-0.6b"
    );
  });

  it("falls back to default or specified fallback for invalid IDs", () => {
    expect(normalizeStreamingModelId("invalid-model-id")).toBe(DEFAULT_LOCAL_STREAMING_MODEL_ID);
    expect(normalizeStreamingModelId("invalid-model-id", "zipformer-ctc-zh-xlarge")).toBe(
      "zipformer-ctc-zh-xlarge"
    );
    // Invalid fallback falls back to default
    expect(normalizeStreamingModelId("invalid-model-id", "invalid-fallback")).toBe(
      DEFAULT_LOCAL_STREAMING_MODEL_ID
    );
    expect(normalizeStreamingModelId(null)).toBe(DEFAULT_LOCAL_STREAMING_MODEL_ID);
    expect(normalizeStreamingModelId(undefined)).toBe(DEFAULT_LOCAL_STREAMING_MODEL_ID);
  });
});

describe("upgradeLegacyStreamingDefaultForLocale", () => {
  it("upgrades legacy default to localized default if not already upgraded", () => {
    // English user had the legacy default, should be upgraded to Nemotron
    expect(
      upgradeLegacyStreamingDefaultForLocale(LEGACY_DEFAULT_LOCAL_STREAMING_MODEL_ID, "en", false)
    ).toBe(RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID);

    // Chinese user had the legacy default, should be upgraded to Chinese default (which is zipformer-ctc-zh-large-fp16)
    expect(
      upgradeLegacyStreamingDefaultForLocale(LEGACY_DEFAULT_LOCAL_STREAMING_MODEL_ID, "zh", false)
    ).toBe(RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID);
  });

  it("does not upgrade if already upgraded", () => {
    expect(
      upgradeLegacyStreamingDefaultForLocale(LEGACY_DEFAULT_LOCAL_STREAMING_MODEL_ID, "en", true)
    ).toBe(LEGACY_DEFAULT_LOCAL_STREAMING_MODEL_ID);
  });

  it("preserves non-default valid models", () => {
    expect(upgradeLegacyStreamingDefaultForLocale("zipformer-ctc-zh-large-fp16", "en", false)).toBe(
      "zipformer-ctc-zh-large-fp16"
    );
  });
});

describe("syncRecommendedStreamingDefaultForLocale", () => {
  it("syncs model ID to new localized default if not already synced", () => {
    // English user has Chinese recommended model, should sync to English recommended model
    expect(
      syncRecommendedStreamingDefaultForLocale(
        RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID,
        "en",
        false
      )
    ).toBe(RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID);

    // Chinese user has English recommended model, should sync to Chinese recommended model
    expect(
      syncRecommendedStreamingDefaultForLocale(
        RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID,
        "zh",
        false
      )
    ).toBe(RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID);
  });

  it("does not sync if already synced", () => {
    expect(
      syncRecommendedStreamingDefaultForLocale(
        RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID,
        "en",
        true
      )
    ).toBe(RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID);
  });

  it("does not sync if model ID is already correct", () => {
    expect(
      syncRecommendedStreamingDefaultForLocale(
        RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID,
        "en",
        false
      )
    ).toBe(RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID);
  });

  it("does not touch custom models that are not standard recommended ones", () => {
    expect(syncRecommendedStreamingDefaultForLocale("zipformer-ctc-zh-xlarge", "en", false)).toBe(
      "zipformer-ctc-zh-xlarge"
    );
  });
});
