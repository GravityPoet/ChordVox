/**
 * Settings utility functions — extracted from SettingsPage monolith.
 * Pure functions with no React dependencies.
 */

import { isChordVoxCloudProvider } from "../../utils/chordvoxCloud";
import streamingModels from "../../config/streamingModels.json";
import { getStreamingModelTranslationKey } from "../../utils/streamingModelI18n";

/** Extract the last path segment as a display-friendly model name. */
export function getModelDisplayValue(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "—";
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

/** Format a directory path for compact UI display. */
export function formatDirectoryDisplay(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
      return "%LOCALAPPDATA%\\ChordVox\\models";
    }

    if (typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)) {
      return "~/Library/Application Support/ChordVox/models";
    }

    return "~/.cache/chordvox/models";
  }

  return trimmed.replace(/^\/Users\/[^/]+/, "~");
}

/** Resolve the effective model storage root from current and legacy settings. */
export function resolveModelStorageRoot(
  modelStorageRoot: string | null | undefined,
  legacyStreamingModelsDir: string | null | undefined
): string {
  const preferredRoot = String(modelStorageRoot || "")
    .trim()
    .replace(/[\\/]+$/, "");
  if (preferredRoot) return preferredRoot;

  const legacyDir = String(legacyStreamingModelsDir || "")
    .trim()
    .replace(/[\\/]+$/, "");
  if (!legacyDir) return "";

  const derivedRoot = legacyDir.replace(/[\\/]streaming-models$/i, "");
  return derivedRoot || legacyDir;
}

/** Join a model storage root with a leaf path using the correct separator. */
export function joinModelStoragePath(rootPath: string | null | undefined, leaf: string): string {
  const trimmed = String(rootPath || "")
    .trim()
    .replace(/[\\/]+$/, "");
  if (!trimmed) return "";

  const separator =
    /^(?:[A-Za-z]:\\|\\\\)/.test(trimmed) || (trimmed.includes("\\") && !trimmed.includes("/"))
      ? "\\"
      : "/";

  return `${trimmed}${separator}${leaf}`;
}

function normalizePathForNotice(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

/** True when the picker accepted a user path but saved a safer normalized folder. */
export function shouldShowModelStorageRootNormalizedNotice(
  selectedPath: string | null | undefined,
  savedPath: string | null | undefined
): boolean {
  const selected = normalizePathForNotice(selectedPath);
  const saved = normalizePathForNotice(savedPath);
  return Boolean(selected && saved && selected !== saved);
}

/** Provider ID → human-readable label. */
export function getCloudProviderLabel(providerId: string): string {
  switch ((providerId || "").trim().toLowerCase()) {
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Google Gemini";
    case "groq":
      return "Groq";
    case "bedrock":
      return "AWS Bedrock";
    case "custom":
      return "Custom";
    case "local":
      return "Local";
    default:
      return providerId || "—";
  }
}

/** Local transcription provider ID → human-readable label. */
export function getLocalTranscriptionProviderLabel(providerId: string): string {
  switch ((providerId || "").trim().toLowerCase()) {
    case "nvidia":
      return "NVIDIA";
    case "granite":
      return "IBM Granite";
    case "paraformer":
      return "Paraformer";
    case "cohere":
      return "Cohere Transcribe";
    case "whisper":
    default:
      return "OpenAI Whisper";
  }
}

/** Resolve a selectable BYOK provider label; unfinished hosted values stay hidden. */
export function getSavedCloudProviderLabel(providerId: string, _cloudMode?: string): string {
  const normalizedProviderId = (providerId || "").trim().toLowerCase();
  if (normalizedProviderId) {
    if (isChordVoxCloudProvider(normalizedProviderId)) {
      return "—";
    }
    return getCloudProviderLabel(providerId);
  }

  return "—";
}

/** Format the secondary hotkey profile into a summary object. */
export function formatSecondaryProfileSummary(
  profile: {
    useLocalWhisper: boolean;
    useLocalStreaming?: boolean;
    localStreamingModelId?: string;
    localTranscriptionProvider: string;
    cloudTranscriptionProvider: string;
    cloudTranscriptionMode?: string;
    parakeetModel: string;
    paraformerModel: string;
    graniteModel: string;
    cohereModel: string;
    whisperModel: string;
    cloudTranscriptionModel: string;
    useReasoningModel: boolean;
    reasoningProvider: string;
    reasoningModel: string;
    cloudReasoningMode?: string;
  },
  t: (key: string, options?: Record<string, unknown>) => string
): { transcription: string; reasoning: string } {
  const streamingModelId = String(profile.localStreamingModelId || "").trim();
  const streamingModel = streamingModels.find((model) => model.id === streamingModelId);
  const streamingTranslationKey = getStreamingModelTranslationKey(streamingModelId);
  const streamingModelLabel = streamingTranslationKey
    ? t(`settingsPage.transcription.streaming.models.${streamingTranslationKey}.name`, {
        defaultValue: streamingModel?.nameEn || streamingModel?.name || streamingModelId,
      })
    : getModelDisplayValue(streamingModel?.nameEn || streamingModel?.name || streamingModelId);

  const transcriptionProvider = profile.useLocalStreaming
    ? t("settingsPage.fileTranscription.route.streamingProvider")
    : profile.useLocalWhisper
      ? getLocalTranscriptionProviderLabel(profile.localTranscriptionProvider)
      : getSavedCloudProviderLabel(
          profile.cloudTranscriptionProvider,
          profile.cloudTranscriptionMode
        );

  const transcriptionModel = profile.useLocalStreaming
    ? streamingModelLabel
    : profile.useLocalWhisper
      ? profile.localTranscriptionProvider === "nvidia"
        ? getModelDisplayValue(profile.parakeetModel)
        : profile.localTranscriptionProvider === "paraformer"
          ? getModelDisplayValue(profile.paraformerModel)
          : profile.localTranscriptionProvider === "granite"
            ? getModelDisplayValue(profile.graniteModel)
            : profile.localTranscriptionProvider === "cohere"
              ? getModelDisplayValue(profile.cohereModel)
              : getModelDisplayValue(profile.whisperModel)
      : getModelDisplayValue(profile.cloudTranscriptionModel);

  const reasoningProvider = getSavedCloudProviderLabel(
    profile.reasoningProvider,
    profile.cloudReasoningMode
  );
  const reasoningModel = getModelDisplayValue(profile.reasoningModel);

  if (!profile.useReasoningModel) {
    return {
      transcription: t("settingsPage.general.hotkey.secondary.profileSavedTranscriptionSummary", {
        provider: transcriptionProvider,
        model: transcriptionModel,
      }),
      reasoning: t("settingsPage.general.hotkey.secondary.profileSavedReasoningDisabledWithModel", {
        provider: reasoningProvider,
        model: reasoningModel,
      }),
    };
  }

  return {
    transcription: t("settingsPage.general.hotkey.secondary.profileSavedTranscriptionSummary", {
      provider: transcriptionProvider,
      model: transcriptionModel,
    }),
    reasoning: t("settingsPage.general.hotkey.secondary.profileSavedReasoningSummary", {
      provider: reasoningProvider,
      model: reasoningModel,
    }),
  };
}

/** License status → localized display label. */
export function getLicenseStatusLabel(
  status: string | undefined,
  t: (key: string) => string
): string {
  switch (status) {
    case "active":
      return t("settingsPage.account.desktopLicense.statusLabels.active");
    case "offline_grace":
      return t("settingsPage.account.desktopLicense.statusLabels.offlineGrace");
    case "expired":
      return t("settingsPage.account.desktopLicense.statusLabels.expired");
    case "invalid":
      return t("settingsPage.account.desktopLicense.statusLabels.invalid");
    default:
      return t("settingsPage.account.desktopLicense.statusLabels.notActivated");
  }
}

/** License error code → localized user-facing description. */
export function getLocalizedLicenseErrorDescription(
  error: string | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): string | null {
  switch (error) {
    case "LICENSE_SERVER_NOT_CONFIGURED":
      return t("settingsPage.account.desktopLicense.toasts.serverNotReadyDescription");
    case "LICENSE_TRIAL_SERVER_UNAVAILABLE":
      return t("settingsPage.account.desktopLicense.toasts.trialServerUnavailableDescription");
    case "TRIAL_EXPIRED":
      return t("settingsPage.account.desktopLicense.toasts.trialExpiredDescription");
    case "LICENSE_ACTIVATION_LIMIT":
      return t("settingsPage.account.desktopLicense.toasts.activationLimitDescription");
    case "LICENSE_DEVICE_NOT_ACTIVATED":
      return t("settingsPage.account.desktopLicense.toasts.deviceNotActivatedDescription");
    case "LICENSE_REVOKED":
      return t("settingsPage.account.desktopLicense.toasts.revokedDescription");
    case "LICENSE_EXPIRED":
      return t("settingsPage.account.desktopLicense.toasts.expiredDescription");
    case "LICENSE_NOT_ACTIVE":
      return t("settingsPage.account.desktopLicense.toasts.notActiveDescription");
    case "LICENSE_REQUIRED":
    case "LICENSE_KEY_MISSING":
    case "LICENSE_KEY_REQUIRED":
      return t("settingsPage.account.desktopLicense.toasts.keyRequiredDescription");
    case "LICENSE_INVALID":
      return t("settingsPage.account.desktopLicense.toasts.invalidDescription");
    default:
      return null;
  }
}

/** Modifier key set for hotkey validation. */
export const MODIFIER_PARTS = new Set([
  "control",
  "ctrl",
  "alt",
  "option",
  "shift",
  "super",
  "meta",
  "win",
  "command",
  "cmd",
  "commandorcontrol",
  "cmdorctrl",
  "fn",
]);

/** Keys to snapshot when creating a secondary hotkey profile. */
export const SECONDARY_PROFILE_VERIFY_KEYS = [
  "useLocalWhisper",
  "localTranscriptionProvider",
  "whisperModel",
  "parakeetModel",
  "paraformerModel",
  "graniteModel",
  "cohereModel",
  "graniteRuntimeUrl",
  "graniteRuntimeApiKey",
  "cohereRuntimeUrl",
  "cohereRuntimeApiKey",
  "allowOpenAIFallback",
  "allowLocalFallback",
  "fallbackWhisperModel",
  "preferredLanguage",
  "cloudTranscriptionMode",
  "cloudTranscriptionProvider",
  "cloudTranscriptionModel",
  "cloudTranscriptionBaseUrl",
  "useReasoningModel",
  "reasoningModel",
  "reasoningProvider",
  "cloudReasoningMode",
] as const;
