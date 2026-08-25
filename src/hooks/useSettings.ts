import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as SentryRenderer from "@sentry/electron/renderer";
import { useLocalStorage, writeLocalStorageValue } from "./useLocalStorage";
import { useDebouncedCallback } from "./useDebouncedCallback";
import { API_ENDPOINTS } from "../config/constants";
import logger from "../utils/logger";
import { ensureAgentNameInDictionary } from "../utils/agentName";
import i18n, { normalizeUiLanguage } from "../i18n";
import {
  getConfiguredReasoningByokProvider,
  getConfiguredTranscriptionByokProvider,
  migrateUnavailableHostedCloudSettings,
  normalizeAvailableCloudMode,
  normalizeAvailableCloudProvider,
} from "../utils/chordvoxCloud";
import {
  DEFAULT_RECORDING_ANIMATION_STYLE,
  normalizeRecordingAnimationStyle,
  type RecordingAnimationStyleValue,
} from "../utils/recordingAnimationStyle";
import { DEFAULT_CUSTOM_DICTIONARY, normalizeDictionaryWords } from "../utils/defaultDictionary";
import { DEFAULT_WHISPER_MODEL_ID, normalizeWhisperModelId } from "../utils/whisperModelSelection";
import {
  DEFAULT_ENGLISH_PARAKEET_MODEL_ID,
  DEFAULT_PARAFORMER_MODEL_ID,
  getDefaultLocalTranscriptionProfile,
} from "../utils/defaultTranscriptionModel";
import type { LocalTranscriptionProvider, ModelStorageRootSaveResult } from "../types/electron";
import {
  normalizeCustomReasoningProtocol,
  type CustomReasoningProtocol,
} from "../utils/customReasoningProtocol";
import {
  REASONING_MODEL_SETTING_CHANGED_EVENT,
  restoreReasoningModelAfterPreviewReset,
} from "../utils/reasoningPreviewQuota";
import ReasoningService from "../services/ReasoningService";
import { isLocalReasoningProviderId } from "../models/ModelRegistry";
import {
  getDefaultLocalStreamingModelIdForLocale,
  normalizeStreamingModelId,
} from "../utils/streamingModelSelection";

const LOCAL_REASONING_PROVIDER_STORAGE_KEY = "chordvox_local_reasoning_provider";

function normalizeLocalTranscriptionProvider(value: string): LocalTranscriptionProvider {
  if (value === "nvidia") return "nvidia";
  if (value === "granite") return "granite";
  if (value === "paraformer") return "paraformer";
  if (value === "cohere") return "cohere";
  return "whisper";
}

export interface TranscriptionSettings {
  uiLanguage: string;
  modelStorageRoot?: string;
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  paraformerModel: string;
  graniteModel: string;
  cohereModel: string;
  graniteRuntimeUrl: string;
  graniteRuntimeApiKey: string;
  cohereRuntimeUrl: string;
  cohereRuntimeApiKey: string;
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
  customReasoningProtocol?: CustomReasoningProtocol;
  cloudReasoningMode: string;
}

export interface HotkeySettings {
  dictationKey: string;
  activationMode: "tap" | "push";
}

export interface SecondaryHotkeyProfile {
  useLocalWhisper: boolean;
  useLocalStreaming?: boolean;
  localStreamingModelId?: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  whisperModel: string;
  parakeetModel: string;
  paraformerModel: string;
  graniteModel: string;
  cohereModel: string;
  graniteRuntimeUrl: string;
  graniteRuntimeApiKey: string;
  cohereRuntimeUrl: string;
  cohereRuntimeApiKey: string;
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
  customReasoningProtocol?: CustomReasoningProtocol;
  cloudReasoningMode: string;
}

export type HotkeyWorkflowAction = "dictate" | "translate" | "polish" | "chat";

export interface HotkeyWorkflow {
  id: string;
  name: string;
  hotkey: string;
  action: HotkeyWorkflowAction;
  targetLanguage: string;
  enabled: boolean;
  profile: SecondaryHotkeyProfile;
}

export const HOTKEY_WORKFLOWS_STORAGE_KEY = "hotkeyWorkflowsV1";
export const MAX_HOTKEY_WORKFLOWS = 12;

const HOTKEY_WORKFLOW_ID_PATTERN = /^(secondary|workflow-[a-z0-9-]{1,72})$/i;
const HOTKEY_WORKFLOW_ACTIONS = new Set<HotkeyWorkflowAction>([
  "dictate",
  "translate",
  "polish",
  "chat",
]);

export function normalizeHotkeyWorkflows(value: unknown): HotkeyWorkflow[] {
  if (!Array.isArray(value)) return [];

  const seenIds = new Set<string>();
  const workflows: HotkeyWorkflow[] = [];
  for (const item of value.slice(0, MAX_HOTKEY_WORKFLOWS)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<HotkeyWorkflow>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const hotkey = typeof candidate.hotkey === "string" ? candidate.hotkey.trim() : "";
    const action = HOTKEY_WORKFLOW_ACTIONS.has(candidate.action as HotkeyWorkflowAction)
      ? (candidate.action as HotkeyWorkflowAction)
      : "dictate";
    if (!HOTKEY_WORKFLOW_ID_PATTERN.test(id) || seenIds.has(id) || !hotkey) continue;
    if (!candidate.profile || typeof candidate.profile !== "object") continue;

    seenIds.add(id);
    workflows.push({
      id,
      name: typeof candidate.name === "string" ? candidate.name.trim().slice(0, 80) : "",
      hotkey: hotkey.slice(0, 100),
      action,
      targetLanguage:
        typeof candidate.targetLanguage === "string" && candidate.targetLanguage.trim()
          ? candidate.targetLanguage.trim().slice(0, 32)
          : "en",
      enabled: candidate.enabled !== false,
      profile: { ...candidate.profile },
    });
  }
  return workflows;
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
  cerebrasApiKey: string;
  sonioxApiKey: string;
  deepgramApiKey: string;
  googleSttApiKey: string;
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

export interface NotificationSettings {
  fileTranscriptionCompletionAlertEnabled: boolean;
  tailCommandsEnabled: boolean;
}

export interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

export type DictationCueStyle = "off" | "electronic" | "droplet1" | "droplet2";
export type RecordingAnimationStyle = RecordingAnimationStyleValue;

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };
const DEFAULT_CLOUD_REASONING_MODE = "byok";
let _migrated = false;
let _migratedUnavailableHostedCloud = false;
function migratePreferredLanguage() {
  if (_migrated) return;
  _migrated = true;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

function migrateUnavailableHostedCloudOnce() {
  if (_migratedUnavailableHostedCloud) return;
  _migratedUnavailableHostedCloud = true;
  try {
    migrateUnavailableHostedCloudSettings(localStorage);
  } catch (error) {
    logger.warn(
      "Failed to migrate unavailable hosted-cloud settings",
      { error: (error as Error).message },
      "settings"
    );
  }
}

function useSettingsInternal() {
  migratePreferredLanguage();
  migrateUnavailableHostedCloudOnce();
  const initialUiLanguage = normalizeUiLanguage(i18n.language);
  const defaultLocalProfile = getDefaultLocalTranscriptionProfile(initialUiLanguage);

  const [useLocalWhisper, setUseLocalWhisper] = useLocalStorage("useLocalWhisper", true, {
    serialize: String,
    deserialize: (value) => value !== "false",
  });

  const [whisperModel, setWhisperModel] = useLocalStorage(
    "whisperModel",
    DEFAULT_WHISPER_MODEL_ID,
    {
      serialize: String,
      deserialize: normalizeWhisperModelId,
    }
  );

  const [localTranscriptionProvider, setLocalTranscriptionProvider] =
    useLocalStorage<LocalTranscriptionProvider>(
      "localTranscriptionProvider",
      defaultLocalProfile.provider,
      {
        serialize: String,
        deserialize: (value) => {
          return normalizeLocalTranscriptionProvider(value);
        },
      }
    );

  const [parakeetModel, setParakeetModel] = useLocalStorage(
    "parakeetModel",
    defaultLocalProfile.parakeetModel || DEFAULT_ENGLISH_PARAKEET_MODEL_ID,
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [paraformerModel, setParaformerModel] = useLocalStorage(
    "paraformerModel",
    DEFAULT_PARAFORMER_MODEL_ID,
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [graniteModel, setGraniteModel] = useLocalStorage("graniteModel", "granite-4.0-1b-speech", {
    serialize: String,
    deserialize: String,
  });

  const [cohereModel, setCohereModel] = useLocalStorage(
    "cohereModel",
    "cohere-transcribe-03-2026",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [graniteRuntimeUrl, setGraniteRuntimeUrl] = useLocalStorage("graniteRuntimeUrl", "", {
    serialize: String,
    deserialize: String,
  });

  const [graniteRuntimeApiKey, setGraniteRuntimeApiKeyLocal] = useLocalStorage(
    "graniteRuntimeApiKey",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cohereRuntimeUrl, setCohereRuntimeUrl] = useLocalStorage("cohereRuntimeUrl", "", {
    serialize: String,
    deserialize: String,
  });

  const [cohereRuntimeApiKey, setCohereRuntimeApiKeyLocal] = useLocalStorage(
    "cohereRuntimeApiKey",
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
    DEFAULT_WHISPER_MODEL_ID,
    {
      serialize: String,
      deserialize: normalizeWhisperModelId,
    }
  );

  const [preferredLanguage, setPreferredLanguage] = useLocalStorage("preferredLanguage", "auto", {
    serialize: String,
    deserialize: String,
  });

  const [uiLanguage, setUiLanguageLocal] = useLocalStorage("uiLanguage", initialUiLanguage, {
    serialize: String,
    deserialize: (value) => normalizeUiLanguage(value),
  });
  const [useLocalStreaming, setUseLocalStreaming] = useLocalStorage("useLocalStreaming", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });
  const [localStreamingModelId] = useLocalStorage(
    "localStreamingModelId",
    getDefaultLocalStreamingModelIdForLocale(initialUiLanguage),
    {
      serialize: String,
      deserialize: String,
    }
  );
  const [modelStorageRoot, setModelStorageRootLocal] = useLocalStorage("modelStorageRoot", "", {
    serialize: String,
    deserialize: String,
  });
  const hasRunUiLanguageSync = useRef(false);
  const [isUiLanguageSyncReady, setIsUiLanguageSyncReady] = useState(false);
  const latestUiLanguageRef = useRef(uiLanguage);
  const userSelectedUiLanguageRef = useRef(false);

  const setUiLanguage = useCallback(
    async (language: string) => {
      const normalized = normalizeUiLanguage(language);
      latestUiLanguageRef.current = normalized;
      userSelectedUiLanguageRef.current = true;
      setUiLanguageLocal(normalized);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("uiLanguage", normalized);
      }
      await i18n.changeLanguage(normalized);
      if (typeof window !== "undefined" && window.electronAPI?.setUiLanguage) {
        await window.electronAPI.setUiLanguage(normalized);
      }
    },
    [setUiLanguageLocal]
  );
  const setModelStorageRoot = useCallback(
    async (rootPath: string): Promise<ModelStorageRootSaveResult> => {
      const requestedRoot = String(rootPath || "").trim();
      const saveRoot = window.electronAPI?.saveModelStorageRoot;
      if (!saveRoot) {
        setModelStorageRootLocal(requestedRoot);
        return {
          success: true,
          root: requestedRoot,
          effectiveRoot: requestedRoot,
          migratedServices: [],
          cleanupWarnings: [],
        };
      }

      const result = await saveRoot(requestedRoot);
      if (!result?.success) {
        throw new Error(result?.error || "Failed to migrate model storage");
      }
      const committedRoot = String(result.root || "").trim();
      setModelStorageRootLocal(committedRoot);
      return result;
    },
    [setModelStorageRootLocal]
  );

  useEffect(() => {
    latestUiLanguageRef.current = uiLanguage;
  }, [uiLanguage]);

  useEffect(() => {
    if (hasRunUiLanguageSync.current) return;
    hasRunUiLanguageSync.current = true;

    const sync = async () => {
      let resolved = normalizeUiLanguage(latestUiLanguageRef.current);

      if (typeof window !== "undefined" && window.electronAPI?.getUiLanguage) {
        const envLanguage = await window.electronAPI.getUiLanguage();
        const currentLocal = normalizeUiLanguage(latestUiLanguageRef.current);
        const normalizedEnv = normalizeUiLanguage(envLanguage || resolved);
        resolved = userSelectedUiLanguageRef.current
          ? currentLocal
          : currentLocal !== normalizedEnv
            ? currentLocal
            : normalizedEnv;
      }

      if (resolved !== latestUiLanguageRef.current) {
        setUiLanguageLocal(resolved);
      }

      await i18n.changeLanguage(resolved);
      setIsUiLanguageSyncReady(true);
    };

    sync().catch((err) => {
      logger.warn(
        "Failed to sync UI language on startup",
        { error: (err as Error).message },
        "settings"
      );
      setIsUiLanguageSyncReady(true);
      void i18n.changeLanguage(normalizeUiLanguage(latestUiLanguageRef.current));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isUiLanguageSyncReady) return;

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
  }, [isUiLanguageSyncReady, uiLanguage]);

  useEffect(() => {
    if (typeof window === "undefined" || !isUiLanguageSyncReady) return;
    const hasCompletedOnboarding =
      window.localStorage.getItem("onboardingCompleted") === "true" ||
      window.localStorage.getItem("hasCompletedOnboarding") === "true";
    if (hasCompletedOnboarding) return;

    const normalized = normalizeUiLanguage(uiLanguage);
    const appliedLanguage = window.localStorage.getItem("localTranscriptionDefaultsLanguage");
    if (appliedLanguage === normalized) return;

    const profile = getDefaultLocalTranscriptionProfile(normalized);
    if (profile.provider === "whisper") return;

    setLocalTranscriptionProvider(profile.provider);

    if (profile.parakeetModel) {
      setParakeetModel(profile.parakeetModel);
    }

    if (profile.paraformerModel) {
      setParaformerModel(profile.paraformerModel);
    }

    setUseLocalWhisper(true);
    setUseLocalStreaming(false);
    window.localStorage.setItem("localTranscriptionDefaultsLanguage", normalized);
  }, [
    isUiLanguageSyncReady,
    setLocalTranscriptionProvider,
    setParakeetModel,
    setParaformerModel,
    setUseLocalWhisper,
    setUseLocalStreaming,
    uiLanguage,
  ]);

  const hasRunModelStorageRootSync = useRef(false);

  useEffect(() => {
    if (hasRunModelStorageRootSync.current) return;
    hasRunModelStorageRootSync.current = true;

    const sync = async () => {
      if (typeof window === "undefined" || !window.electronAPI?.getModelStorageRoot) {
        return;
      }

      const envRoot = String((await window.electronAPI.getModelStorageRoot()) || "").trim();
      if (envRoot && envRoot !== modelStorageRoot) {
        setModelStorageRootLocal(envRoot);
      }
    };

    sync().catch((err) => {
      logger.warn(
        "Failed to sync model storage root on startup",
        { error: (err as Error).message },
        "settings"
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const [cloudTranscriptionProvider, setCloudTranscriptionProviderRaw] = useLocalStorage(
    "cloudTranscriptionProvider",
    "openai",
    {
      serialize: String,
      deserialize: (value) =>
        normalizeAvailableCloudProvider(
          value === "mistral" ? "doubao" : String(value),
          getConfiguredTranscriptionByokProvider(localStorage) || "openai"
        ),
    }
  );

  const setCloudTranscriptionProvider = useCallback(
    (value: string) => {
      setCloudTranscriptionProviderRaw(
        normalizeAvailableCloudProvider(
          value,
          getConfiguredTranscriptionByokProvider(localStorage) || "openai"
        )
      );
    },
    [setCloudTranscriptionProviderRaw]
  );

  const [cloudTranscriptionModel, setCloudTranscriptionModel] = useLocalStorage(
    "cloudTranscriptionModel",
    "gpt-4o-mini-transcribe",
    {
      serialize: String,
      deserialize: (value) =>
        value === "voxtral-mini-latest" ? "doubao-seedasr-streaming-2.0" : String(value),
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

  const [customReasoningProtocol, setCustomReasoningProtocol] =
    useLocalStorage<CustomReasoningProtocol>("customReasoningProtocol", "auto", {
      serialize: String,
      deserialize: normalizeCustomReasoningProtocol,
    });

  const [cloudTranscriptionMode, setCloudTranscriptionModeRaw] = useLocalStorage(
    "cloudTranscriptionMode",
    "byok",
    {
      serialize: String,
      deserialize: (value) => normalizeAvailableCloudMode(value, "byok"),
    }
  );

  const [cloudReasoningMode, setCloudReasoningModeRaw] = useLocalStorage(
    "cloudReasoningMode",
    DEFAULT_CLOUD_REASONING_MODE,
    {
      serialize: String,
      deserialize: (value) => normalizeAvailableCloudMode(value, DEFAULT_CLOUD_REASONING_MODE),
    }
  );

  const setCloudTranscriptionMode = useCallback(
    (value: string) => {
      setCloudTranscriptionModeRaw(normalizeAvailableCloudMode(value, "byok"));
    },
    [setCloudTranscriptionModeRaw]
  );

  const setCloudReasoningMode = useCallback(
    (value: string) => {
      setCloudReasoningModeRaw(normalizeAvailableCloudMode(value, DEFAULT_CLOUD_REASONING_MODE));
    },
    [setCloudReasoningModeRaw]
  );

  const hadStoredCustomDictionaryOnLoad = useRef(
    typeof window !== "undefined" && window.localStorage.getItem("customDictionary") !== null
  );

  // Custom dictionary for improving transcription of specific words
  const [customDictionary, setCustomDictionaryRaw] = useLocalStorage<string[]>(
    "customDictionary",
    [...DEFAULT_CUSTOM_DICTIONARY],
    {
      serialize: JSON.stringify,
      deserialize: (value) => {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed)
            ? normalizeDictionaryWords(parsed)
            : [...DEFAULT_CUSTOM_DICTIONARY];
        } catch {
          return [...DEFAULT_CUSTOM_DICTIONARY];
        }
      },
    }
  );
  const confirmedCustomDictionaryRef = useRef(customDictionary);
  const dictionaryMutationVersionRef = useRef(0);
  const dictionarySyncQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Assembly AI real-time streaming (enabled by default for signed-in users)
  const [assemblyAiStreaming, setAssemblyAiStreaming] = useLocalStorage(
    "assemblyAiStreaming",
    true,
    {
      serialize: String,
      deserialize: (value) => value !== "false", // Default to true unless explicitly disabled
    }
  );

  // Wrap setter to sync dictionary to SQLite
  const setCustomDictionary = useCallback(
    (words: string[]): Promise<boolean> => {
      const normalizedWords = normalizeDictionaryWords(words);
      const mutationVersion = ++dictionaryMutationVersionRef.current;
      setCustomDictionaryRaw(normalizedWords);
      const operation = dictionarySyncQueueRef.current.then(async () => {
        try {
          const setDictionary = window.electronAPI?.setDictionary;
          if (setDictionary) {
            const result = await setDictionary(normalizedWords);
            if (!result?.success) {
              throw new Error("SQLite rejected the dictionary update");
            }
          }
          confirmedCustomDictionaryRef.current = normalizedWords;
          return true;
        } catch (err) {
          logger.warn(
            "Failed to sync dictionary to SQLite",
            { error: (err as Error).message },
            "settings"
          );
          if (dictionaryMutationVersionRef.current === mutationVersion) {
            setCustomDictionaryRaw(confirmedCustomDictionaryRef.current);
          }
          return false;
        }
      });
      dictionarySyncQueueRef.current = operation.then(() => undefined);
      return operation;
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
      const mutationVersionAtStart = dictionaryMutationVersionRef.current;
      const dbWords = normalizeDictionaryWords(await window.electronAPI.getDictionary());
      const localWords = normalizeDictionaryWords(customDictionary);

      const operation = dictionarySyncQueueRef.current.then(async () => {
        // A user edit made while the startup query was in flight is newer than
        // this snapshot. Its queued mutation owns the final state.
        if (dictionaryMutationVersionRef.current !== mutationVersionAtStart) {
          return;
        }

        try {
          if (dbWords.length === 0 && localWords.length > 0) {
            // Seed SQLite from localStorage (first-time migration)
            const result = await window.electronAPI?.setDictionary?.(localWords);
            if (!result?.success) {
              throw new Error("SQLite rejected the initial dictionary sync");
            }
            confirmedCustomDictionaryRef.current = localWords;
          } else if (
            dbWords.length > 0 &&
            (!hadStoredCustomDictionaryOnLoad.current || localWords.length === 0)
          ) {
            // Recover localStorage from SQLite (e.g. localStorage was cleared)
            confirmedCustomDictionaryRef.current = dbWords;
            setCustomDictionaryRaw(dbWords);
          } else {
            confirmedCustomDictionaryRef.current = localWords;
          }
        } catch (err) {
          logger.warn(
            "Failed to sync dictionary on startup",
            { error: (err as Error).message },
            "settings"
          );
        }
      });
      dictionarySyncQueueRef.current = operation.then(() => undefined);
      await operation;
    };

    void syncDictionary()
      .catch((err) => {
        logger.warn(
          "Failed to read dictionary on startup",
          { error: (err as Error).message },
          "settings"
        );
      })
      .then(async () => {
        // Drain any user mutation that joined while the startup query was in
        // flight before the legacy agent-name reconciliation runs.
        let pendingQueue: Promise<void>;
        do {
          pendingQueue = dictionarySyncQueueRef.current;
          await pendingQueue;
        } while (pendingQueue !== dictionarySyncQueueRef.current);
        ensureAgentNameInDictionary();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reasoning settings
  const [useReasoningModel, setUseReasoningModel] = useLocalStorage("useReasoningModel", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const syncReasoningSettingFromStorage = () => {
      setUseReasoningModel(window.localStorage.getItem("useReasoningModel") === "true");
    };
    const handleReasoningSettingChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ useReasoningModel?: unknown }>).detail;
      if (typeof detail?.useReasoningModel === "boolean") {
        setUseReasoningModel(detail.useReasoningModel);
      }
    };
    const handleStorageChanged = (event: StorageEvent) => {
      if (event.key === "useReasoningModel" || event.key === null) {
        syncReasoningSettingFromStorage();
      }
    };

    // The preview-limit auto-disable runs in the floating dictation window and
    // its CustomEvent never leaves that window. Cross-window `storage` events
    // are not guaranteed to be delivered between Electron BrowserWindows, so
    // also re-read localStorage whenever this window becomes focused/visible -
    // otherwise the settings toggle can keep showing the stale pre-limit state.
    const handleWindowFocus = () => syncReasoningSettingFromStorage();
    const handleVisibilityChanged = () => {
      if (document.visibilityState === "visible") {
        syncReasoningSettingFromStorage();
      }
    };

    window.addEventListener(REASONING_MODEL_SETTING_CHANGED_EVENT, handleReasoningSettingChanged);
    window.addEventListener("storage", handleStorageChanged);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChanged);
    return () => {
      window.removeEventListener(
        REASONING_MODEL_SETTING_CHANGED_EVENT,
        handleReasoningSettingChanged
      );
      window.removeEventListener("storage", handleStorageChanged);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChanged);
    };
  }, [setUseReasoningModel]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    let restoreTimer: number | undefined;
    const restoreIfPreviewQuotaReset = () => {
      if (restoreReasoningModelAfterPreviewReset()) {
        setUseReasoningModel(true);
      }
    };
    const restoreWhenVisible = () => {
      if (document.visibilityState === "visible") {
        restoreIfPreviewQuotaReset();
      }
    };
    const scheduleNextLocalDayCheck = () => {
      const now = new Date();
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      restoreTimer = window.setTimeout(
        () => {
          restoreIfPreviewQuotaReset();
          scheduleNextLocalDayCheck();
        },
        Math.max(1000, nextDay.getTime() - now.getTime())
      );
    };

    restoreIfPreviewQuotaReset();
    scheduleNextLocalDayCheck();
    window.addEventListener("focus", restoreIfPreviewQuotaReset);
    window.addEventListener("pageshow", restoreIfPreviewQuotaReset);
    document.addEventListener("visibilitychange", restoreWhenVisible);

    return () => {
      if (restoreTimer !== undefined) {
        window.clearTimeout(restoreTimer);
      }
      window.removeEventListener("focus", restoreIfPreviewQuotaReset);
      window.removeEventListener("pageshow", restoreIfPreviewQuotaReset);
      document.removeEventListener("visibilitychange", restoreWhenVisible);
    };
  }, [setUseReasoningModel]);

  const [reasoningModel, setReasoningModel] = useLocalStorage("reasoningModel", "", {
    serialize: String,
    deserialize: String,
  });

  const [reasoningProvider, setReasoningProviderRaw] = useLocalStorage(
    "reasoningProvider",
    "openai",
    {
      serialize: String,
      deserialize: (value) =>
        normalizeAvailableCloudProvider(
          value,
          getConfiguredReasoningByokProvider(localStorage) || "openai"
        ),
    }
  );

  const setReasoningProvider = useCallback(
    (value: string) => {
      setReasoningProviderRaw(
        normalizeAvailableCloudProvider(
          value,
          getConfiguredReasoningByokProvider(localStorage) || "openai"
        )
      );
    },
    [setReasoningProviderRaw]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isLocalReasoningProviderId(reasoningProvider)) return;

    const localProvider = reasoningProvider.trim().toLowerCase();
    window.localStorage.setItem(LOCAL_REASONING_PROVIDER_STORAGE_KEY, localProvider);
    setReasoningProvider("local");
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

  const [cerebrasApiKey, setCerebrasApiKeyLocal] = useLocalStorage("cerebrasApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [sonioxApiKey, setSonioxApiKeyLocal] = useLocalStorage("sonioxApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [deepgramApiKey, setDeepgramApiKeyLocal] = useLocalStorage("deepgramApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [googleSttApiKey, setGoogleSttApiKeyLocal] = useLocalStorage("googleSttApiKey", "", {
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

  useEffect(() => {
    if (typeof window !== "undefined" && window.electronAPI?.reportTelemetrySettings) {
      window.electronAPI.reportTelemetrySettings(telemetryEnabled);
    }
    try {
      const client = SentryRenderer.getClient();
      if (client) {
        client.getOptions().enabled = telemetryEnabled;
      }
    } catch (e) {
      // Ignore if Sentry is not initialized yet
    }
  }, [telemetryEnabled]);

  const [transcriptionHistoryEnabled, setTranscriptionHistoryEnabled] = useLocalStorage(
    "transcriptionHistoryEnabled",
    true,
    {
      serialize: String,
      deserialize: (value) => value !== "false",
    }
  );

  const [fileTranscriptionCompletionAlertEnabled, setFileTranscriptionCompletionAlertEnabled] =
    useLocalStorage("fileTranscriptionCompletionAlertEnabled", true, {
      serialize: String,
      deserialize: (value) => value !== "false",
    });

  const [tailCommandsEnabled, setTailCommandsEnabled] = useLocalStorage(
    "tailCommandsEnabled",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  const [pasteConfirmEnabled, setPasteConfirmEnabled] = useLocalStorage(
    "pasteConfirmEnabled",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  const [pasteConfirmThreshold, setPasteConfirmThreshold] = useLocalStorage(
    "pasteConfirmThreshold",
    300,
    {
      serialize: String,
      deserialize: (value) => {
        const num = Number(value);
        return Number.isNaN(num) ? 300 : num;
      },
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

      // Startup sync must not trigger macOS Keychain prompts. Encrypted secrets
      // are read lazily when the user actually uses or edits an API-backed feature.
      const keychainColdRead = { allowKeychain: false };

      // Only sync keys that are missing from localStorage
      if (!openaiApiKey) {
        const envKey = await window.electronAPI.getOpenAIKey?.(keychainColdRead);
        if (envKey) setOpenaiApiKeyLocal(envKey);
      }
      if (!anthropicApiKey) {
        const envKey = await window.electronAPI.getAnthropicKey?.(keychainColdRead);
        if (envKey) setAnthropicApiKeyLocal(envKey);
      }
      if (!openrouterApiKey) {
        const envKey = await window.electronAPI.getOpenRouterKey?.(keychainColdRead);
        if (envKey) setOpenrouterApiKeyLocal(envKey);
      }
      if (!geminiApiKey) {
        const envKey = await window.electronAPI.getGeminiKey?.(keychainColdRead);
        if (envKey) setGeminiApiKeyLocal(envKey);
      }
      if (!groqApiKey) {
        const envKey = await window.electronAPI.getGroqKey?.(keychainColdRead);
        if (envKey) setGroqApiKeyLocal(envKey);
      }
      if (!cerebrasApiKey) {
        const envKey = await window.electronAPI.getCerebrasKey?.(keychainColdRead);
        if (envKey) setCerebrasApiKeyLocal(envKey);
      }
      if (!sonioxApiKey) {
        const envKey = await window.electronAPI.getSonioxKey?.(keychainColdRead);
        if (envKey) setSonioxApiKeyLocal(envKey);
      }
      if (!deepgramApiKey) {
        const envKey = await window.electronAPI.getDeepgramKey?.(keychainColdRead);
        if (envKey) setDeepgramApiKeyLocal(envKey);
      }
      if (!googleSttApiKey) {
        const envKey = await window.electronAPI.getGoogleSttKey?.(keychainColdRead);
        if (envKey) setGoogleSttApiKeyLocal(envKey);
      }
      if (!doubaoAppId) {
        const envAppId = await window.electronAPI.getDoubaoAppId?.();
        if (envAppId) setDoubaoAppIdLocal(envAppId);
      }
      if (!doubaoAccessToken) {
        const envToken = await window.electronAPI.getDoubaoAccessToken?.(keychainColdRead);
        if (envToken) setDoubaoAccessTokenLocal(envToken);
      }
      if (!customTranscriptionApiKey) {
        const envKey = await window.electronAPI.getCustomTranscriptionKey?.(keychainColdRead);
        if (envKey) setCustomTranscriptionApiKeyLocal(envKey);
      }
      if (!customReasoningApiKey) {
        const envKey = await window.electronAPI.getCustomReasoningKey?.(keychainColdRead);
        if (envKey) setCustomReasoningApiKeyLocal(envKey);
      }
      if (!graniteRuntimeApiKey) {
        const envKey = await window.electronAPI.getGraniteRuntimeApiKey?.(keychainColdRead);
        if (envKey) setGraniteRuntimeApiKeyLocal(envKey);
      }
      if (!cohereRuntimeApiKey) {
        const envKey = await window.electronAPI.getCohereRuntimeApiKey?.(keychainColdRead);
        if (envKey) setCohereRuntimeApiKeyLocal(envKey);
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
      provider?: "openai" | "openrouter" | "anthropic" | "gemini" | "groq" | "cerebras" | "custom"
    ) => {
      if (provider) {
        ReasoningService.clearApiKeyCache(provider);
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

  const setCerebrasApiKey = useCallback(
    (key: string) => {
      setCerebrasApiKeyLocal(key);
      window.electronAPI?.saveCerebrasKey?.(key);
      invalidateApiKeyCaches("cerebras");
    },
    [setCerebrasApiKeyLocal, invalidateApiKeyCaches]
  );

  const setSonioxApiKey = useCallback(
    (key: string) => {
      setSonioxApiKeyLocal(key);
      window.electronAPI?.saveSonioxKey?.(key);
      invalidateApiKeyCaches();
    },
    [setSonioxApiKeyLocal, invalidateApiKeyCaches]
  );

  const setDeepgramApiKey = useCallback(
    (key: string) => {
      setDeepgramApiKeyLocal(key);
      window.electronAPI?.saveDeepgramKey?.(key);
      invalidateApiKeyCaches();
    },
    [setDeepgramApiKeyLocal, invalidateApiKeyCaches]
  );

  const setGoogleSttApiKey = useCallback(
    (key: string) => {
      setGoogleSttApiKeyLocal(key);
      window.electronAPI?.saveGoogleSttKey?.(key);
      invalidateApiKeyCaches();
    },
    [setGoogleSttApiKeyLocal, invalidateApiKeyCaches]
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

  const setGraniteRuntimeApiKey = useCallback(
    (key: string) => {
      setGraniteRuntimeApiKeyLocal(key);
      window.electronAPI?.saveGraniteRuntimeApiKey?.(key);
      invalidateApiKeyCaches();
    },
    [invalidateApiKeyCaches, setGraniteRuntimeApiKeyLocal]
  );

  const setCohereRuntimeApiKey = useCallback(
    (key: string) => {
      setCohereRuntimeApiKeyLocal(key);
      window.electronAPI?.saveCohereRuntimeApiKey?.(key);
      invalidateApiKeyCaches();
    },
    [invalidateApiKeyCaches, setCohereRuntimeApiKeyLocal]
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

  const [secondaryHotkeyProfile, setSecondaryHotkeyProfileRaw] =
    useLocalStorage<SecondaryHotkeyProfile | null>("secondaryHotkeyProfile", null, {
      serialize: JSON.stringify,
      deserialize: (value) => {
        if (!value) return null;
        try {
          const parsed = JSON.parse(value);
          if (!parsed || typeof parsed !== "object") return null;
          return {
            useLocalWhisper: parsed.useLocalWhisper !== false,
            ...(typeof parsed.useLocalStreaming === "boolean"
              ? { useLocalStreaming: parsed.useLocalStreaming }
              : {}),
            ...(typeof parsed.localStreamingModelId === "string"
              ? {
                  localStreamingModelId: normalizeStreamingModelId(
                    parsed.localStreamingModelId,
                    getDefaultLocalStreamingModelIdForLocale(uiLanguage)
                  ),
                }
              : {}),
            localTranscriptionProvider: normalizeLocalTranscriptionProvider(
              String(parsed.localTranscriptionProvider || "")
            ),
            whisperModel:
              typeof parsed.whisperModel === "string"
                ? normalizeWhisperModelId(parsed.whisperModel)
                : DEFAULT_WHISPER_MODEL_ID,
            parakeetModel: typeof parsed.parakeetModel === "string" ? parsed.parakeetModel : "",
            paraformerModel:
              typeof parsed.paraformerModel === "string"
                ? parsed.paraformerModel
                : "paraformer-large-zh",
            graniteModel:
              typeof parsed.graniteModel === "string"
                ? parsed.graniteModel
                : "granite-4.0-1b-speech",
            cohereModel:
              typeof parsed.cohereModel === "string"
                ? parsed.cohereModel
                : "cohere-transcribe-03-2026",
            graniteRuntimeUrl:
              typeof parsed.graniteRuntimeUrl === "string" ? parsed.graniteRuntimeUrl : "",
            graniteRuntimeApiKey:
              typeof parsed.graniteRuntimeApiKey === "string" ? parsed.graniteRuntimeApiKey : "",
            cohereRuntimeUrl:
              typeof parsed.cohereRuntimeUrl === "string" ? parsed.cohereRuntimeUrl : "",
            cohereRuntimeApiKey:
              typeof parsed.cohereRuntimeApiKey === "string" ? parsed.cohereRuntimeApiKey : "",
            allowOpenAIFallback: parsed.allowOpenAIFallback === true,
            allowLocalFallback: parsed.allowLocalFallback === true,
            fallbackWhisperModel:
              typeof parsed.fallbackWhisperModel === "string"
                ? normalizeWhisperModelId(parsed.fallbackWhisperModel)
                : DEFAULT_WHISPER_MODEL_ID,
            preferredLanguage:
              typeof parsed.preferredLanguage === "string" ? parsed.preferredLanguage : "auto",
            cloudTranscriptionMode:
              typeof parsed.cloudTranscriptionMode === "string"
                ? normalizeAvailableCloudMode(parsed.cloudTranscriptionMode, "byok")
                : "byok",
            cloudTranscriptionProvider:
              typeof parsed.cloudTranscriptionProvider === "string"
                ? normalizeAvailableCloudProvider(
                    parsed.cloudTranscriptionProvider,
                    getConfiguredTranscriptionByokProvider(localStorage) || "openai"
                  )
                : "openai",
            cloudTranscriptionModel:
              typeof parsed.cloudTranscriptionModel === "string"
                ? parsed.cloudTranscriptionModel
                : "gpt-4o-mini-transcribe",
            cloudTranscriptionBaseUrl:
              typeof parsed.cloudTranscriptionBaseUrl === "string"
                ? parsed.cloudTranscriptionBaseUrl
                : API_ENDPOINTS.TRANSCRIPTION_BASE,
            useReasoningModel: parsed.useReasoningModel === true,
            reasoningModel: typeof parsed.reasoningModel === "string" ? parsed.reasoningModel : "",
            reasoningProvider:
              typeof parsed.reasoningProvider === "string"
                ? normalizeAvailableCloudProvider(
                    parsed.reasoningProvider,
                    getConfiguredReasoningByokProvider(localStorage) || "openai"
                  )
                : "openai",
            customReasoningProtocol: normalizeCustomReasoningProtocol(
              parsed.customReasoningProtocol
            ),
            cloudReasoningMode:
              typeof parsed.cloudReasoningMode === "string"
                ? normalizeAvailableCloudMode(
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

  const currentLocalStreamingModelId = normalizeStreamingModelId(
    localStreamingModelId,
    getDefaultLocalStreamingModelIdForLocale(uiLanguage)
  );

  const currentHotkeyProfile = useMemo<SecondaryHotkeyProfile>(
    () => ({
      useLocalWhisper,
      useLocalStreaming,
      localStreamingModelId: currentLocalStreamingModelId,
      localTranscriptionProvider,
      whisperModel,
      parakeetModel,
      paraformerModel,
      graniteModel,
      cohereModel,
      graniteRuntimeUrl,
      graniteRuntimeApiKey,
      cohereRuntimeUrl,
      cohereRuntimeApiKey,
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
    }),
    [
      useLocalWhisper,
      useLocalStreaming,
      currentLocalStreamingModelId,
      localTranscriptionProvider,
      whisperModel,
      parakeetModel,
      paraformerModel,
      graniteModel,
      cohereModel,
      graniteRuntimeUrl,
      graniteRuntimeApiKey,
      cohereRuntimeUrl,
      cohereRuntimeApiKey,
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
    ]
  );

  const legacyWorkflowDefault: HotkeyWorkflow[] = dictationKeySecondary.trim()
    ? [
        {
          id: "secondary",
          name: "",
          hotkey: dictationKeySecondary.trim(),
          action: "dictate",
          targetLanguage: "en",
          enabled: true,
          profile: secondaryHotkeyProfile || currentHotkeyProfile,
        },
      ]
    : [];
  const [hotkeyWorkflows, setHotkeyWorkflowsRaw] = useLocalStorage<HotkeyWorkflow[]>(
    HOTKEY_WORKFLOWS_STORAGE_KEY,
    legacyWorkflowDefault,
    {
      serialize: JSON.stringify,
      deserialize: (raw) => {
        try {
          return normalizeHotkeyWorkflows(JSON.parse(raw));
        } catch {
          return [];
        }
      },
    }
  );

  const setHotkeyWorkflows = useCallback(
    (workflows: HotkeyWorkflow[]) => {
      const normalized = normalizeHotkeyWorkflows(workflows);
      const serialized = JSON.stringify(normalized);
      if (!writeLocalStorageValue(HOTKEY_WORKFLOWS_STORAGE_KEY, serialized)) {
        throw new Error("Hotkey workflows could not be saved.");
      }
      setHotkeyWorkflowsRaw(normalized);
      return normalized;
    },
    [setHotkeyWorkflowsRaw]
  );

  const captureSecondaryHotkeyProfileFromCurrent = useCallback(() => {
    setSecondaryHotkeyProfileRaw(currentHotkeyProfile);
    return currentHotkeyProfile;
  }, [currentHotkeyProfile, setSecondaryHotkeyProfileRaw]);

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
    "droplet1",
    {
      serialize: String,
      deserialize: (value) =>
        value === "off" || value === "electronic" || value === "droplet1" || value === "droplet2"
          ? value
          : "droplet1",
    }
  );

  const [recordingAnimationStyle, setRecordingAnimationStyleLocal] =
    useLocalStorage<RecordingAnimationStyle>(
      "recordingAnimationStyle",
      DEFAULT_RECORDING_ANIMATION_STYLE,
      {
        serialize: String,
        deserialize: normalizeRecordingAnimationStyle,
      }
    );

  useEffect(() => {
    const stored = localStorage.getItem("recordingAnimationStyle");
    const normalized = normalizeRecordingAnimationStyle(stored);
    if (stored !== normalized) {
      setRecordingAnimationStyleLocal(normalized);
    }
  }, [setRecordingAnimationStyleLocal]);

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
    let externalRuntimeUrl = "";
    if (localTranscriptionProvider === "nvidia") {
      model = parakeetModel;
    } else if (localTranscriptionProvider === "paraformer") {
      model = paraformerModel;
    } else if (localTranscriptionProvider === "granite") {
      model = graniteModel;
      externalRuntimeUrl = graniteRuntimeUrl;
    } else if (localTranscriptionProvider === "cohere") {
      model = cohereModel;
      externalRuntimeUrl = cohereRuntimeUrl;
    }

    const effectiveReasoningProvider = isLocalReasoningProviderId(reasoningProvider)
      ? "local"
      : reasoningProvider;

    window.electronAPI
      .syncStartupPreferences({
        useLocalWhisper,
        localTranscriptionProvider,
        model: model || undefined,
        externalRuntimeUrl: externalRuntimeUrl.trim() || undefined,
        reasoningProvider: effectiveReasoningProvider,
        reasoningModel: effectiveReasoningProvider === "local" ? reasoningModel : undefined,
      })
      .catch((err) =>
        logger.warn(
          "Failed to sync startup preferences",
          { error: (err as Error).message },
          "settings"
        )
      );

    // Trigger main-side pre-warm with the renderer's real provider/model.
    // syncStartupPreferences only updates env for next launch; this hits the
    // already-running managers so first-recording latency stays low when the
    // env-based startup guess didn't match the renderer's localStorage choice.
    if (useLocalWhisper) {
      window.electronAPI?.reportTranscriptionSettings?.({
        localTranscriptionProvider,
        whisperModel,
        parakeetModel,
        paraformerModel,
        graniteModel,
        cohereModel,
      });
    }
  }, [
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    paraformerModel,
    graniteModel,
    cohereModel,
    graniteRuntimeUrl,
    cohereRuntimeUrl,
    reasoningProvider,
    reasoningModel,
  ]);

  // Batch operations
  const updateTranscriptionSettings = useCallback(
    (settings: Partial<TranscriptionSettings>) => {
      if (settings.useLocalWhisper !== undefined) setUseLocalWhisper(settings.useLocalWhisper);
      if (settings.uiLanguage !== undefined) setUiLanguage(settings.uiLanguage);
      if (settings.modelStorageRoot !== undefined) {
        void setModelStorageRoot(settings.modelStorageRoot);
      }
      if (settings.whisperModel !== undefined) setWhisperModel(settings.whisperModel);
      if (settings.localTranscriptionProvider !== undefined) {
        setLocalTranscriptionProvider(
          normalizeLocalTranscriptionProvider(String(settings.localTranscriptionProvider))
        );
      }
      if (settings.parakeetModel !== undefined) setParakeetModel(settings.parakeetModel);
      if (settings.paraformerModel !== undefined) setParaformerModel(settings.paraformerModel);
      if (settings.graniteModel !== undefined) setGraniteModel(settings.graniteModel);
      if (settings.cohereModel !== undefined) setCohereModel(settings.cohereModel);
      if (settings.graniteRuntimeUrl !== undefined)
        setGraniteRuntimeUrl(settings.graniteRuntimeUrl);
      if (settings.graniteRuntimeApiKey !== undefined)
        setGraniteRuntimeApiKey(settings.graniteRuntimeApiKey);
      if (settings.cohereRuntimeUrl !== undefined) setCohereRuntimeUrl(settings.cohereRuntimeUrl);
      if (settings.cohereRuntimeApiKey !== undefined)
        setCohereRuntimeApiKey(settings.cohereRuntimeApiKey);
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
      setParaformerModel,
      setGraniteModel,
      setCohereModel,
      setGraniteRuntimeUrl,
      setGraniteRuntimeApiKey,
      setCohereRuntimeUrl,
      setCohereRuntimeApiKey,
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
      if (keys.cerebrasApiKey !== undefined) setCerebrasApiKey(keys.cerebrasApiKey);
      if (keys.sonioxApiKey !== undefined) setSonioxApiKey(keys.sonioxApiKey);
      if (keys.deepgramApiKey !== undefined) setDeepgramApiKey(keys.deepgramApiKey);
      if (keys.googleSttApiKey !== undefined) setGoogleSttApiKey(keys.googleSttApiKey);
      if (keys.doubaoAppId !== undefined) setDoubaoAppId(keys.doubaoAppId);
      if (keys.doubaoAccessToken !== undefined) setDoubaoAccessToken(keys.doubaoAccessToken);
    },
    [
      setOpenaiApiKey,
      setOpenrouterApiKey,
      setAnthropicApiKey,
      setGeminiApiKey,
      setGroqApiKey,
      setCerebrasApiKey,
      setSonioxApiKey,
      setDeepgramApiKey,
      setGoogleSttApiKey,
      setDoubaoAppId,
      setDoubaoAccessToken,
    ]
  );

  return {
    useLocalWhisper,
    whisperModel,
    uiLanguage,
    isUiLanguageSyncReady,
    modelStorageRoot,
    localTranscriptionProvider,
    parakeetModel,
    paraformerModel,
    graniteModel,
    cohereModel,
    graniteRuntimeUrl,
    graniteRuntimeApiKey,
    cohereRuntimeUrl,
    cohereRuntimeApiKey,
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
    cerebrasApiKey,
    sonioxApiKey,
    deepgramApiKey,
    googleSttApiKey,
    doubaoAppId,
    doubaoAccessToken,
    dictationKey,
    dictationKeySecondary,
    secondaryHotkeyProfile,
    hotkeyWorkflows,
    currentHotkeyProfile,
    theme,
    setUseLocalWhisper,
    setWhisperModel,
    setUiLanguage,
    setModelStorageRoot,
    setLocalTranscriptionProvider,
    setParakeetModel,
    setParaformerModel,
    setGraniteModel,
    setCohereModel,
    setGraniteRuntimeUrl,
    setGraniteRuntimeApiKey,
    setCohereRuntimeUrl,
    setCohereRuntimeApiKey,
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
    setCerebrasApiKey,
    setSonioxApiKey,
    setDeepgramApiKey,
    setGoogleSttApiKey,
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
    setHotkeyWorkflows,
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
    fileTranscriptionCompletionAlertEnabled,
    setFileTranscriptionCompletionAlertEnabled,
    tailCommandsEnabled,
    setTailCommandsEnabled,
    pasteConfirmEnabled,
    setPasteConfirmEnabled,
    pasteConfirmThreshold,
    setPasteConfirmThreshold,
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
