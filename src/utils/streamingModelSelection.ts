import streamingModels from "../config/streamingModels.json";

const LEGACY_STREAMING_MODEL_IDS: Record<string, string> = {
  "zipformer-small-ctc-zh": "zipformer-ctc-zh-large-fp16",
  "zipformer-ctc-zh": "zipformer-ctc-zh-large-fp16",
  "zipformer-ctc-zh-large": "zipformer-ctc-zh-large-fp16",
  "zipformer-ctc-zh-xlarge-fp16": "zipformer-ctc-zh-xlarge",
  "paraformer-bilingual-zh-en": "nemotron-streaming-en-0.6b",
};

export const LEGACY_DEFAULT_LOCAL_STREAMING_MODEL_ID = "zipformer-ctc-zh-xlarge";
export const RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID = "zipformer-ctc-zh-large-fp16";
export const RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID = "nemotron-streaming-en-0.6b";
export const LEGACY_STREAMING_DEFAULT_UPGRADE_STORAGE_KEY =
  "localStreamingDefaultUpgradeToRecommendedV2";
export const LOCALE_STREAMING_DEFAULT_SYNC_STORAGE_KEY = "localStreamingDefaultSyncedToLocaleV1";

const STREAMING_MODEL_IDS = new Set(streamingModels.map((model) => model.id));

export const DEFAULT_LOCAL_STREAMING_MODEL_ID =
  streamingModels.find((model) => model.default)?.id || streamingModels[0]?.id || "";

function resolveFallbackStreamingModelId(modelId: string | null | undefined): string {
  const fallback = String(modelId || "").trim();
  return STREAMING_MODEL_IDS.has(fallback) ? fallback : DEFAULT_LOCAL_STREAMING_MODEL_ID;
}

export function getDefaultLocalStreamingModelIdForLocale(
  uiLanguage: string | null | undefined
): string {
  const normalizedLanguage = String(uiLanguage || "")
    .trim()
    .toLowerCase();

  if (normalizedLanguage.startsWith("zh")) {
    return resolveFallbackStreamingModelId(RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID);
  }

  if (normalizedLanguage === "en" || normalizedLanguage.startsWith("en-")) {
    return resolveFallbackStreamingModelId(RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID);
  }

  return DEFAULT_LOCAL_STREAMING_MODEL_ID;
}

export function isRecommendedLocalStreamingModelForLocale(
  modelId: string | null | undefined,
  uiLanguage: string | null | undefined
): boolean {
  return (
    normalizeStreamingModelId(modelId) === getDefaultLocalStreamingModelIdForLocale(uiLanguage)
  );
}

export function normalizeStreamingModelId(
  modelId: string | null | undefined,
  fallbackModelId: string | null | undefined = DEFAULT_LOCAL_STREAMING_MODEL_ID
): string {
  const fallback = resolveFallbackStreamingModelId(fallbackModelId);
  const raw = String(modelId || "").trim();
  const mapped = raw ? LEGACY_STREAMING_MODEL_IDS[raw] || raw : fallback;

  if (STREAMING_MODEL_IDS.has(mapped)) {
    return mapped;
  }

  return fallback;
}

export function upgradeLegacyStreamingDefaultForLocale(
  modelId: string | null | undefined,
  uiLanguage: string | null | undefined,
  hasAlreadyUpgraded = false
): string {
  const localizedDefaultModelId = getDefaultLocalStreamingModelIdForLocale(uiLanguage);
  const normalizedModelId = normalizeStreamingModelId(modelId, localizedDefaultModelId);

  if (
    !hasAlreadyUpgraded &&
    localizedDefaultModelId !== LEGACY_DEFAULT_LOCAL_STREAMING_MODEL_ID &&
    normalizedModelId === LEGACY_DEFAULT_LOCAL_STREAMING_MODEL_ID
  ) {
    return localizedDefaultModelId;
  }

  return normalizedModelId;
}

export function syncRecommendedStreamingDefaultForLocale(
  modelId: string | null | undefined,
  uiLanguage: string | null | undefined,
  hasAlreadySynced = false
): string {
  const localizedDefaultModelId = getDefaultLocalStreamingModelIdForLocale(uiLanguage);
  const normalizedModelId = normalizeStreamingModelId(modelId, localizedDefaultModelId);

  if (hasAlreadySynced || normalizedModelId === localizedDefaultModelId) {
    return normalizedModelId;
  }

  if (
    normalizedModelId === RECOMMENDED_CHINESE_LOCAL_STREAMING_MODEL_ID ||
    normalizedModelId === RECOMMENDED_ENGLISH_LOCAL_STREAMING_MODEL_ID
  ) {
    return localizedDefaultModelId;
  }

  return normalizedModelId;
}
