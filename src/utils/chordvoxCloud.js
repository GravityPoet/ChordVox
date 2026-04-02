export const CHORDVOX_CLOUD_MODE = "chordvox_cloud";
export const CHORDVOX_CLOUD_PROVIDER = "chordvox_cloud";
export const CHORDVOX_CLOUD_MODEL = "chordvox-cloud";
export const CHORDVOX_CLOUD_SOURCE = "chordvox_cloud";
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

export function normalizeChordVoxCloudMode(value, fallback = CHORDVOX_CLOUD_MODE) {
  const normalized = normalizeLower(value);
  if (!normalized) return fallback;
  if (isChordVoxCloudValue(normalized)) return CHORDVOX_CLOUD_MODE;
  return normalized;
}

export function isChordVoxCloudMode(value) {
  return normalizeChordVoxCloudMode(value, "") === CHORDVOX_CLOUD_MODE;
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

export function normalizeChordVoxSource(value, fallback = "") {
  const normalized = normalizeLower(value);
  if (!normalized) return fallback;
  if (isChordVoxCloudValue(normalized)) return CHORDVOX_CLOUD_SOURCE;
  return normalized;
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
