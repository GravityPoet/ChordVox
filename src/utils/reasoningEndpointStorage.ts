import { normalizeBaseUrl } from "../config/constants";
import {
  CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL,
  normalizeCustomReasoningProtocol,
} from "./customReasoningProtocol";
import { isSecureEndpoint } from "./urlUtils";

type StorageLike = Pick<Storage, "getItem">;

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function getStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  if (typeof window === "undefined" || !window.localStorage) return null;
  return window.localStorage;
}

export function getProviderEndpointOverrideFromStorage(
  providerId: string,
  storage?: StorageLike | null
): string | null {
  const targetStorage = getStorage(storage);
  if (!targetStorage) return null;

  try {
    const raw = targetStorage.getItem("providerEndpoints");
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const value = parsed?.[providerId];
    if (typeof value !== "string" || !value.trim()) return null;

    const normalized = normalizeBaseUrl(value.trim());
    if (!normalized) return null;

    return isSecureEndpoint(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function getSecureBaseUrlFromStorage(targetStorage: StorageLike, key: string): string | null {
  const raw = targetStorage.getItem(key);
  if (!raw) return null;

  const normalized = normalizeBaseUrl(raw.trim());
  if (!normalized) return null;

  return isSecureEndpoint(normalized) ? normalized : null;
}

export function getContextBaseUrlFromStorage(
  provider: string,
  storage?: StorageLike | null
): string | null {
  const targetStorage = getStorage(storage);
  const normalizedProvider = String(provider || "")
    .trim()
    .toLowerCase();

  const override = getProviderEndpointOverrideFromStorage(normalizedProvider, targetStorage);
  if (override) return override;

  if (!targetStorage) return null;

  if (normalizedProvider === "openrouter") {
    return DEFAULT_OPENROUTER_BASE_URL;
  }
  if (normalizedProvider === "gemini") {
    return getSecureBaseUrlFromStorage(targetStorage, "geminiBaseUrl");
  }
  if (normalizedProvider === "custom") {
    return getSecureBaseUrlFromStorage(targetStorage, "cloudReasoningBaseUrl");
  }
  if (normalizedProvider === "openai") {
    return getSecureBaseUrlFromStorage(targetStorage, "openaiBaseUrl");
  }

  return null;
}

export function getContextVisionProviderFromStorage(
  provider: string,
  storage?: StorageLike | null
): string {
  const normalizedProvider = String(provider || "")
    .trim()
    .toLowerCase();
  if (normalizedProvider !== "custom") {
    return normalizedProvider;
  }

  const targetStorage = getStorage(storage);
  const protocol = normalizeCustomReasoningProtocol(
    targetStorage?.getItem("customReasoningProtocol")
  );

  return protocol === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL ? "gemini" : "custom";
}
