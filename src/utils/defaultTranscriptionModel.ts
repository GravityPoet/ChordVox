import type { LocalTranscriptionProvider } from "../types/electron";

export const DEFAULT_PARAFORMER_MODEL_ID = "paraformer-large-zh";
export const DEFAULT_ENGLISH_PARAKEET_MODEL_ID = "parakeet-tdt-0.6b-v2";

export interface DefaultLocalTranscriptionProfile {
  provider: LocalTranscriptionProvider;
  whisperModel?: string;
  parakeetModel?: string;
  paraformerModel?: string;
}

export function getDefaultLocalTranscriptionProfile(
  uiLanguage: string | null | undefined
): DefaultLocalTranscriptionProfile {
  const normalizedLanguage = String(uiLanguage || "")
    .trim()
    .toLowerCase();

  if (normalizedLanguage.startsWith("zh")) {
    return {
      provider: "paraformer",
      paraformerModel: DEFAULT_PARAFORMER_MODEL_ID,
    };
  }

  if (normalizedLanguage === "en" || normalizedLanguage.startsWith("en-")) {
    return {
      provider: "nvidia",
      parakeetModel: DEFAULT_ENGLISH_PARAKEET_MODEL_ID,
    };
  }

  return { provider: "whisper" };
}
