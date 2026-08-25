import type { TFunction } from "i18next";

const STREAMING_MODEL_KEY_MAP: Record<string, string> = {
  "zipformer-ctc-zh-large-fp16": "zipformerFastRealtime",
  "zipformer-ctc-zh-xlarge": "zipformerHighAccuracy",
  "zipformer-ctc-zh-xlarge-fp16": "zipformerHighestAccuracyFp16",
  "nemotron-streaming-en-0.6b": "nemotronEnglishRealtime",
};

export function getStreamingModelTranslationKey(modelId: string): string | null {
  return STREAMING_MODEL_KEY_MAP[String(modelId || "").trim()] || null;
}

export function getStreamingModelDisplayName(
  t: TFunction,
  modelId: string,
  fallback?: string
): string {
  const translationKey = getStreamingModelTranslationKey(modelId);
  if (!translationKey) {
    return fallback || modelId || "—";
  }

  return t(`settingsPage.transcription.streaming.models.${translationKey}.name`, {
    defaultValue: fallback || modelId || "—",
  });
}

export function getStreamingModelDescription(
  t: TFunction,
  modelId: string,
  fallback?: string
): string {
  const translationKey = getStreamingModelTranslationKey(modelId);
  if (!translationKey) {
    return fallback || "";
  }

  return t(`settingsPage.transcription.streaming.models.${translationKey}.description`, {
    defaultValue: fallback || "",
  });
}
