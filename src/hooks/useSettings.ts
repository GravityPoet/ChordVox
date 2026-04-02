import React, { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { useDebouncedCallback } from "./useDebouncedCallback";
import { API_ENDPOINTS } from "../config/constants";
import logger from "../utils/logger";
import { ensureAgentNameInDictionary } from "../utils/agentName";
import i18n, { normalizeUiLanguage } from "../i18n";
import { hasStoredByokKey } from "../utils/byokDetection";
import {
  CHORDVOX_CLOUD_PROVIDER,
  CHORDVOX_CLOUD_MODE,
  normalizeChordVoxCloudMode,
  normalizeChordVoxProvider,
} from "../utils/chordvoxCloud";
import type { LocalTranscriptionProvider } from "../types/electron";

let _ReasoningService: typeof import("../services/ReasoningService").default | null = null;
function getReasoningService() {
  if (!_ReasoningService) {
    _ReasoningService = require("../services/ReasoningService").default;
  }
  return _ReasoningService!;
}

export interface TranscriptionSettings {
  uiLanguage: string;
  modelStorageRoot?: string;
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  senseVoiceModelPath: string;
  senseVoiceBinaryPath: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl?: string;
  cloudTranscriptionMode: string;
  customDictionary: string[];
  assemblyAiStreaming: boolean;
}

export interface ReasoningSettings {
  useReasoningModel: boolean;
  reasoningModel: string;
  reasoningProvider: string;
  cloudReasoningBaseUrl?: string;
  customReasoningProtocol?: "auto" | "chat" | "responses";
  cloudReasoningMode: string;
}

export interface HotkeySettings {
  dictationKey: string;
  activationMode: "tap" | "push";
}

export interface SecondaryHotkeyProfile {
  useLocalWhisper: boolean;
  localTranscriptionProvider: LocalTranscriptionProvider;
  whisperModel: string;
  parakeetModel: string;
  senseVoiceModelPath: string;
  senseVoiceBinaryPath: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;
  cloudTranscriptionMode: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl: string;
  useReasoningModel: boolean;
  reasoningModel: string;
  reasoningProvider: string;
  customReasoningProtocol?: "auto" | "chat" | "responses";
  cloudReasoningMode: string;
}

export interface MicrophoneSettings {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
}

export interface ApiKeySettings {
  openaiApiKey: string;
  openrouterApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  doubaoAppId: string;
  doubaoAccessToken: string;
  customTranscriptionApiKey: string;
  customReasoningApiKey: string;
}

export interface PrivacySettings {
  cloudBackupEnabled: boolean;
  telemetryEnabled: boolean;
  transcriptionHistoryEnabled: boolean;
}

export interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

export type DictationCueStyle = "off" | "electronic" | "droplet1" | "droplet2";
export type RecordingAnimationStyle = "line" | "particles" | "level";

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };
const DEFAULT_CLOUD_REASONING_MODE = "byok";
let _migrated = false;
function migratePreferredLanguage() {
  if (_migrated) return;
  _migrated = true;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

function useSettingsInternal() {
  migratePreferredLanguage();

  const [useLocalWhisper, setUseLocalWhisper] = useLocalStorage("useLocalWhisper", true, {
    serialize: String,
    deserialize: (value) => value !== "false",
  });

  const [whisperModel, setWhisperModel] = useLocalStorage("whisperModel", "turbo", {
    serialize: String,
    deserialize: String,
  });

  const [localTranscriptionProvider, setLocalTranscriptionProvider] =
    useLocalStorage<LocalTranscriptionProvider>("localTranscriptionProvider", "whisper", {
      serialize: String,
      deserialize: (value) => {
        if (value === "nvidia") return "nvidia";
        if (value === "sensevoice") return "sensevoice";
        return "whisper";
      },
    });

  const [parakeetModel, setParakeetModel] = useLocalStorage("parakeetModel", "", {
    serialize: String,
    deserialize: String,
  });

  const [senseVoiceModelPath, setSenseVoiceModelPath] = useLocalStorage(
    "senseVoiceModelPath",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [senseVoiceBinaryPath, setSenseVoiceBinaryPath] = useLocalStorage(
    "senseVoiceBinaryPath",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [allowOpenAIFallback, setAllowOpenAIFallback] = useLocalStorage(
    "allowOpenAIFallback",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  const [allowLocalFallback, setAllowLocalFallback] = useLocalStorage("allowLocalFallback", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [fallbackWhisperModel, setFallbackWhisperModel] = useLocalStorage(
    "fallbackWhisperModel",
    "turbo",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [preferredLanguage, setPreferredLanguage] = useLocalStorage("preferredLanguage", "auto", {
    serialize: String,
    deserialize: String,
  });

  const [uiLanguage, setUiLanguageLocal] = useLocalStorage("uiLanguage", "en", {
    serialize: String,
    deserialize: (value) => normalizeUiLanguage(value),
  });
  const [modelStorageRoot, setModelStorageRootLocal] = useLocalStorage("modelStorageRoot", "", {
    serialize: String,
    deserialize: String,
  });

  const setUiLanguage = useCallback(
    (language: string) => {
      setUiLanguageLocal(normalizeUiLanguage(language));
    },
    [setUiLanguageLocal]
  );
  const setModelStorageRoot = useCallback(
    (rootPath: string) => {
      setModelStorageRootLocal(String(rootPath || "").trim());
    },
    [setModelStorageRootLocal]
  );

  const hasRunUiLanguageSync = useRef(false);
  const uiLanguageSyncReady = useRef(false);

  useEffect(() => {
    if (hasRunUiLanguageSync.current) return;
    hasRunUiLanguageSync.current = true;

    const sync = async () => {
      let resolved = normalizeUiLanguage(uiLanguage);

      if (typeof window !== "undefined" && window.electronAPI?.getUiLanguage) {
        const envLanguage = await window.electronAPI.getUiLanguage();
        resolved = normalizeUiLanguage(envLanguage || resolved);
      }

      if (resolved !== uiLanguage) {
        setUiLanguageLocal(resolved);
      }

      await i18n.changeLanguage(resolved);
      uiLanguageSyncReady.current = true;
    };

    sync().catch((err) => {
      logger.warn(
        "Failed to sync UI language on startup",
        { error: (err as Error).message },
        "settings"
      );
      uiLanguageSyncReady.current = true;
      void i18n.changeLanguage(normalizeUiLanguage(uiLanguage));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!uiLanguageSyncReady.current) return;

    const normalized = normalizeUiLanguage(uiLanguage);
    void i18n.changeLanguage(normalized);

    if (typeof window !== "undefined" && window.electronAPI?.setUiLanguage) {
      window.electronAPI.setUiLanguage(normalized).catch((err) => {
        logger.warn(
          "Failed to sync UI language to main process",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  }, [uiLanguage]);

  const hasRunModelStorageRootSync = useRef(false);
  const modelStorageRootSyncReady = useRef(false);

  useEffect(() => {
    if (hasRunModelStorageRootSync.current) return;
    hasRunModelStorageRootSync.current = true;

    const sync = async () => {
      if (typeof window === "undefined" || !window.electronAPI?.getModelStorageRoot) {
        modelStorageRootSyncReady.current = true;
        return;
      }

      const envRoot = String((await window.electronAPI.getModelStorageRoot()) || "").trim();
      if (envRoot && envRoot !== modelStorageRoot) {
        setModelStorageRootLocal(envRoot);
      }

      modelStorageRootSyncReady.current = true;
    };

    sync().catch((err) => {
      logger.warn(
        "Failed to sync model storage root on startup",
        { error: (err as Error).message },
        "settings"
      );
      modelStorageRootSyncReady.current = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!modelStorageRootSyncReady.current) return;
    if (typeof window === "undefined" || !window.electronAPI?.saveModelStorageRoot) return;

    window.electronAPI.saveModelStorageRoot(modelStorageRoot).catch((err) => {
      logger.warn(
        "Failed to save model storage root",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, [modelStorageRoot]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "uiLanguage" || event.newValue == null) {
        return;
      }

      const normalized = normalizeUiLanguage(event.newValue);
      setUiLanguageLocal(normalized);
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [setUiLanguageLocal]);

  const [cloudTranscriptionProvider, setCloudTranscriptionProvider] = useLocalStorage(
    "cloudTranscriptionProvider",
    "openai",
    {
      serialize: String,
      deserialize: (value) => (value === "mistral" ? "doubao" : String(value)),
    }
  );

  const [cloudTranscriptionModel, setCloudTranscriptionModel] = useLocalStorage(
    "cloudTranscriptionModel",
    "gpt-4o-mini-transcribe",
    {
      serialize: String,
      deserialize: (value) =>
        value === "voxtral-mini-latest"
          ? "doubao-seedasr-streaming-2.0"
          : String(value),
    }
  );

  const [cloudTranscriptionBaseUrl, setCloudTranscriptionBaseUrl] = useLocalStorage(
    "cloudTranscriptionBaseUrl",
    API_ENDPOINTS.TRANSCRIPTION_BASE,
    {
      serialize: String,
      deserialize: String,
    }
  );

  useEffect(() => {
    if (cloudTranscriptionProvider !== "doubao") return;
    if (cloudTranscriptionBaseUrl !== "https://api.mistral.ai/v1") return;
    setCloudTranscriptionBaseUrl(API_ENDPOINTS.DOUBAO_ASR_WS);
  }, [cloudTranscriptionProvider, cloudTranscriptionBaseUrl, setCloudTranscriptionBaseUrl]);

  const [cloudReasoningBaseUrl, setCloudReasoningBaseUrl] = useLocalStorage(
    "cloudReasoningBaseUrl",
    API_ENDPOINTS.OPENAI_BASE,
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [customReasoningProtocol, setCustomReasoningProtocol] = useLocalStorage<
    "auto" | "chat" | "responses"
  >("customReasoningProtocol", "auto", {
    serialize: String,
    deserialize: (value) =>
      value === "chat" || value === "responses" ? value : "auto",
  });

  const [cloudTranscriptionMode, setCloudTranscriptionModeRaw] = useLocalStorage(
    "cloudTranscriptionMode",
    hasStoredByokKey() ? "byok" : CHORDVOX_CLOUD_MODE,
    {
      serialize: String,
      deserialize: (value) =>
        normalizeChordVoxCloudMode(value, hasStoredByokKey() ? "byok" : CHORDVOX_CLOUD_MODE),
    }
  );

  const [cloudReasoningMode, setCloudReasoningModeRaw] = useLocalStorage(
    "cloudReasoningMode",
    DEFAULT_CLOUD_REASONING_MODE,
    {
      serialize: String,
      deserialize: (value) => normalizeChordVoxCloudMode(value, DEFAULT_CLOUD_REASONING_MODE),
    }
  );

  const setCloudTranscriptionMode = useCallback(
    (value: string) => {
      setCloudTranscriptionModeRaw(
        normalizeChordVoxCloudMode(value, hasStoredByokKey() ? "byok" : CHORDVOX_CLOUD_MODE)
      );
    },
    [setCloudTranscriptionModeRaw]
  );

  const setCloudReasoningMode = useCallback(
    (value: string) => {
      setCloudReasoningModeRaw(normalizeChordVoxCloudMode(value, DEFAULT_CLOUD_REASONING_MODE));
    },
    [setCloudReasoningModeRaw]
  );

  // Custom dictionary for improving transcription of specific words
  const [customDictionary, setCustomDictionaryRaw] = useLocalStorage<string[]>(
    "customDictionary",
    [],
    {
      serialize: JSON.stringify,
      deserialize: (value) => {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      },
    }
  );

  // Assembly AI real-time streaming (enabled by default for signed-in users)
  const [assemblyAiStreaming, setAssemblyAiStreaming] = useLocalStorage(
    "assemblyAiStreaming",
    true,
    {
      serialize: String,
      deserialize: (value) => value !== "false", // Default to true unless explicitly disabled
    }
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (cloudTranscriptionMode !== CHORDVOX_CLOUD_MODE) return;
    if (window.localStorage.getItem("cloudTranscriptionMode") === CHORDVOX_CLOUD_MODE) return;
    setCloudTranscriptionMode(CHORDVOX_CLOUD_MODE);
  }, [cloudTranscriptionMode, setCloudTranscriptionMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (cloudReasoningMode !== CHORDVOX_CLOUD_MODE) return;
    if (window.localStorage.getItem("cloudReasoningMode") === CHORDVOX_CLOUD_MODE) return;
    setCloudReasoningMode(CHORDVOX_CLOUD_MODE);
  }, [cloudReasoningMode, setCloudReasoningMode]);

  // Wrap setter to sync dictionary to SQLite
  const setCustomDictionary = useCallback(
    (words: string[]) => {
      setCustomDictionaryRaw(words);
      window.electronAPI?.setDictionary(words).catch((err) => {
        logger.warn(
          "Failed to sync dictionary to SQLite",
          { error: (err as Error).message },
          "settings"
        );
      });
    },
    [setCustomDictionaryRaw]
  );

  // One-time sync: reconcile localStorage ↔ SQLite on startup
  const hasRunDictionarySync = useRef(false);
  useEffect(() => {
    if (hasRunDictionarySync.current) return;
    hasRunDictionarySync.current = true;

    const syncDictionary = async () => {
      if (typeof window === "undefined" || !window.electronAPI?.getDictionary) return;
      try {
        const dbWords = await window.electronAPI.getDictionary();
        if (dbWords.length === 0 && customDictionary.length > 0) {
          // Seed SQLite from localStorage (first-time migration)
          await window.electronAPI.setDictionary(customDictionary);
        } else if (dbWords.length > 0 && customDictionary.length === 0) {
          // Recover localStorage from SQLite (e.g. localStorage was cleared)
          setCustomDictionaryRaw(dbWords);
        }
      } catch (err) {
        logger.warn(
          "Failed to sync dictionary on startup",
          { error: (err as Error).message },
          "settings"
        );
      }
    };

    syncDictionary().then(() => {
      // Ensure agent name is in dictionary for existing users who set it before this feature
      ensureAgentNameInDictionary();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reasoning settings
  const [useReasoningModel, setUseReasoningModel] = useLocalStorage("useReasoningModel", true, {
    serialize: String,
    deserialize: (value) => value !== "false", // Default true
  });

  const [reasoningModel, setReasoningModel] = useLocalStorage("reasoningModel", "", {
    serialize: String,
    deserialize: String,
  });

  const [reasoningProvider, setReasoningProviderRaw] = useLocalStorage("reasoningProvider", "openai", {
    serialize: String,
    deserialize: (value) => normalizeChordVoxProvider(value, "openai"),
  });

  const setReasoningProvider = useCallback(
    (value: string) => {
      setReasoningProviderRaw(normalizeChordVoxProvider(value, "openai"));
    },
    [setReasoningProviderRaw]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (reasoningProvider !== CHORDVOX_CLOUD_PROVIDER) return;
    if (window.localStorage.getItem("reasoningProvider") === CHORDVOX_CLOUD_PROVIDER) return;
    setReasoningProvider(CHORDVOX_CLOUD_PROVIDER);
  }, [reasoningProvider, setReasoningProvider]);

  // API keys - localStorage for UI, synced to Electron IPC for persistence
  const [openaiApiKey, setOpenaiApiKeyLocal] = useLocalStorage("openaiApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [openrouterApiKey, setOpenrouterApiKeyLocal] = useLocalStorage("openrouterApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [anthropicApiKey, setAnthropicApiKeyLocal] = useLocalStorage("anthropicApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [geminiApiKey, setGeminiApiKeyLocal] = useLocalStorage("geminiApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [groqApiKey, setGroqApiKeyLocal] = useLocalStorage("groqApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [doubaoAppId, setDoubaoAppIdLocal] = useLocalStorage("doubaoAppId", "", {
    serialize: String,
    deserialize: String,
  });

  const [doubaoAccessToken, setDoubaoAccessTokenLocal] = useLocalStorage("doubaoAccessToken", "", {
    serialize: String,
    deserialize: String,
  });

  // Theme setting
  const [theme, setTheme] = useLocalStorage<"light" | "dark" | "auto">("theme", "auto", {
    serialize: String,
    deserialize: (value) => {
      if (["light", "dark", "auto"].includes(value)) return value as "light" | "dark" | "auto";
      return "auto";
    },
  });

  // Privacy settings — customer builds default analytics/cloud backup to OFF.
  const [cloudBackupEnabled, setCloudBackupEnabled] = useLocalStorage("cloudBackupEnabled", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [telemetryEnabled, setTelemetryEnabled] = useLocalStorage("telemetryEnabled", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [transcriptionHistoryEnabled, setTranscriptionHistoryEnabled] = useLocalStorage(
    "transcriptionHistoryEnabled",
    true,
    {
      serialize: String,
      deserialize: (value) => value !== "false",
    }
  );

  // Custom endpoint API keys - synced to .env like other keys
  const [customTranscriptionApiKey, setCustomTranscriptionApiKeyLocal] = useLocalStorage(
    "customTranscriptionApiKey",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [customReasoningApiKey, setCustomReasoningApiKeyLocal] = useLocalStorage(
    "customReasoningApiKey",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  // Sync API keys from main process on first mount (if localStorage was cleared)
  const hasRunApiKeySync = useRef(false);
  useEffect(() => {
    if (hasRunApiKeySync.current) return;
    hasRunApiKeySync.current = true;

    const syncKeys = async () => {
      if (typeof window === "undefined" || !window.electronAPI) return;

      // Only sync keys that are missing from localStorage
      if (!openaiApiKey) {
        const envKey = await window.electronAPI.getOpenAIKey?.();
        if (envKey) setOpenaiApiKeyLocal(envKey);
      }
      if (!anthropicApiKey) {
        const envKey = await window.electronAPI.getAnthropicKey?.();
        if (envKey) setAnthropicApiKeyLocal(envKey);
      }
      if (!openrouterApiKey) {
        const envKey = await window.electronAPI.getOpenRouterKey?.();
        if (envKey) setOpenrouterApiKeyLocal(envKey);
      }
      if (!geminiApiKey) {
        const envKey = await window.electronAPI.getGeminiKey?.();
        if (envKey) setGeminiApiKeyLocal(envKey);
      }
      if (!groqApiKey) {
        const envKey = await window.electronAPI.getGroqKey?.();
        if (envKey) setGroqApiKeyLocal(envKey);
      }
      if (!doubaoAppId) {
        const envAppId = await window.electronAPI.getDoubaoAppId?.();
        if (envAppId) setDoubaoAppIdLocal(envAppId);
      }
      if (!doubaoAccessToken) {
        const envToken = await window.electronAPI.getDoubaoAccessToken?.();
        if (envToken) setDoubaoAccessTokenLocal(envToken);
      }
      if (!customTranscriptionApiKey) {
        const envKey = await window.electronAPI.getCustomTranscriptionKey?.();
        if (envKey) setCustomTranscriptionApiKeyLocal(envKey);
      }
      if (!customReasoningApiKey) {
        const envKey = await window.electronAPI.getCustomReasoningKey?.();
        if (envKey) setCustomReasoningApiKeyLocal(envKey);
      }
    };

    syncKeys().catch((err) => {
      logger.warn(
        "Failed to sync API keys on startup",
        { error: (err as Error).message },
        "settings"
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debouncedPersistToEnv = useDebouncedCallback(() => {
    if (typeof window !== "undefined" && window.electronAPI?.saveAllKeysToEnv) {
      window.electronAPI.saveAllKeysToEnv().catch((err) => {
        logger.warn(
          "Failed to persist API keys to .env",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  }, 1000);

  const invalidateApiKeyCaches = useCallback(
    (
      provider?:
        | "openai"
        | "openrouter"
        | "anthropic"
        | "gemini"
        | "groq"
        | "custom"
    ) => {
      if (provider) {
        getReasoningService().clearApiKeyCache(provider);
      }
      window.dispatchEvent(new Event("api-key-changed"));
      debouncedPersistToEnv();
    },
    [debouncedPersistToEnv]
  );

  const setOpenaiApiKey = useCallback(
    (key: string) => {
      setOpenaiApiKeyLocal(key);
      window.electronAPI?.saveOpenAIKey?.(key);
      invalidateApiKeyCaches("openai");
    },
    [setOpenaiApiKeyLocal, invalidateApiKeyCaches]
  );

  const setAnthropicApiKey = useCallback(
    (key: string) => {
      setAnthropicApiKeyLocal(key);
      window.electronAPI?.saveAnthropicKey?.(key);
      invalidateApiKeyCaches("anthropic");
    },
    [setAnthropicApiKeyLocal, invalidateApiKeyCaches]
  );

  const setOpenrouterApiKey = useCallback(
    (key: string) => {
      setOpenrouterApiKeyLocal(key);
      window.electronAPI?.saveOpenRouterKey?.(key);
      invalidateApiKeyCaches("openrouter");
    },
    [setOpenrouterApiKeyLocal, invalidateApiKeyCaches]
  );

  const setGeminiApiKey = useCallback(
    (key: string) => {
      setGeminiApiKeyLocal(key);
      window.electronAPI?.saveGeminiKey?.(key);
      invalidateApiKeyCaches("gemini");
    },
    [setGeminiApiKeyLocal, invalidateApiKeyCaches]
  );

  const setGroqApiKey = useCallback(
    (key: string) => {
      setGroqApiKeyLocal(key);
      window.electronAPI?.saveGroqKey?.(key);
      invalidateApiKeyCaches("groq");
    },
    [setGroqApiKeyLocal, invalidateApiKeyCaches]
  );

  const setDoubaoAppId = useCallback(
    (appId: string) => {
      setDoubaoAppIdLocal(appId);
      window.electronAPI?.saveDoubaoAppId?.(appId);
      invalidateApiKeyCaches();
    },
    [setDoubaoAppIdLocal, invalidateApiKeyCaches]
  );

  const setDoubaoAccessToken = useCallback(
    (token: string) => {
      setDoubaoAccessTokenLocal(token);
      window.electronAPI?.saveDoubaoAccessToken?.(token);
      invalidateApiKeyCaches();
    },
    [setDoubaoAccessTokenLocal, invalidateApiKeyCaches]
  );

  const setCustomTranscriptionApiKey = useCallback(
    (key: string) => {
      setCustomTranscriptionApiKeyLocal(key);
      window.electronAPI?.saveCustomTranscriptionKey?.(key);
      invalidateApiKeyCaches();
    },
    [setCustomTranscriptionApiKeyLocal, invalidateApiKeyCaches]
  );

  const setCustomReasoningApiKey = useCallback(
    (key: string) => {
      setCustomReasoningApiKeyLocal(key);
      window.electronAPI?.saveCustomReasoningKey?.(key);
      invalidateApiKeyCaches("custom");
    },
    [setCustomReasoningApiKeyLocal, invalidateApiKeyCaches]
  );

  const [dictationKey, setDictationKeyLocal] = useLocalStorage("dictationKey", "", {
    serialize: String,
    deserialize: String,
  });

  const setDictationKey = useCallback(
    (key: string) => {
      setDictationKeyLocal(key);
      if (typeof window !== "undefined" && window.electronAPI?.notifyHotkeyChanged) {
        window.electronAPI.notifyHotkeyChanged(key);
      }
      if (typeof window !== "undefined" && window.electronAPI?.saveDictationKey) {
        window.electronAPI.saveDictationKey(key);
      }
    },
    [setDictationKeyLocal]
  );

  const [dictationKeySecondary, setDictationKeySecondaryLocal] = useLocalStorage(
    "dictationKeySecondary",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const setDictationKeySecondary = useCallback(
    (key: string) => {
      setDictationKeySecondaryLocal(key);
      if (typeof window !== "undefined" && window.electronAPI?.notifyHotkeyChanged) {
        window.electronAPI.notifyHotkeyChanged(key, "secondary");
      }
    },
    [setDictationKeySecondaryLocal]
  );

  const [secondaryHotkeyProfile, setSecondaryHotkeyProfileRaw] = useLocalStorage<
    SecondaryHotkeyProfile | null
  >("secondaryHotkeyProfile", null, {
    serialize: JSON.stringify,
    deserialize: (value) => {
      if (!value) return null;
      try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object") return null;
        return {
          useLocalWhisper: parsed.useLocalWhisper !== false,
          localTranscriptionProvider:
            parsed.localTranscriptionProvider === "nvidia" ||
            parsed.localTranscriptionProvider === "sensevoice"
              ? parsed.localTranscriptionProvider
              : "whisper",
          whisperModel: typeof parsed.whisperModel === "string" ? parsed.whisperModel : "turbo",
          parakeetModel: typeof parsed.parakeetModel === "string" ? parsed.parakeetModel : "",
          senseVoiceModelPath:
            typeof parsed.senseVoiceModelPath === "string" ? parsed.senseVoiceModelPath : "",
          senseVoiceBinaryPath:
            typeof parsed.senseVoiceBinaryPath === "string" ? parsed.senseVoiceBinaryPath : "",
          allowOpenAIFallback: parsed.allowOpenAIFallback === true,
          allowLocalFallback: parsed.allowLocalFallback === true,
          fallbackWhisperModel:
            typeof parsed.fallbackWhisperModel === "string" ? parsed.fallbackWhisperModel : "turbo",
          preferredLanguage:
            typeof parsed.preferredLanguage === "string" ? parsed.preferredLanguage : "auto",
          cloudTranscriptionMode:
            typeof parsed.cloudTranscriptionMode === "string"
              ? normalizeChordVoxCloudMode(
                  parsed.cloudTranscriptionMode,
                  hasStoredByokKey() ? "byok" : CHORDVOX_CLOUD_MODE
                )
              : "byok",
          cloudTranscriptionProvider:
            typeof parsed.cloudTranscriptionProvider === "string"
              ? parsed.cloudTranscriptionProvider
              : "openai",
          cloudTranscriptionModel:
            typeof parsed.cloudTranscriptionModel === "string"
              ? parsed.cloudTranscriptionModel
              : "gpt-4o-mini-transcribe",
          cloudTranscriptionBaseUrl:
            typeof parsed.cloudTranscriptionBaseUrl === "string"
              ? parsed.cloudTranscriptionBaseUrl
              : API_ENDPOINTS.TRANSCRIPTION_BASE,
          useReasoningModel: parsed.useReasoningModel !== false,
          reasoningModel: typeof parsed.reasoningModel === "string" ? parsed.reasoningModel : "",
          reasoningProvider:
            typeof parsed.reasoningProvider === "string"
              ? normalizeChordVoxProvider(parsed.reasoningProvider, "openai")
              : "openai",
          customReasoningProtocol:
            parsed.customReasoningProtocol === "chat" || parsed.customReasoningProtocol === "responses"
              ? parsed.customReasoningProtocol
              : "auto",
          cloudReasoningMode:
            typeof parsed.cloudReasoningMode === "string"
              ? normalizeChordVoxCloudMode(
                  parsed.cloudReasoningMode,
                  DEFAULT_CLOUD_REASONING_MODE
                )
              : DEFAULT_CLOUD_REASONING_MODE,
        } satisfies SecondaryHotkeyProfile;
      } catch {
        return null;
      }
    },
  });

  const setSecondaryHotkeyProfile = useCallback(
    (profile: SecondaryHotkeyProfile | null) => {
      setSecondaryHotkeyProfileRaw(profile);
    },
    [setSecondaryHotkeyProfileRaw]
  );

  const captureSecondaryHotkeyProfileFromCurrent = useCallback(() => {
    const profile: SecondaryHotkeyProfile = {
      useLocalWhisper,
      localTranscriptionProvider,
      whisperModel,
      parakeetModel,
      senseVoiceModelPath,
      senseVoiceBinaryPath,
      allowOpenAIFallback,
      allowLocalFallback,
      fallbackWhisperModel,
      preferredLanguage,
      cloudTranscriptionMode,
      cloudTranscriptionProvider,
      cloudTranscriptionModel,
      cloudTranscriptionBaseUrl,
      useReasoningModel,
      reasoningModel,
      reasoningProvider,
      customReasoningProtocol,
      cloudReasoningMode,
    };
    setSecondaryHotkeyProfileRaw(profile);
    return profile;
  }, [
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    senseVoiceModelPath,
    senseVoiceBinaryPath,
    allowOpenAIFallback,
    allowLocalFallback,
    fallbackWhisperModel,
    preferredLanguage,
    cloudTranscriptionMode,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    useReasoningModel,
    reasoningModel,
    reasoningProvider,
    customReasoningProtocol,
    cloudReasoningMode,
    setSecondaryHotkeyProfileRaw,
  ]);

  const [activationMode, setActivationModeLocal] = useLocalStorage<"tap" | "push">(
    "activationMode",
    "tap",
    {
      serialize: String,
      deserialize: (value) => (value === "push" ? "push" : "tap"),
    }
  );

  const setActivationMode = useCallback(
    (mode: "tap" | "push") => {
      setActivationModeLocal(mode);
      if (typeof window !== "undefined" && window.electronAPI?.notifyActivationModeChanged) {
        window.electronAPI.notifyActivationModeChanged(mode);
      }
    },
    [setActivationModeLocal]
  );

  // Sync activation mode from main process on first mount (handles localStorage cleared)
  const hasRunActivationModeSync = useRef(false);
  useEffect(() => {
    if (hasRunActivationModeSync.current) return;
    hasRunActivationModeSync.current = true;

    const sync = async () => {
      if (!window.electronAPI?.getActivationMode) return;
      const envMode = await window.electronAPI.getActivationMode();
      if (envMode && envMode !== activationMode) {
        setActivationModeLocal(envMode);
      }
    };
    sync().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync dictation key from main process on first mount (handles localStorage cleared)
  const hasRunDictationKeySync = useRef(false);
  useEffect(() => {
    if (hasRunDictationKeySync.current) return;
    hasRunDictationKeySync.current = true;

    const sync = async () => {
      if (!window.electronAPI?.getDictationKey) return;
      const envKey = await window.electronAPI.getDictationKey();
      if (envKey && envKey !== dictationKey) {
        setDictationKeyLocal(envKey);
      }
    };
    sync().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [audioCuesEnabled, setAudioCuesEnabled] = useLocalStorage("audioCuesEnabled", true, {
    serialize: String,
    deserialize: (value) => value !== "false",
  });

  const [dictationCueStyle, setDictationCueStyleLocal] = useLocalStorage<DictationCueStyle>(
    "dictationCueStyle",
    "electronic",
    {
      serialize: String,
      deserialize: (value) =>
        value === "off" || value === "droplet1" || value === "droplet2" ? value : "electronic",
    }
  );

  const [recordingAnimationStyle, setRecordingAnimationStyleLocal] =
    useLocalStorage<RecordingAnimationStyle>("recordingAnimationStyle", "level", {
      serialize: String,
      deserialize: (value) =>
        value === "line" || value === "particles" || value === "level" ? value : "level",
    });

  const setDictationCueStyle = useCallback(
    (style: DictationCueStyle) => {
      setDictationCueStyleLocal(style);
      if (typeof window !== "undefined" && window.electronAPI?.notifyDictationCueStyleChanged) {
        window.electronAPI.notifyDictationCueStyleChanged(style);
      }
    },
    [setDictationCueStyleLocal]
  );

  const setRecordingAnimationStyle = useCallback(
    (style: RecordingAnimationStyle) => {
      setRecordingAnimationStyleLocal(style);
      if (
        typeof window !== "undefined" &&
        window.electronAPI?.notifyRecordingAnimationStyleChanged
      ) {
        window.electronAPI.notifyRecordingAnimationStyleChanged(style);
      }
    },
    [setRecordingAnimationStyleLocal]
  );

  // Microphone settings
  const [preferBuiltInMic, setPreferBuiltInMic] = useLocalStorage("preferBuiltInMic", true, {
    serialize: String,
    deserialize: (value) => value !== "false",
  });

  const [selectedMicDeviceId, setSelectedMicDeviceId] = useLocalStorage("selectedMicDeviceId", "", {
    serialize: String,
    deserialize: String,
  });

  // Sync startup pre-warming preferences to main process
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.syncStartupPreferences) return;

    let model = whisperModel;
    if (localTranscriptionProvider === "nvidia") {
      model = parakeetModel;
    } else if (localTranscriptionProvider === "sensevoice") {
      model = senseVoiceModelPath;
    }

    window.electronAPI
      .syncStartupPreferences({
        useLocalWhisper,
        localTranscriptionProvider,
        model: model || undefined,
        senseVoiceBinaryPath:
          localTranscriptionProvider === "sensevoice" && senseVoiceBinaryPath
            ? senseVoiceBinaryPath
            : undefined,
        reasoningProvider,
        reasoningModel: reasoningProvider === "local" ? reasoningModel : undefined,
      })
      .catch((err) =>
        logger.warn(
          "Failed to sync startup preferences",
          { error: (err as Error).message },
          "settings"
        )
      );
  }, [
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    senseVoiceModelPath,
    senseVoiceBinaryPath,
    reasoningProvider,
    reasoningModel,
  ]);

  // Batch operations
  const updateTranscriptionSettings = useCallback(
    (settings: Partial<TranscriptionSettings>) => {
      if (settings.useLocalWhisper !== undefined) setUseLocalWhisper(settings.useLocalWhisper);
      if (settings.uiLanguage !== undefined) setUiLanguage(settings.uiLanguage);
      if (settings.modelStorageRoot !== undefined) setModelStorageRoot(settings.modelStorageRoot);
      if (settings.whisperModel !== undefined) setWhisperModel(settings.whisperModel);
      if (settings.localTranscriptionProvider !== undefined)
        setLocalTranscriptionProvider(settings.localTranscriptionProvider);
      if (settings.parakeetModel !== undefined) setParakeetModel(settings.parakeetModel);
      if (settings.senseVoiceModelPath !== undefined)
        setSenseVoiceModelPath(settings.senseVoiceModelPath);
      if (settings.senseVoiceBinaryPath !== undefined)
        setSenseVoiceBinaryPath(settings.senseVoiceBinaryPath);
      if (settings.allowOpenAIFallback !== undefined)
        setAllowOpenAIFallback(settings.allowOpenAIFallback);
      if (settings.allowLocalFallback !== undefined)
        setAllowLocalFallback(settings.allowLocalFallback);
      if (settings.fallbackWhisperModel !== undefined)
        setFallbackWhisperModel(settings.fallbackWhisperModel);
      if (settings.preferredLanguage !== undefined)
        setPreferredLanguage(settings.preferredLanguage);
      if (settings.cloudTranscriptionMode !== undefined)
        setCloudTranscriptionMode(settings.cloudTranscriptionMode);
      if (settings.cloudTranscriptionProvider !== undefined)
        setCloudTranscriptionProvider(settings.cloudTranscriptionProvider);
      if (settings.cloudTranscriptionModel !== undefined)
        setCloudTranscriptionModel(settings.cloudTranscriptionModel);
      if (settings.cloudTranscriptionBaseUrl !== undefined)
        setCloudTranscriptionBaseUrl(settings.cloudTranscriptionBaseUrl);
      if (settings.customDictionary !== undefined) setCustomDictionary(settings.customDictionary);
    },
    [
      setUseLocalWhisper,
      setUiLanguage,
      setModelStorageRoot,
      setWhisperModel,
      setLocalTranscriptionProvider,
      setParakeetModel,
      setSenseVoiceModelPath,
      setSenseVoiceBinaryPath,
      setAllowOpenAIFallback,
      setAllowLocalFallback,
      setFallbackWhisperModel,
      setPreferredLanguage,
      setCloudTranscriptionMode,
      setCloudTranscriptionProvider,
      setCloudTranscriptionModel,
      setCloudTranscriptionBaseUrl,
      setCustomDictionary,
    ]
  );

  const updateReasoningSettings = useCallback(
    (settings: Partial<ReasoningSettings>) => {
      if (settings.useReasoningModel !== undefined)
        setUseReasoningModel(settings.useReasoningModel);
      if (settings.reasoningModel !== undefined) setReasoningModel(settings.reasoningModel);
      if (settings.reasoningProvider !== undefined)
        setReasoningProvider(settings.reasoningProvider);
      if (settings.cloudReasoningBaseUrl !== undefined)
        setCloudReasoningBaseUrl(settings.cloudReasoningBaseUrl);
      if (settings.customReasoningProtocol !== undefined)
        setCustomReasoningProtocol(settings.customReasoningProtocol);
      if (settings.cloudReasoningMode !== undefined)
        setCloudReasoningMode(settings.cloudReasoningMode);
    },
    [
      setUseReasoningModel,
      setReasoningModel,
      setReasoningProvider,
      setCloudReasoningBaseUrl,
      setCustomReasoningProtocol,
      setCloudReasoningMode,
    ]
  );

  const updateApiKeys = useCallback(
    (keys: Partial<ApiKeySettings>) => {
      if (keys.openaiApiKey !== undefined) setOpenaiApiKey(keys.openaiApiKey);
      if (keys.openrouterApiKey !== undefined) setOpenrouterApiKey(keys.openrouterApiKey);
      if (keys.anthropicApiKey !== undefined) setAnthropicApiKey(keys.anthropicApiKey);
      if (keys.geminiApiKey !== undefined) setGeminiApiKey(keys.geminiApiKey);
      if (keys.groqApiKey !== undefined) setGroqApiKey(keys.groqApiKey);
      if (keys.doubaoAppId !== undefined) setDoubaoAppId(keys.doubaoAppId);
      if (keys.doubaoAccessToken !== undefined) setDoubaoAccessToken(keys.doubaoAccessToken);
    },
    [
      setOpenaiApiKey,
      setOpenrouterApiKey,
      setAnthropicApiKey,
      setGeminiApiKey,
      setGroqApiKey,
      setDoubaoAppId,
      setDoubaoAccessToken,
    ]
  );

  return {
    useLocalWhisper,
    whisperModel,
    uiLanguage,
    modelStorageRoot,
    localTranscriptionProvider,
    parakeetModel,
    senseVoiceModelPath,
    senseVoiceBinaryPath,
    allowOpenAIFallback,
    allowLocalFallback,
    fallbackWhisperModel,
    preferredLanguage,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    cloudReasoningBaseUrl,
    customReasoningProtocol,
    cloudTranscriptionMode,
    cloudReasoningMode,
    customDictionary,
    assemblyAiStreaming,
    setAssemblyAiStreaming,
    useReasoningModel,
    reasoningModel,
    reasoningProvider,
    openaiApiKey,
    openrouterApiKey,
    anthropicApiKey,
    geminiApiKey,
    groqApiKey,
    doubaoAppId,
    doubaoAccessToken,
    dictationKey,
    dictationKeySecondary,
    secondaryHotkeyProfile,
    theme,
    setUseLocalWhisper,
    setWhisperModel,
    setUiLanguage,
    setModelStorageRoot,
    setLocalTranscriptionProvider,
    setParakeetModel,
    setSenseVoiceModelPath,
    setSenseVoiceBinaryPath,
    setAllowOpenAIFallback,
    setAllowLocalFallback,
    setFallbackWhisperModel,
    setPreferredLanguage,
    setCloudTranscriptionProvider,
    setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl,
    setCloudReasoningBaseUrl,
    setCustomReasoningProtocol,
    setCloudTranscriptionMode,
    setCloudReasoningMode,
    setCustomDictionary,
    setUseReasoningModel,
    setReasoningModel,
    setReasoningProvider,
    setOpenaiApiKey,
    setOpenrouterApiKey,
    setAnthropicApiKey,
    setGeminiApiKey,
    setGroqApiKey,
    setDoubaoAppId,
    setDoubaoAccessToken,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
    customReasoningApiKey,
    setCustomReasoningApiKey,
    setDictationKey,
    setDictationKeySecondary,
    setSecondaryHotkeyProfile,
    captureSecondaryHotkeyProfileFromCurrent,
    setTheme,
    activationMode,
    setActivationMode,
    audioCuesEnabled,
    setAudioCuesEnabled,
    dictationCueStyle,
    setDictationCueStyle,
    recordingAnimationStyle,
    setRecordingAnimationStyle,
    preferBuiltInMic,
    selectedMicDeviceId,
    setPreferBuiltInMic,
    setSelectedMicDeviceId,
    cloudBackupEnabled,
    setCloudBackupEnabled,
    telemetryEnabled,
    transcriptionHistoryEnabled,
    setTelemetryEnabled,
    setTranscriptionHistoryEnabled,
    updateTranscriptionSettings,
    updateReasoningSettings,
    updateApiKeys,
  };
}

export type SettingsValue = ReturnType<typeof useSettingsInternal>;

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const value = useSettingsInternal();
  return React.createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
