export const CHORDVOX_CLOUD_MODE = "chordvox_cloud";
export const CHORDVOX_CLOUD_PROVIDER = "chordvox_cloud";
export const CHORDVOX_CLOUD_MODEL = "chordvox-cloud";
export const CHORDVOX_CLOUD_SOURCE = "chordvox_cloud";
// ChordVox does not currently operate a hosted transcription/reasoning service.
// Keep the legacy identifiers for settings/history compatibility, but never expose
// or route to them until a real service is deliberately shipped.
export const HOSTED_CLOUD_FEATURES_ENABLED = false;
export const CHORDVOX_MODELS_CLEARED_EVENT = "chordvox-models-cleared";
export const CHORDVOX_LAST_SIGN_IN_STORAGE_KEY = "chordvox:lastSignInTime";

// Preserve pre-rebrand storage values so existing installs migrate cleanly.
const LEGACY_BRAND_BASE = ["open", "whispr"].join("");

export const LEGACY_CLOUD_MODE = LEGACY_BRAND_BASE;
export const LEGACY_CLOUD_PROVIDER = LEGACY_BRAND_BASE;
export const LEGACY_CLOUD_MODEL = `${LEGACY_BRAND_BASE}-cloud`;
export const LEGACY_CLOUD_SOURCE = LEGACY_BRAND_BASE;
export const LEGACY_CLOUD_MODELS_CLEARED_EVENT = `${LEGACY_BRAND_BASE}-models-cleared`;
export const LEGACY_CLOUD_LAST_SIGN_IN_STORAGE_KEY = `${LEGACY_BRAND_BASE}:lastSignInTime`;

const CHORDVOX_CLOUD_ALIASES = new Set([
  CHORDVOX_CLOUD_MODE,
  CHORDVOX_CLOUD_PROVIDER,
  CHORDVOX_CLOUD_MODEL,
  CHORDVOX_CLOUD_SOURCE,
  LEGACY_CLOUD_MODE,
  LEGACY_CLOUD_PROVIDER,
  LEGACY_CLOUD_MODEL,
  LEGACY_CLOUD_SOURCE,
  "chordvox",
  "chordvox-cloud",
]);

function normalizeLower(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function isChordVoxCloudValue(value) {
  const normalized = normalizeLower(value);
  return normalized ? CHORDVOX_CLOUD_ALIASES.has(normalized) : false;
}

export function normalizeChordVoxCloudMode(value, fallback = "byok") {
  const normalized = normalizeLower(value);
  if (!normalized) return fallback;
  if (isChordVoxCloudValue(normalized)) return CHORDVOX_CLOUD_MODE;
  return normalized;
}

export function isChordVoxCloudMode(value) {
  return normalizeChordVoxCloudMode(value, "") === CHORDVOX_CLOUD_MODE;
}

export function normalizeAvailableCloudMode(value, fallback = "byok") {
  const normalized = normalizeChordVoxCloudMode(value, fallback);
  if (!HOSTED_CLOUD_FEATURES_ENABLED && isChordVoxCloudMode(normalized)) {
    return fallback;
  }
  return normalized;
}

export function isHostedCloudModeEnabled(value) {
  return HOSTED_CLOUD_FEATURES_ENABLED && isChordVoxCloudMode(value);
}

export function normalizeChordVoxProvider(value, fallback = "") {
  const normalized = normalizeLower(value);
  if (!normalized) return fallback;
  if (isChordVoxCloudValue(normalized)) return CHORDVOX_CLOUD_PROVIDER;
  return normalized;
}

export function isChordVoxCloudProvider(value) {
  return normalizeChordVoxProvider(value, "") === CHORDVOX_CLOUD_PROVIDER;
}

export function normalizeAvailableCloudProvider(value, fallback = "openai") {
  const normalized = normalizeChordVoxProvider(value, fallback);
  if (!HOSTED_CLOUD_FEATURES_ENABLED && isChordVoxCloudProvider(normalized)) {
    return fallback;
  }
  return normalized;
}

export function normalizeChordVoxSource(value, fallback = "") {
  const normalized = normalizeLower(value);
  if (!normalized) return fallback;
  if (isChordVoxCloudValue(normalized)) return CHORDVOX_CLOUD_SOURCE;
  return normalized;
}

const TRANSCRIPTION_BYOK_PROVIDERS = [
  ["openai", ["openaiApiKey"]],
  ["groq", ["groqApiKey"]],
  ["soniox", ["sonioxApiKey"]],
  ["deepgram", ["deepgramApiKey"]],
  ["google-cloud", ["googleSttApiKey"]],
  ["doubao", ["doubaoAppId", "doubaoAccessToken"]],
  ["custom", ["customTranscriptionApiKey"]],
];

const REASONING_BYOK_PROVIDERS = [
  ["openai", ["openaiApiKey"]],
  ["openrouter", ["openrouterApiKey"]],
  ["anthropic", ["anthropicApiKey"]],
  ["gemini", ["geminiApiKey"]],
  ["groq", ["groqApiKey"]],
  ["cerebras", ["cerebrasApiKey"]],
  ["custom", ["customReasoningApiKey"]],
];

const TRANSCRIPTION_DEFAULT_MODELS = {
  openai: "gpt-4o-mini-transcribe",
  groq: "whisper-large-v3-turbo",
  soniox: "stt-rt-v4",
  deepgram: "nova-3",
  "google-cloud": "chirp_3",
  doubao: "doubao-streaming-auto",
  custom: "whisper-1",
};

function hasStoredValues(storage, keys) {
  return keys.every((key) => String(storage?.getItem?.(key) || "").trim().length > 0);
}

function findConfiguredProvider(storage, providers) {
  for (const [provider, keys] of providers) {
    if (hasStoredValues(storage, keys)) return provider;
  }
  return "";
}

export function getConfiguredTranscriptionByokProvider(storage) {
  return findConfiguredProvider(storage, TRANSCRIPTION_BYOK_PROVIDERS);
}

export function getConfiguredReasoningByokProvider(storage) {
  return findConfiguredProvider(storage, REASONING_BYOK_PROVIDERS);
}

function setStorageValue(storage, key, value, changedKeys) {
  if (storage.getItem(key) === value) return;
  storage.setItem(key, value);
  changedKeys.push(key);
}

/**
 * One-way safety migration for installs that previously selected the unfinished
 * hosted service. Existing BYOK/local choices are preserved.
 */
export function migrateUnavailableHostedCloudSettings(storage) {
  if (HOSTED_CLOUD_FEATURES_ENABLED || !storage?.getItem || !storage?.setItem) return [];

  const changedKeys = [];
  const transcriptionMode = storage.getItem("cloudTranscriptionMode");
  const transcriptionProvider = storage.getItem("cloudTranscriptionProvider");
  const transcriptionModel = storage.getItem("cloudTranscriptionModel");
  const hadHostedTranscription =
    isChordVoxCloudMode(transcriptionMode) ||
    isChordVoxCloudProvider(transcriptionProvider) ||
    isChordVoxCloudValue(transcriptionModel);

  if (hadHostedTranscription) {
    const byokProvider = getConfiguredTranscriptionByokProvider(storage);
    const safeProvider = byokProvider || "openai";
    setStorageValue(storage, "cloudTranscriptionMode", "byok", changedKeys);
    setStorageValue(storage, "cloudTranscriptionProvider", safeProvider, changedKeys);
    if (isChordVoxCloudValue(transcriptionModel) || !String(transcriptionModel || "").trim()) {
      setStorageValue(
        storage,
        "cloudTranscriptionModel",
        TRANSCRIPTION_DEFAULT_MODELS[safeProvider] || TRANSCRIPTION_DEFAULT_MODELS.openai,
        changedKeys
      );
    }
    if (!byokProvider) {
      setStorageValue(storage, "useLocalWhisper", "true", changedKeys);
    }
  }

  const reasoningMode = storage.getItem("cloudReasoningMode");
  const reasoningProvider = storage.getItem("reasoningProvider");
  const reasoningModel = storage.getItem("reasoningModel");
  const hadHostedReasoning =
    isChordVoxCloudMode(reasoningMode) ||
    isChordVoxCloudProvider(reasoningProvider) ||
    isChordVoxCloudValue(reasoningModel);

  if (hadHostedReasoning) {
    const hasConfiguredLocalReasoning = Boolean(
      normalizeLower(reasoningProvider) === "local" && String(reasoningModel || "").trim()
    );
    const byokProvider = getConfiguredReasoningByokProvider(storage);
    const safeProvider = hasConfiguredLocalReasoning ? "local" : byokProvider || "openai";
    setStorageValue(storage, "cloudReasoningMode", "byok", changedKeys);
    setStorageValue(storage, "reasoningProvider", safeProvider, changedKeys);
    if (isChordVoxCloudValue(reasoningModel)) {
      setStorageValue(storage, "reasoningModel", "", changedKeys);
    }
    if (!hasConfiguredLocalReasoning && !byokProvider) {
      setStorageValue(storage, "useReasoningModel", "false", changedKeys);
    }
  }

  if (storage.getItem("cloudBackupEnabled") === "true") {
    setStorageValue(storage, "cloudBackupEnabled", "false", changedKeys);
  }
  if (storage.getItem("pendingCloudMigration") !== null) {
    storage.removeItem("pendingCloudMigration");
    changedKeys.push("pendingCloudMigration");
  }

  return changedKeys;
}

export function getStorageValueWithFallback(storage, keys) {
  if (!storage || !Array.isArray(keys)) return null;

  for (const key of keys) {
    const value = storage.getItem(key);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

export function addChordVoxModelsClearedListener(target, handler) {
  if (!target?.addEventListener || typeof handler !== "function") {
    return () => {};
  }

  target.addEventListener(CHORDVOX_MODELS_CLEARED_EVENT, handler);
  target.addEventListener(LEGACY_CLOUD_MODELS_CLEARED_EVENT, handler);

  return () => {
    target.removeEventListener(CHORDVOX_MODELS_CLEARED_EVENT, handler);
    target.removeEventListener(LEGACY_CLOUD_MODELS_CLEARED_EVENT, handler);
  };
}

export function dispatchChordVoxModelsCleared(target) {
  if (!target?.dispatchEvent || typeof Event === "undefined") {
    return;
  }

  target.dispatchEvent(new Event(CHORDVOX_MODELS_CLEARED_EVENT));
  target.dispatchEvent(new Event(LEGACY_CLOUD_MODELS_CLEARED_EVENT));
}
