import { DEFAULT_WHISPER_MODEL_ID, normalizeWhisperModelId } from "../utils/whisperModelSelection";
import {
  DEFAULT_ENGLISH_PARAKEET_MODEL_ID,
  DEFAULT_PARAFORMER_MODEL_ID,
  getDefaultLocalTranscriptionProfile,
} from "../utils/defaultTranscriptionModel";
import {
  getConfiguredTranscriptionByokProvider,
  isChordVoxCloudMode,
  isChordVoxCloudProvider,
  isHostedCloudModeEnabled,
  normalizeAvailableCloudMode,
  normalizeAvailableCloudProvider,
} from "../utils/chordvoxCloud";

/**
 * Pure function to determine transcription routing provider and model.
 * Handles secondary profiles, stubs, and BYOK/Cloud/Local selection matrix.
 */
export function determineTranscriptionRoute({
  getSettingValue,
  forcedBatchFallbackRoute,
  sourceType,
  shouldUseLocalStreaming,
  uiLanguage,
  storedCloudTranscriptionProvider,
  isSignedIn,
}) {
  const getBooleanSetting = (key, fallback = false) => {
    const value = getSettingValue(key, fallback ? "true" : "false");
    if (typeof value === "boolean") return value;
    return value === "true";
  };

  const getStringSetting = (key, fallback = "") => {
    const value = getSettingValue(key, fallback);
    return typeof value === "string" ? value : String(value);
  };

  let useLocalWhisper = forcedBatchFallbackRoute
    ? true
    : getBooleanSetting("useLocalWhisper", true);

  const useStreamingRouteForFile = sourceType === "file" && shouldUseLocalStreaming;

  const defaultLocalProfile = getDefaultLocalTranscriptionProfile(uiLanguage || "en");

  const rawLocalProvider =
    forcedBatchFallbackRoute?.provider ||
    getStringSetting("localTranscriptionProvider", defaultLocalProfile.provider);

  const localProvider = ["nvidia", "paraformer", "granite", "cohere"].includes(rawLocalProvider)
    ? rawLocalProvider
    : "whisper";

  const whisperModel =
    forcedBatchFallbackRoute?.provider === "whisper" && forcedBatchFallbackRoute.model
      ? normalizeWhisperModelId(forcedBatchFallbackRoute.model)
      : getStringSetting("whisperModel", "turbo");

  const parakeetModel = getStringSetting(
    "parakeetModel",
    defaultLocalProfile.parakeetModel || DEFAULT_ENGLISH_PARAKEET_MODEL_ID
  );

  const paraformerModel =
    forcedBatchFallbackRoute?.provider === "paraformer" && forcedBatchFallbackRoute.model
      ? forcedBatchFallbackRoute.model
      : getStringSetting(
          "paraformerModel",
          defaultLocalProfile.paraformerModel || DEFAULT_PARAFORMER_MODEL_ID
        );

  const graniteModel = getStringSetting("graniteModel", "granite-4.0-1b-speech");
  const cohereModel = getStringSetting("cohereModel", "cohere-transcribe-03-2026");

  const rawCloudTranscriptionMode = getStringSetting("cloudTranscriptionMode", "byok");
  const cloudTranscriptionMode = normalizeAvailableCloudMode(rawCloudTranscriptionMode, "byok");

  const rawByokProvider = getStringSetting("cloudTranscriptionProvider", "openai");
  const configuredByokProvider = getConfiguredTranscriptionByokProvider({
    getItem: (key) => getStringSetting(key, "") || null,
  });
  const byokProvider = normalizeAvailableCloudProvider(
    rawByokProvider,
    configuredByokProvider || "openai"
  );

  const hasExplicitByokProvider =
    typeof storedCloudTranscriptionProvider === "string" &&
    storedCloudTranscriptionProvider.trim().length > 0 &&
    !isChordVoxCloudProvider(storedCloudTranscriptionProvider);

  const requestedUnavailableHostedRoute =
    isChordVoxCloudMode(rawCloudTranscriptionMode) ||
    isChordVoxCloudProvider(rawByokProvider) ||
    isChordVoxCloudProvider(storedCloudTranscriptionProvider);

  if (!forcedBatchFallbackRoute && requestedUnavailableHostedRoute && !configuredByokProvider) {
    useLocalWhisper = true;
  }

  const isChordVoxCloudTranscriptionMode =
    !useLocalWhisper &&
    !useStreamingRouteForFile &&
    isHostedCloudModeEnabled(cloudTranscriptionMode) &&
    !hasExplicitByokProvider;

  const useCloud = isChordVoxCloudTranscriptionMode && isSignedIn;

  let activeModel;
  let provider;

  if (useStreamingRouteForFile) {
    provider = "local-streaming";
    activeModel = null;
  } else if (useLocalWhisper) {
    provider = localProvider;
    if (localProvider === "nvidia") {
      activeModel = parakeetModel;
    } else if (localProvider === "paraformer") {
      activeModel = paraformerModel;
    } else if (localProvider === "granite") {
      activeModel = graniteModel;
    } else if (localProvider === "cohere") {
      activeModel = cohereModel;
    } else {
      activeModel = whisperModel;
    }
  } else {
    provider = byokProvider;
    const cloudTranscriptionModel = getStringSetting("cloudTranscriptionModel", "");
    const trimmedModel = cloudTranscriptionModel.trim();
    if (trimmedModel) {
      activeModel = trimmedModel;
    } else {
      if (byokProvider === "groq") activeModel = "whisper-large-v3-turbo";
      else if (byokProvider === "soniox") activeModel = "stt-rt-v4";
      else if (byokProvider === "deepgram") activeModel = "nova-3";
      else if (byokProvider === "google-cloud") activeModel = "chirp_3";
      else if (byokProvider === "doubao") activeModel = "doubao-streaming-auto";
      else if (byokProvider === "custom") activeModel = "whisper-1";
      else activeModel = "gpt-4o-mini-transcribe";
    }
  }

  return {
    provider,
    activeModel,
    useLocalWhisper,
    useStreamingRouteForFile,
    isChordVoxCloudTranscriptionMode,
    useCloud,
    localProvider,
    whisperModel,
    parakeetModel,
    paraformerModel,
    graniteModel,
    cohereModel,
    byokProvider,
    cloudTranscriptionMode,
    isSignedIn,
    hasExplicitByokProvider,
  };
}
