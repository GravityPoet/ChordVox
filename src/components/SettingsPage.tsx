import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useSettings, type HotkeyWorkflow } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { useAgentName } from "../utils/agentName";
import { useWhisper } from "../hooks/useWhisper";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useUpdater } from "../hooks/useUpdater";

import PromptStudio from "./ui/PromptStudio";

import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getPlatform } from "../utils/platform";
import CallRecordsSection from "./CallRecordsSection";
import { useToast } from "./ui/toastContext";
import { useTheme } from "../hooks/useTheme";
import type { LicenseStatusResult, LocalTranscriptionProvider } from "../types/electron";
import logger from "../utils/logger";
import { canStartProTrial } from "../utils/proTrial";
import { getReasoningPreviewQuota } from "../utils/reasoningPreviewQuota";
import { dispatchChordVoxModelsCleared } from "../utils/chordvoxCloud";
import { replaceImportedSettingsStorage } from "../utils/settingsTransferStorage";
import {
  DEFAULT_LOCAL_STREAMING_MODEL_ID,
  getDefaultLocalStreamingModelIdForLocale,
  normalizeStreamingModelId,
} from "../utils/streamingModelSelection";
import { isLocalReasoningProviderId } from "../models/ModelRegistry";
import {
  formatDirectoryDisplay,
  getLocalizedLicenseErrorDescription,
  MODIFIER_PARTS,
  resolveModelStorageRoot,
} from "./settings/utils";
import { SectionHeader } from "./settings/shared";
import type { ProAccessResult } from "./settings/types";
import { TranscriptionSection } from "./settings/TranscriptionSection";
import { FileTranscriptionSection } from "./settings/FileTranscriptionSection";
import { AiModelsSection } from "./settings/AiModelsSection";
import { DictionaryManager } from "./settings/DictionaryManager";
import { HotkeysSection } from "./settings/HotkeysSection";
import { PrivacyPermissionsSection } from "./settings/PrivacyPermissionsSection";
import { ContextSettingsSection } from "./settings/ContextSettingsSection";
import { AgentConfigSection } from "./settings/AgentConfigSection";
import { DeveloperDataSection } from "./settings/DeveloperDataSection";
import { AccountSection } from "./settings/AccountSection";
import { GeneralSection } from "./settings/GeneralSection";

const DEFAULT_STREAMING_MODEL_ID = DEFAULT_LOCAL_STREAMING_MODEL_ID;
const ignoreLegacyAccountAction = async () => undefined;
const SETTINGS_TRANSFER_EXCLUDED_KEYS = new Set([
  "chordvox_reasoning_provider_models_cache",
  "chordvox_reasoning_custom_models_cache",
]);
const SETTINGS_TRANSFER_SECRET_KEYS = new Set([
  "anthropicApiKey",
  "bedrockAccessKeyId",
  "bedrockSecretAccessKey",
  "bedrockSessionToken",
  "cohereRuntimeApiKey",
  "customReasoningApiKey",
  "customTranscriptionApiKey",
  "deepgramApiKey",
  "doubaoAccessToken",
  "geminiApiKey",
  "googleSttApiKey",
  "graniteRuntimeApiKey",
  "groqApiKey",
  "cerebrasApiKey",
  "openaiApiKey",
  "openrouterApiKey",
  "sonioxApiKey",
]);
const SETTINGS_TRANSFER_KEY_PATTERN = /^[A-Za-z0-9_:.\-]{1,128}$/;
const SETTINGS_TRANSFER_MAX_VALUE_LENGTH = 64 * 1024;
const SETTINGS_TRANSFER_MAX_ENTRIES = 500;
const isActiveProTrial = (status?: LicenseStatusResult | null) =>
  Boolean(status?.isActive && status?.plan === "trial" && status?.trialActive);
const REASONING_PREVIEW_ACCESS_SOURCES = new Set(["ai-models-toggle"]);
const SETTINGS_TRANSFER_KNOWN_KEYS = new Set([
  "activationMode",
  "anthropicApiKey",
  "cloudReasoningBaseUrl",
  "cloudTranscriptionBaseUrl",
  "cloudTranscriptionModel",
  "cloudTranscriptionProvider",
  "cohereModel",
  "cohereRuntimeApiKey",
  "cohereRuntimeUrl",
  "customDictionary",
  "customReasoningApiKey",
  "customReasoningProtocol",
  "customTranscriptionApiKey",
  "deepgramApiKey",
  "dictationKey",
  "geminiApiKey",
  "googleSttApiKey",
  "graniteModel",
  "graniteRuntimeApiKey",
  "graniteRuntimeUrl",
  "groqApiKey",
  "cerebrasApiKey",
  "hotkeyWorkflowsV1",
  "licenseApiBaseUrl",
  "localTranscriptionProvider",
  "modelStorageRoot",
  "openaiApiKey",
  "openrouterApiKey",
  "paraformerModel",
  "parakeetModel",
  "preferredLanguage",
  "reasoningModel",
  "reasoningProvider",
  "secondaryHotkeyProfile",
  "sonioxApiKey",
  "uiLanguage",
  "useLocalWhisper",
  "useReasoningModel",
  "whisperModel",
]);
const SETTINGS_TRANSFER_ENVIRONMENT_KEYS = [
  "anthropicApiKey",
  "bedrockAccessKeyId",
  "bedrockSecretAccessKey",
  "bedrockSessionToken",
  "cohereRuntimeApiKey",
  "customReasoningApiKey",
  "customTranscriptionApiKey",
  "deepgramApiKey",
  "doubaoAccessToken",
  "doubaoAppId",
  "geminiApiKey",
  "googleSttApiKey",
  "graniteRuntimeApiKey",
  "groqApiKey",
  "cerebrasApiKey",
  "openaiApiKey",
  "openrouterApiKey",
  "sonioxApiKey",
] as const;

type SettingsImportRuntimePayload = {
  dictationKey?: unknown;
  activationMode?: unknown;
  licenseApiBaseUrl?: unknown;
};

type SettingsImportPayload = {
  app?: unknown;
  includesSecrets?: unknown;
  localStorage?: unknown;
  dictionary?: unknown;
  runtime?: unknown;
  [key: string]: unknown;
};

type SettingsImportApplyResult = {
  warnings: string[];
};

function isSettingsImportObject(value: unknown): value is SettingsImportPayload {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSettingsTransferExcludedKey(key: string, includeSecrets = true): boolean {
  return (
    SETTINGS_TRANSFER_EXCLUDED_KEYS.has(key) ||
    (!includeSecrets && SETTINGS_TRANSFER_SECRET_KEYS.has(key)) ||
    key.startsWith("pro-trial-reminder:")
  );
}

function coerceSettingsTransferValue(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function sanitizeSettingsTransferLocalStorage(
  value: unknown,
  options: { includeSecrets?: boolean } = {}
): Record<string, string> {
  if (!isSettingsImportObject(value)) {
    return {};
  }

  const includeSecrets = options.includeSecrets !== false;
  const entries = Object.entries(value);
  const sanitized: Record<string, string> = {};
  let count = 0;

  for (const [key, rawValue] of entries) {
    if (count >= SETTINGS_TRANSFER_MAX_ENTRIES) break;
    if (typeof key !== "string") continue;
    if (isSettingsTransferExcludedKey(key, includeSecrets)) continue;
    if (!SETTINGS_TRANSFER_KEY_PATTERN.test(key)) continue;

    const coerced = coerceSettingsTransferValue(rawValue);
    if (coerced === null) continue;
    if (coerced.length > SETTINGS_TRANSFER_MAX_VALUE_LENGTH) continue;

    sanitized[key] = coerced;
    count += 1;
  }

  return sanitized;
}

function hasImportableSettingsPayload(
  payload: SettingsImportPayload,
  localStorageData: Record<string, string>
): boolean {
  const keys = Object.keys(localStorageData);
  if (keys.length === 0) return false;
  if (isSettingsImportObject(payload.localStorage)) return true;
  if (typeof payload.app === "string" && payload.app.toLowerCase() === "chordvox") return true;
  return keys.some((key) => SETTINGS_TRANSFER_KNOWN_KEYS.has(key));
}

function getSettingsImportRuntime(payload: SettingsImportPayload): SettingsImportRuntimePayload {
  return isSettingsImportObject(payload.runtime)
    ? (payload.runtime as SettingsImportRuntimePayload)
    : {};
}

function normalizeImportedDictionary(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((word): word is string => typeof word === "string")
    .map((word) => word.trim())
    .filter(Boolean);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function getSettingsImportFailureDescription(t: TFunction, error: unknown): string {
  const reason = getErrorMessage(error).trim();
  if (!reason) {
    return t("settingsPage.developer.settingsTransfer.importFailedDescription");
  }
  return t("settingsPage.developer.settingsTransfer.importFailedWithReason", { reason });
}

export type SettingsSectionType =
  | "account"
  | "general"
  | "hotkeys"
  | "transcription"
  | "fileTranscription"
  | "transcriptionHistory"
  | "dictionary"
  | "aiModels"
  | "callRecords"
  | "agentConfig"
  | "prompts"
  | "permissions"
  | "context"
  | "privacy"
  | "developer";

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
  onOpenTranscriptionHistory?: () => void;
  onOpenTranscriptionSettings?: () => void;
  onSectionChange?: (section: SettingsSectionType) => void;
}

const UI_LANGUAGE_OPTIONS: import("./ui/LanguageSelector").LanguageOption[] = [
  { value: "en", label: "English", flag: "🇺🇸" },
  { value: "zh-CN", label: "简体中文", flag: "🇨🇳" },
  { value: "es", label: "Español", flag: "🇪🇸" },
  { value: "fr", label: "Français", flag: "🇫🇷" },
  { value: "de", label: "Deutsch", flag: "🇩🇪" },
  { value: "pt", label: "Português", flag: "🇵🇹" },
  { value: "it", label: "Italiano", flag: "🇮🇹" },
  { value: "ru", label: "Русский", flag: "🇷🇺" },
  { value: "ja", label: "日本語", flag: "🇯🇵" },
  { value: "zh-TW", label: "繁體中文", flag: "🇹🇼" },
];

export default function SettingsPage({
  activeSection = "general",
  onOpenTranscriptionHistory,
  onOpenTranscriptionSettings,
  onSectionChange,
}: SettingsPageProps) {
  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const {
    useLocalWhisper,
    whisperModel,
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
    uiLanguage,
    modelStorageRoot,
    preferredLanguage,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    cloudReasoningBaseUrl,
    customReasoningProtocol,
    customDictionary,
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
    hotkeyWorkflows,
    currentHotkeyProfile,
    activationMode,
    setActivationMode,
    preferBuiltInMic,
    selectedMicDeviceId,
    setPreferBuiltInMic,
    setSelectedMicDeviceId,
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
    setCloudTranscriptionProvider,
    setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl,
    setCloudReasoningBaseUrl,
    setCustomReasoningProtocol,
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
    setHotkeyWorkflows,
    updateTranscriptionSettings,
    updateReasoningSettings,
    cloudTranscriptionMode,
    setCloudTranscriptionMode,
    cloudReasoningMode,
    setCloudReasoningMode,
    audioCuesEnabled,
    setAudioCuesEnabled,
    dictationCueStyle,
    setDictationCueStyle,
    recordingAnimationStyle,
    setRecordingAnimationStyle,
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
  } = useSettings();

  const { t, i18n } = useTranslation();
  const { toast } = useToast();

  const selectedCueStyleValue = audioCuesEnabled ? dictationCueStyle : "off";
  const handleDictationCueStyleChange = useCallback(
    (value: string) => {
      const normalized =
        value === "off" || value === "droplet1" || value === "droplet2" ? value : "electronic";
      setDictationCueStyle(normalized);
      setAudioCuesEnabled(normalized !== "off");
    },
    [setAudioCuesEnabled, setDictationCueStyle]
  );

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [isRemovingModels, setIsRemovingModels] = useState(false);
  const scheduleApplicationRestart = useCallback((delayMs = 800) => {
    window.setTimeout(() => {
      void (async () => {
        try {
          const result = await window.electronAPI?.restartApp?.();
          if (result?.success) return;
        } catch {
          // Fall back to a renderer reload on older or partially broken builds.
        }
        window.location.reload();
      })();
    }, delayMs);
  }, []);
  const legacyStreamingModelsDir =
    typeof window !== "undefined" ? localStorage.getItem("localStreamingModelsDir") || "" : "";
  const effectiveModelCacheRoot = resolveModelStorageRoot(
    modelStorageRoot,
    legacyStreamingModelsDir
  );
  const cachePathHint = formatDirectoryDisplay(effectiveModelCacheRoot);

  const {
    status: updateStatus,
    info: updateInfo,
    downloadProgress: updateDownloadProgress,
    isChecking: checkingForUpdates,
    isDownloading: downloadingUpdate,
    isInstalling: installInitiated,
    checkForUpdates,
    downloadUpdate,
    installUpdate: installUpdateAction,
    getAppVersion,
  } = useUpdater();

  const isUpdateAvailable =
    !updateStatus.isDevelopment && (updateStatus.updateAvailable || updateStatus.updateDownloaded);
  const manualUpdateUrl =
    updateInfo && updateInfo.manualOnly && updateInfo.manualDownloadUrl
      ? updateInfo.manualDownloadUrl
      : "";
  const isManualUpdate = Boolean(manualUpdateUrl);
  const formattedUpdateLastCheckedAt = updateStatus.lastCheckedAt
    ? new Date(updateStatus.lastCheckedAt).toLocaleString(i18n.language || undefined)
    : "";

  const whisperHook = useWhisper();
  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog);
  const { agentName, setAgentName } = useAgentName();
  const [agentNameInput, setAgentNameInput] = useState(agentName);
  const { theme, setTheme } = useTheme();
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatusResult | null>(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState("");
  const [licenseValidationFeedback, setLicenseValidationFeedback] = useState<{
    ok: boolean;
    title: string;
    description: string;
    at: number;
  } | null>(null);
  const [licenseBusyAction, setLicenseBusyAction] = useState<
    "activate" | "validate" | "clear" | null
  >(null);
  const [showLicenseKeyInput, setShowLicenseKeyInput] = useState(false);
  const hasProAccess = licenseStatus ? Boolean(licenseStatus.isActive) : true;
  const isSecondaryHotkeyLocked = Boolean(licenseStatus) && !hasProAccess;
  const refreshLicenseStatus = useCallback(async () => {
    if (!window.electronAPI?.licenseGetStatus) return;
    try {
      const result = await window.electronAPI.licenseGetStatus({ allowKeychain: false });
      setLicenseStatus(result);
    } catch (error) {
      logger.error("Failed to load license status", error, "license");
    }
  }, []);

  useEffect(() => {
    refreshLicenseStatus();
  }, [refreshLicenseStatus]);

  const trialOfferAvailable = canStartProTrial(licenseStatus);

  const openLicensePurchasePage = useCallback(
    async (source: string, extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({
        source,
        lang: i18n.language || "en",
        ...extra,
      });
      const result = await window.electronAPI?.openExternal?.(
        `https://chordvox.com/?${params.toString()}#pricing-plans`
      );
      if (result && result.success === false) {
        showAlertDialog({
          title: t("settingsPage.account.checkout.couldNotOpenTitle"),
          description: t("settingsPage.account.checkout.couldNotOpenDescription"),
        });
      }
    },
    [i18n.language, showAlertDialog, t]
  );

  const ensureProAccessWithTrialPrompt = useCallback(
    async (source: string): Promise<ProAccessResult> => {
      if (!window.electronAPI?.licenseEnsureProAccess && !window.electronAPI?.licenseGetStatus) {
        return { allowed: false, declinedTrial: false, status: null };
      }

      let currentStatus: LicenseStatusResult | null = null;
      const canUseReasoningPreview = REASONING_PREVIEW_ACCESS_SOURCES.has(source);
      const buildPreviewLimitStatus = (
        status: LicenseStatusResult | null
      ): LicenseStatusResult => ({
        success: false,
        configured: status?.configured ?? true,
        status: status?.status ?? "expired",
        isActive: false,
        keyPresent: status?.keyPresent ?? false,
        plan: status?.plan ?? null,
        trialEnabled: status?.trialEnabled,
        trialDays: status?.trialDays,
        trialServerEnabled: status?.trialServerEnabled,
        trialStartedAt: status?.trialStartedAt,
        trialExpiresAt: status?.trialExpiresAt,
        trialDaysLeft: status?.trialDaysLeft,
        trialActive: status?.trialActive,
        error: "PRO_REASONING_PREVIEW_LIMIT_REACHED",
        message: "Daily free AI polish previews are used up. Upgrade to Pro to continue.",
      });

      if (window.electronAPI?.licenseGetStatus) {
        try {
          currentStatus = await window.electronAPI.licenseGetStatus({ allowKeychain: false });
        } catch (_error) {
          currentStatus = null;
        }
      }

      if (currentStatus?.isActive) {
        await refreshLicenseStatus();
        return { allowed: true, declinedTrial: false, status: currentStatus };
      }

      if (canUseReasoningPreview && getReasoningPreviewQuota().remaining <= 0) {
        await refreshLicenseStatus();
        return {
          allowed: false,
          declinedTrial: false,
          status: buildPreviewLimitStatus(currentStatus),
        };
      }

      try {
        const nextStatus = window.electronAPI.licenseEnsureProAccess
          ? await window.electronAPI.licenseEnsureProAccess()
          : currentStatus;
        await refreshLicenseStatus();
        if (nextStatus?.isActive) {
          return {
            allowed: true,
            declinedTrial: false,
            status: nextStatus,
          };
        }
        if (canUseReasoningPreview && getReasoningPreviewQuota().remaining > 0) {
          return {
            allowed: true,
            declinedTrial: false,
            status: nextStatus || currentStatus,
          };
        }
        if (!canUseReasoningPreview) {
          return {
            allowed: false,
            declinedTrial: false,
            status: nextStatus || currentStatus,
          };
        }
        return {
          allowed: false,
          declinedTrial: false,
          status: buildPreviewLimitStatus(nextStatus || currentStatus),
        };
      } catch (_error) {
        await refreshLicenseStatus();
        if (canUseReasoningPreview && getReasoningPreviewQuota().remaining > 0) {
          return { allowed: true, declinedTrial: false, status: currentStatus };
        }
        return canUseReasoningPreview
          ? {
              allowed: false,
              declinedTrial: false,
              status: buildPreviewLimitStatus(currentStatus),
            }
          : { allowed: false, declinedTrial: false, status: currentStatus };
      }
    },
    [refreshLicenseStatus]
  );

  const ensurePromptTestAccess = useCallback(async () => {
    const result = await ensureProAccessWithTrialPrompt("prompt-studio-test");
    return result.allowed;
  }, [ensureProAccessWithTrialPrompt]);

  useEffect(() => {
    if (licenseStatus?.isActive && licenseStatus?.keyPresent) {
      setShowLicenseKeyInput(false);
    }
  }, [licenseStatus?.isActive, licenseStatus?.keyPresent]);

  const showSecondaryHotkeyRequiresPro = useCallback(() => {
    showAlertDialog({
      title: t("settingsPage.general.hotkey.secondary.requiresProTitle"),
      description: t("settingsPage.general.hotkey.secondary.requiresProDescription"),
    });
  }, [showAlertDialog, t]);

  const handleActivateLicense = useCallback(async () => {
    const licenseKey = licenseKeyInput.trim();
    setLicenseValidationFeedback(null);
    if (!licenseKey) {
      await openLicensePurchasePage("desktop-license-empty-key", {
        intent: "purchase",
      });
      return;
    }
    if (!window.electronAPI?.licenseActivate) return;

    setLicenseBusyAction("activate");
    try {
      const result = await window.electronAPI.licenseActivate(licenseKey);
      setLicenseStatus(result);

      if (result.success) {
        setLicenseKeyInput("");
        setShowLicenseKeyInput(false);
        toast({
          title: t("settingsPage.account.desktopLicense.toasts.activatedTitle"),
          description: t("settingsPage.account.desktopLicense.toasts.activatedDescription"),
          variant: "success",
        });
      } else {
        const userFacingErrorMessage = getLocalizedLicenseErrorDescription(result.error, t);
        toast({
          title: t("settingsPage.account.desktopLicense.toasts.activationFailedTitle"),
          description:
            userFacingErrorMessage ||
            t("settingsPage.account.desktopLicense.toasts.activationFailedDescription"),
          variant: "destructive",
        });
      }
    } catch (error) {
      logger.error("Failed to activate license", error, "license");
      toast({
        title: t("settingsPage.account.desktopLicense.toasts.activationFailedTitle"),
        description: t("settingsPage.account.desktopLicense.toasts.activationUnexpectedError"),
        variant: "destructive",
      });
    } finally {
      setLicenseBusyAction(null);
    }
  }, [licenseKeyInput, openLicensePurchasePage, t, toast]);

  const handleValidateLicense = useCallback(async () => {
    if (!window.electronAPI?.licenseValidate) return;
    setLicenseBusyAction("validate");
    setLicenseValidationFeedback(null);
    toast({
      title: t("settingsPage.account.desktopLicense.toasts.validatingTitle"),
      description: t("settingsPage.account.desktopLicense.toasts.validatingDescription"),
      duration: 2200,
    });
    try {
      const result = await window.electronAPI.licenseValidate();
      setLicenseStatus(result);
      const nextFeedback = {
        ok: Boolean(result.success),
        title: result.success
          ? t("settingsPage.account.desktopLicense.toasts.validatedTitle")
          : t("settingsPage.account.desktopLicense.toasts.validateFailedTitle"),
        description: result.success
          ? t("settingsPage.account.desktopLicense.toasts.validatedDescription")
          : getLocalizedLicenseErrorDescription(result.error, t) ||
            t("settingsPage.account.desktopLicense.toasts.invalidDescription"),
        at: Date.now(),
      };
      setLicenseValidationFeedback(nextFeedback);
      toast({
        title: nextFeedback.title,
        description: nextFeedback.description,
        variant: nextFeedback.ok ? "success" : "destructive",
        duration: nextFeedback.ok ? 4500 : 6000,
      });
    } catch (error) {
      logger.error("Failed to validate license", error, "license");
      setLicenseValidationFeedback({
        ok: false,
        title: t("settingsPage.account.desktopLicense.toasts.validateFailedTitle"),
        description: t("settingsPage.account.desktopLicense.toasts.validateUnexpectedError"),
        at: Date.now(),
      });
      toast({
        title: t("settingsPage.account.desktopLicense.toasts.validateFailedTitle"),
        description: t("settingsPage.account.desktopLicense.toasts.validateUnexpectedError"),
        variant: "destructive",
      });
    } finally {
      setLicenseBusyAction(null);
    }
  }, [t, toast]);

  const handleClearLicense = useCallback(() => {
    if (!window.electronAPI?.licenseClear) return;
    const licenseClear = window.electronAPI.licenseClear;
    setLicenseValidationFeedback(null);

    showConfirmDialog({
      title: t("settingsPage.account.desktopLicense.dialogs.removeTitle"),
      description: t("settingsPage.account.desktopLicense.dialogs.removeDescription"),
      confirmText: t("settingsPage.account.desktopLicense.dialogs.removeConfirm"),
      variant: "destructive",
      onConfirm: async () => {
        setLicenseBusyAction("clear");
        try {
          const result = await licenseClear();
          if (result?.success !== true) {
            throw new Error(
              result?.message ||
                t("settingsPage.account.desktopLicense.toasts.removeFailedDescription")
            );
          }
          setLicenseStatus(result);
          setLicenseKeyInput("");
          toast({
            title: t("settingsPage.account.desktopLicense.toasts.removedTitle"),
            description: t("settingsPage.account.desktopLicense.toasts.removedDescription"),
            variant: "success",
          });
        } catch (error) {
          logger.error("Failed to clear license", error, "license");
          toast({
            title: t("settingsPage.account.desktopLicense.toasts.removeFailedTitle"),
            description: t("settingsPage.account.desktopLicense.toasts.removeFailedDescription"),
            variant: "destructive",
          });
        } finally {
          setLicenseBusyAction(null);
        }
      },
    });
  }, [showConfirmDialog, t, toast]);

  const installTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: true,
    showAlert: showAlertDialog,
  });

  const validateHotkeyForInput = useCallback(
    (hotkey: string) => getValidationMessage(hotkey, getPlatform()),
    []
  );

  const validateSecondaryHotkeyForInput = useCallback(
    (hotkey: string) => {
      const baseValidation = getValidationMessage(hotkey, getPlatform());
      if (baseValidation) return baseValidation;

      const normalized = hotkey?.trim() || "";
      if (!normalized) return null;

      if (normalized === "GLOBE") {
        return t("settingsPage.general.hotkey.secondary.globeNotSupported");
      }

      if (/^Right(Control|Ctrl|Alt|Option|Shift|Super|Win|Meta|Command|Cmd)$/i.test(normalized)) {
        return t("settingsPage.general.hotkey.secondary.rightModifierNotSupported");
      }

      if (
        normalized.includes("+") &&
        normalized
          .split("+")
          .map((part) => part.trim().toLowerCase())
          .every((part) => MODIFIER_PARTS.has(part))
      ) {
        return t("settingsPage.general.hotkey.secondary.modifiersOnlyNotSupported");
      }

      return null;
    },
    [t]
  );

  const [isSavingHotkeyWorkflows, setIsSavingHotkeyWorkflows] = useState(false);

  const saveHotkeyWorkflows = useCallback(
    async (nextWorkflows: HotkeyWorkflow[]) => {
      let runtimeUpdated = false;
      if (!hasProAccess && nextWorkflows.length > 0) {
        const access = await ensureProAccessWithTrialPrompt("hotkey-workflows");
        if (!access.allowed) {
          if (!access.declinedTrial) showSecondaryHotkeyRequiresPro();
          return false;
        }
      }

      const normalizedHotkeys = new Set<string>();
      for (const workflow of nextWorkflows) {
        const validationError = validateSecondaryHotkeyForInput(workflow.hotkey);
        if (validationError) {
          showAlertDialog({
            title: t("hooks.hotkeyRegistration.titles.invalidHotkey"),
            description: validationError,
          });
          return false;
        }
        const normalized = workflow.hotkey.trim().toLowerCase();
        if (normalizedHotkeys.has(normalized)) {
          showAlertDialog({
            title: t("hooks.hotkeyRegistration.titles.invalidHotkey"),
            description: t("settingsPage.general.hotkey.secondary.duplicateHotkey"),
          });
          return false;
        }
        normalizedHotkeys.add(normalized);
      }

      try {
        setIsSavingHotkeyWorkflows(true);
        const runtimeWorkflows = nextWorkflows.map(({ id, hotkey, enabled }) => ({
          id,
          hotkey,
          enabled,
        }));
        const result = window.electronAPI?.syncHotkeyWorkflows
          ? await window.electronAPI.syncHotkeyWorkflows(runtimeWorkflows)
          : { success: true, message: "renderer-only" };
        if (!result?.success) {
          if (result?.code === "LICENSE_REQUIRED") showSecondaryHotkeyRequiresPro();
          else {
            showAlertDialog({
              title: t("hooks.hotkeyRegistration.titles.notRegistered"),
              description:
                result?.message || t("settingsPage.general.hotkey.secondary.registerFailed"),
            });
          }
          return false;
        }
        runtimeUpdated = true;

        setHotkeyWorkflows(nextWorkflows);
        toast({
          title: t("settingsPage.general.hotkey.secondary.workflowsSavedTitle"),
          description: t("settingsPage.general.hotkey.secondary.workflowsSavedDescription", {
            count: nextWorkflows.length,
          }),
          variant: "success",
        });
        return true;
      } catch (error) {
        if (runtimeUpdated && window.electronAPI?.syncHotkeyWorkflows) {
          await window.electronAPI
            .syncHotkeyWorkflows(
              hotkeyWorkflows.map(({ id, hotkey, enabled }) => ({ id, hotkey, enabled }))
            )
            .catch(() => undefined);
        }
        logger.error("Failed to save hotkey workflows", error, "settings");
        showAlertDialog({
          title: t("hooks.hotkeyRegistration.titles.error"),
          description:
            error instanceof Error
              ? error.message
              : t("settingsPage.general.hotkey.secondary.registerRetry"),
        });
        return false;
      } finally {
        setIsSavingHotkeyWorkflows(false);
      }
    },
    [
      ensureProAccessWithTrialPrompt,
      hasProAccess,
      hotkeyWorkflows,
      setHotkeyWorkflows,
      showAlertDialog,
      showSecondaryHotkeyRequiresPro,
      t,
      toast,
      validateSecondaryHotkeyForInput,
    ]
  );

  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);

  const platform = useMemo(() => {
    if (typeof window !== "undefined" && window.electronAPI?.getPlatform) {
      return window.electronAPI.getPlatform();
    }
    return "linux";
  }, []);

  const [newDictionaryWord, setNewDictionaryWord] = useState("");

  const handleAddDictionaryWord = useCallback(async () => {
    const word = newDictionaryWord.trim();
    if (word && !customDictionary.includes(word)) {
      const saved = await setCustomDictionary([...customDictionary, word]);
      if (saved) {
        setNewDictionaryWord("");
      } else {
        toast({
          title: t("settingsPage.dictionary.syncFailedTitle"),
          description: t("settingsPage.dictionary.syncFailedDescription"),
          variant: "destructive",
        });
      }
    }
  }, [newDictionaryWord, customDictionary, setCustomDictionary, t, toast]);

  const handleRemoveDictionaryWord = useCallback(
    async (wordToRemove: string) => {
      if (wordToRemove === agentName) return;
      const saved = await setCustomDictionary(
        customDictionary.filter((word) => word !== wordToRemove)
      );
      if (!saved) {
        toast({
          title: t("settingsPage.dictionary.syncFailedTitle"),
          description: t("settingsPage.dictionary.syncFailedDescription"),
          variant: "destructive",
        });
      }
    },
    [customDictionary, setCustomDictionary, agentName, t, toast]
  );

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);
  const [trayIconEnabled, setTrayIconEnabled] = useState(platform === "darwin");
  const [trayIconLoading, setTrayIconLoading] = useState(platform === "darwin");

  useEffect(() => {
    if (platform === "linux") {
      setAutoStartLoading(false);
      return;
    }
    const loadAutoStart = async () => {
      if (window.electronAPI?.getAutoStartEnabled) {
        try {
          const enabled = await window.electronAPI.getAutoStartEnabled();
          setAutoStartEnabled(enabled);
        } catch (error) {
          logger.error("Failed to get auto-start status", error, "settings");
        }
      }
      setAutoStartLoading(false);
    };
    loadAutoStart();
  }, [platform]);

  const handleAutoStartChange = async (enabled: boolean) => {
    if (window.electronAPI?.setAutoStartEnabled) {
      try {
        setAutoStartLoading(true);
        const result = await window.electronAPI.setAutoStartEnabled(enabled);
        if (result.success) {
          setAutoStartEnabled(enabled);
        }
      } catch (error) {
        logger.error("Failed to set auto-start", error, "settings");
      } finally {
        setAutoStartLoading(false);
      }
    }
  };

  useEffect(() => {
    if (platform !== "darwin") {
      setTrayIconLoading(false);
      return;
    }

    const loadTrayIconEnabled = async () => {
      if (window.electronAPI?.getTrayIconEnabled) {
        try {
          const enabled = await window.electronAPI.getTrayIconEnabled();
          setTrayIconEnabled(enabled);
        } catch (error) {
          logger.error("Failed to get tray icon status", error, "settings");
        }
      }
      setTrayIconLoading(false);
    };

    loadTrayIconEnabled();
  }, [platform]);

  const handleTrayIconChange = async (enabled: boolean) => {
    if (window.electronAPI?.setTrayIconEnabled) {
      try {
        setTrayIconLoading(true);
        const result = await window.electronAPI.setTrayIconEnabled(enabled);
        if (result.success) {
          setTrayIconEnabled(enabled);
        }
      } catch (error) {
        logger.error("Failed to set tray icon status", error, "settings");
      } finally {
        setTrayIconLoading(false);
      }
    }
  };

  const [autoCheckUpdateEnabled, setAutoCheckUpdateEnabled] = useState(true);
  const [autoCheckUpdateLoading, setAutoCheckUpdateLoading] = useState(true);

  useEffect(() => {
    const loadAutoCheckUpdate = async () => {
      if (window.electronAPI?.getAutoCheckUpdate) {
        try {
          const enabled = await window.electronAPI.getAutoCheckUpdate();
          setAutoCheckUpdateEnabled(enabled);
        } catch (error) {
          logger.error("Failed to get auto-check-update status", error, "settings");
        }
      }
      setAutoCheckUpdateLoading(false);
    };
    loadAutoCheckUpdate();
  }, []);

  const handleAutoCheckUpdateChange = async (enabled: boolean) => {
    if (window.electronAPI?.setAutoCheckUpdate) {
      try {
        setAutoCheckUpdateLoading(true);
        const result = await window.electronAPI.setAutoCheckUpdate(enabled);
        if (result.success) {
          setAutoCheckUpdateEnabled(enabled);
        }
      } catch (error) {
        logger.error("Failed to set auto-check-update", error, "settings");
      } finally {
        setAutoCheckUpdateLoading(false);
      }
    }
  };

  useEffect(() => {
    let mounted = true;

    const timer = setTimeout(async () => {
      if (!mounted) return;

      const version = await getAppVersion();
      if (version && mounted) setCurrentVersion(version);

      if (mounted) {
        whisperHook.checkWhisperInstallation();
      }
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [whisperHook, getAppVersion]);

  useEffect(() => {
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo?.();
        if (info?.isUsingGnome) {
          setIsUsingGnomeHotkeys(true);
          setActivationMode("tap");
        }
      } catch (error) {
        logger.error("Failed to check hotkey mode", error, "settings");
      }
    };
    checkHotkeyMode();
  }, [setActivationMode]);

  useEffect(() => {
    if (installInitiated) {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
      }
      installTimeoutRef.current = setTimeout(() => {
        showAlertDialog({
          title: t("settingsPage.general.updates.dialogs.almostThere.title"),
          description: t("settingsPage.general.updates.dialogs.almostThere.description"),
        });
      }, 10000);
    } else if (installTimeoutRef.current) {
      clearTimeout(installTimeoutRef.current);
      installTimeoutRef.current = null;
    }

    return () => {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
        installTimeoutRef.current = null;
      }
    };
  }, [installInitiated, showAlertDialog, t]);

  const resetAccessibilityPermissions = () => {
    const message = t("settingsPage.permissions.resetAccessibility.description");

    showConfirmDialog({
      title: t("settingsPage.permissions.resetAccessibility.title"),
      description: message,
      onConfirm: () => {
        permissionsHook.openAccessibilitySettings();
      },
    });
  };

  const handleRemoveModels = useCallback(() => {
    if (isRemovingModels) return;

    showConfirmDialog({
      title: t("settingsPage.developer.removeModels.title"),
      description: t("settingsPage.developer.removeModels.description", { path: cachePathHint }),
      confirmText: t("settingsPage.developer.removeModels.confirmText"),
      variant: "destructive",
      onConfirm: async () => {
        setIsRemovingModels(true);
        try {
          const results = await Promise.allSettled([
            window.electronAPI?.deleteAllWhisperModels?.(),
            window.electronAPI?.deleteAllParakeetModels?.(),
            window.electronAPI?.deleteAllParaformerModels?.(),
            window.electronAPI?.deleteAllGraniteModels?.(),
            window.electronAPI?.sherpaStreamingDeleteAllModels?.(),
            window.electronAPI?.deletePunctuationModels?.(),
            window.electronAPI?.modelDeleteAll?.(),
          ]);

          const anyFailed = results.some(
            (r) =>
              r.status === "rejected" || (r.status === "fulfilled" && r.value && !r.value.success)
          );

          if (anyFailed) {
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.failedTitle"),
              description: t("settingsPage.developer.removeModels.failedDescription"),
            });
          } else {
            dispatchChordVoxModelsCleared(window);
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.successTitle"),
              description: t("settingsPage.developer.removeModels.successDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("settingsPage.developer.removeModels.failedTitle"),
            description: t("settingsPage.developer.removeModels.failedDescriptionShort"),
          });
        } finally {
          setIsRemovingModels(false);
        }
      },
    });
  }, [isRemovingModels, cachePathHint, showConfirmDialog, showAlertDialog, t]);

  const collectSettingsSnapshot = useCallback(
    async (includeSecrets = false) => {
      const localStorageData: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (isSettingsTransferExcludedKey(key, includeSecrets)) continue;
        const value = localStorage.getItem(key);
        if (value !== null) {
          localStorageData[key] = value;
        }
      }

      const dictionary = (await window.electronAPI?.getDictionary?.().catch(() => [])) || [];
      const dictationKey = await window.electronAPI?.getDictationKey?.().catch(() => null);
      const activationMode = await window.electronAPI?.getActivationMode?.().catch(() => null);
      const licenseApiBaseUrl = await window.electronAPI
        ?.getLicenseApiBaseUrl?.()
        .catch(() => null);

      return {
        schemaVersion: 1,
        app: "ChordVox",
        exportedAt: new Date().toISOString(),
        appVersion: currentVersion || (await getAppVersion()) || null,
        includesSecrets: includeSecrets,
        localStorage: localStorageData,
        dictionary: Array.isArray(dictionary) ? dictionary : [],
        runtime: {
          dictationKey,
          activationMode,
          licenseApiBaseUrl,
        },
      };
    },
    [currentVersion, getAppVersion]
  );

  const handleExportSettings = useCallback(async () => {
    if (!window.electronAPI?.exportSettingsFile) return;
    try {
      const snapshot = await collectSettingsSnapshot(true);
      const result = await window.electronAPI.exportSettingsFile(snapshot);
      if (!result.success) {
        throw new Error(result.error || "Failed to export settings");
      }
      if (result.cancelled) {
        return;
      }
      showAlertDialog({
        title: t("settingsPage.developer.settingsTransfer.exportSuccessTitle"),
        description: t("settingsPage.developer.settingsTransfer.exportSuccessDescription", {
          path: result.filePath || "",
        }),
      });
    } catch (error) {
      showAlertDialog({
        title: t("settingsPage.developer.settingsTransfer.exportFailedTitle"),
        description: t("settingsPage.developer.settingsTransfer.exportFailedDescription"),
      });
    }
  }, [collectSettingsSnapshot, showAlertDialog, t]);

  const applyImportedSettings = useCallback(
    async (data: unknown): Promise<SettingsImportApplyResult> => {
      if (!isSettingsImportObject(data)) {
        throw new Error(t("settingsPage.developer.settingsTransfer.importInvalidPayload"));
      }

      const payload = data;
      const runtime = getSettingsImportRuntime(payload);
      const sourceLocalStorageData = isSettingsImportObject(payload.localStorage)
        ? payload.localStorage
        : payload;
      const localStorageData = sanitizeSettingsTransferLocalStorage(sourceLocalStorageData, {
        includeSecrets:
          payload.includesSecrets === true ||
          !Object.prototype.hasOwnProperty.call(payload, "includesSecrets"),
      });

      if (!hasImportableSettingsPayload(payload, localStorageData)) {
        throw new Error(t("settingsPage.developer.settingsTransfer.importNoSettingsFound"));
      }

      const sanitizedLocalStorageData: Record<string, string> = { ...localStorageData };
      if (
        Object.prototype.hasOwnProperty.call(
          sanitizedLocalStorageData,
          "localTranscriptionProvider"
        )
      ) {
        const importedProvider = sanitizedLocalStorageData.localTranscriptionProvider || "";
        if (
          importedProvider !== "whisper" &&
          importedProvider !== "nvidia" &&
          importedProvider !== "paraformer" &&
          importedProvider !== "granite" &&
          importedProvider !== "cohere"
        ) {
          sanitizedLocalStorageData.localTranscriptionProvider = "whisper";
          sanitizedLocalStorageData.cohereRuntimeUrl = "";
          sanitizedLocalStorageData.cohereRuntimeApiKey = "";
          sanitizedLocalStorageData.cohereModel = "";
        }
      }

      const warnings: string[] = [];
      if (Object.prototype.hasOwnProperty.call(sanitizedLocalStorageData, "modelStorageRoot")) {
        try {
          const rootResult = await setModelStorageRoot(
            sanitizedLocalStorageData.modelStorageRoot || ""
          );
          sanitizedLocalStorageData.modelStorageRoot = String(rootResult.root || "");
        } catch (error) {
          warnings.push("modelStorageRoot");
          delete sanitizedLocalStorageData.modelStorageRoot;
          void logger.warn(
            "Skipped model storage root import",
            { error: getErrorMessage(error) },
            "settings-import"
          );
        }
      }

      const environmentValues: Record<string, string> = {};
      for (const key of SETTINGS_TRANSFER_ENVIRONMENT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(sanitizedLocalStorageData, key)) {
          environmentValues[key] = sanitizedLocalStorageData[key];
        }
      }
      if (Object.keys(environmentValues).length > 0) {
        if (!window.electronAPI?.importEnvironmentSettings) {
          throw new Error("This app version cannot restore API credentials.");
        }
        const environmentResult =
          await window.electronAPI.importEnvironmentSettings(environmentValues);
        if (!environmentResult?.success) {
          throw new Error(
            environmentResult?.error || "Failed to restore API credentials securely."
          );
        }
      }

      const settingsKeysToReplace = new Set(Object.keys(sanitizedLocalStorageData));
      replaceImportedSettingsStorage(
        localStorage,
        sanitizedLocalStorageData,
        settingsKeysToReplace
      );

      const runOptionalImportStep = async (step: string, action: () => Promise<void>) => {
        try {
          await action();
        } catch (error) {
          warnings.push(step);
          void logger.warn(
            "Skipped optional settings import step",
            { step, error: getErrorMessage(error) },
            "settings-import"
          );
        }
      };

      const parsedDictionary = (() => {
        const directDictionary = normalizeImportedDictionary(payload.dictionary);
        if (directDictionary !== null) return directDictionary;
        const raw = sanitizedLocalStorageData.customDictionary;
        if (typeof raw === "string") {
          try {
            return normalizeImportedDictionary(JSON.parse(raw));
          } catch {
            return null;
          }
        }
        return null;
      })();

      if (parsedDictionary !== null && window.electronAPI?.setDictionary) {
        await runOptionalImportStep("dictionary", async () => {
          await window.electronAPI.setDictionary?.(parsedDictionary);
        });
      }

      const dictationKey = runtime.dictationKey ?? sanitizedLocalStorageData.dictationKey;
      if (typeof dictationKey === "string" && window.electronAPI?.saveDictationKey) {
        await runOptionalImportStep("dictationKey", async () => {
          await window.electronAPI.saveDictationKey?.(dictationKey);
        });
      }

      const activationMode = runtime.activationMode ?? sanitizedLocalStorageData.activationMode;
      if (
        (activationMode === "tap" || activationMode === "push") &&
        window.electronAPI?.saveActivationMode
      ) {
        await runOptionalImportStep("activationMode", async () => {
          await window.electronAPI.saveActivationMode?.(activationMode);
        });
      }

      const licenseApiBaseUrl =
        runtime.licenseApiBaseUrl ?? sanitizedLocalStorageData.licenseApiBaseUrl;
      if (typeof licenseApiBaseUrl === "string" && window.electronAPI?.saveLicenseApiBaseUrl) {
        await runOptionalImportStep("licenseApiBaseUrl", async () => {
          await window.electronAPI.saveLicenseApiBaseUrl?.(licenseApiBaseUrl);
        });
      }

      if (window.electronAPI?.saveAllKeysToEnv) {
        await runOptionalImportStep("saveAllKeysToEnv", async () => {
          await window.electronAPI.saveAllKeysToEnv?.();
        });
      }

      if (window.electronAPI?.syncStartupPreferences) {
        await runOptionalImportStep("syncStartupPreferences", async () => {
          const localProviderRaw =
            sanitizedLocalStorageData.localTranscriptionProvider || "whisper";
          const localProvider: LocalTranscriptionProvider =
            localProviderRaw === "nvidia" ||
            localProviderRaw === "paraformer" ||
            localProviderRaw === "granite" ||
            localProviderRaw === "cohere"
              ? localProviderRaw
              : "whisper";
          const useLocalWhisperValue =
            (sanitizedLocalStorageData.useLocalWhisper || "true") !== "false";
          const reasoningProviderValue = isLocalReasoningProviderId(
            sanitizedLocalStorageData.reasoningProvider
          )
            ? "local"
            : sanitizedLocalStorageData.reasoningProvider || "openai";

          let model = sanitizedLocalStorageData.whisperModel || "turbo";
          let externalRuntimeUrl = "";
          if (localProvider === "nvidia") {
            model = sanitizedLocalStorageData.parakeetModel || "";
          } else if (localProvider === "paraformer") {
            model = sanitizedLocalStorageData.paraformerModel || "paraformer-large-zh";
          } else if (localProvider === "granite") {
            model = sanitizedLocalStorageData.graniteModel || "granite-4.0-1b-speech";
            externalRuntimeUrl = sanitizedLocalStorageData.graniteRuntimeUrl || "";
          } else if (localProvider === "cohere") {
            model = sanitizedLocalStorageData.cohereModel || "cohere-transcribe-03-2026";
            externalRuntimeUrl = sanitizedLocalStorageData.cohereRuntimeUrl || "";
          }

          await window.electronAPI.syncStartupPreferences?.({
            useLocalWhisper: useLocalWhisperValue,
            localTranscriptionProvider: localProvider,
            model: model || undefined,
            externalRuntimeUrl: externalRuntimeUrl.trim() || undefined,
            reasoningProvider: reasoningProviderValue,
            reasoningModel:
              reasoningProviderValue === "local" && sanitizedLocalStorageData.reasoningModel
                ? sanitizedLocalStorageData.reasoningModel
                : undefined,
          });
        });
      }

      return { warnings };
    },
    [setModelStorageRoot, t]
  );

  const handleImportSettings = useCallback(async () => {
    if (!window.electronAPI?.importSettingsFile) return;
    try {
      const result = await window.electronAPI.importSettingsFile();
      if (!result.success) {
        throw new Error(result.error || "Failed to import settings");
      }
      if (result.cancelled) {
        return;
      }
      const importedData = result.data;
      showConfirmDialog({
        title: t("settingsPage.developer.settingsTransfer.importConfirmTitle"),
        description: t("settingsPage.developer.settingsTransfer.importConfirmDescription"),
        confirmText: t("settingsPage.developer.settingsTransfer.importConfirmButton"),
        onConfirm: async () => {
          try {
            const applyResult = await applyImportedSettings(importedData);
            showAlertDialog({
              title: t("settingsPage.developer.settingsTransfer.importSuccessTitle"),
              description:
                applyResult.warnings.length > 0
                  ? t(
                      "settingsPage.developer.settingsTransfer.importSuccessWithWarningsDescription"
                    )
                  : t("settingsPage.developer.settingsTransfer.importSuccessDescription"),
            });
            scheduleApplicationRestart();
          } catch (error) {
            logger.error("Failed to apply imported settings", error);
            showAlertDialog({
              title: t("settingsPage.developer.settingsTransfer.importFailedTitle"),
              description: getSettingsImportFailureDescription(t, error),
            });
          }
        },
        variant: "destructive",
      });
    } catch (error) {
      logger.error("Failed to import settings file", error);
      showAlertDialog({
        title: t("settingsPage.developer.settingsTransfer.importFailedTitle"),
        description: getSettingsImportFailureDescription(t, error),
      });
    }
  }, [applyImportedSettings, scheduleApplicationRestart, showAlertDialog, showConfirmDialog, t]);

  const showFileTranscriptionProDialog = useCallback(() => {
    showConfirmDialog({
      title: t("controlPanel.history.fileTranscriptionRequiresProTitle"),
      description: t("controlPanel.history.fileTranscriptionRequiresProDescription"),
      confirmText: t("settingsPage.account.checkout.upgradeToPro"),
      cancelText: t("common.cancel"),
      onConfirm: () => {
        void openLicensePurchasePage("file-transcription-locked", {
          feature: "file-transcription",
        });
      },
    });
  }, [openLicensePurchasePage, showConfirmDialog, t]);

  const showTrialStartFailureNotice = useCallback(
    (status: LicenseStatusResult | null) => {
      const isExpired = status?.error === "TRIAL_EXPIRED" || status?.status === "expired";
      const localizedDescription = getLocalizedLicenseErrorDescription(status?.error, t);
      if (isExpired) {
        const trialDays = status?.trialDays ?? 7;
        showConfirmDialog({
          title: t("settingsPage.account.trialStartDialog.expiredTitle"),
          description: t("settingsPage.account.trialStartDialog.expiredDescription", {
            days: trialDays,
          }),
          confirmText: t("settingsPage.account.trialReminder.button"),
          cancelText: t("settingsPage.account.trialStartDialog.cancel"),
          onConfirm: () => {
            void openLicensePurchasePage("trial-expired-modal", {
              days: String(trialDays),
            });
          },
        });
        return;
      }

      toast({
        title: t("settingsPage.account.trialStartDialog.notStartedTitle"),
        description:
          localizedDescription ||
          status?.message ||
          t("settingsPage.account.trialStartDialog.unavailableDescription"),
        variant: "destructive",
        duration: 7000,
      });
    },
    [openLicensePurchasePage, showConfirmDialog, t, toast]
  );

  const startProTrialFromAccount = useCallback(async () => {
    const result = await ensureProAccessWithTrialPrompt("account-trial-card");
    if (!result.allowed || !isActiveProTrial(result.status)) {
      showTrialStartFailureNotice(result.status);
      return;
    }

    toast({
      title: t("settingsPage.account.trialStartDialog.startedTitle"),
      description: t("settingsPage.account.trialStartDialog.startedDescription"),
      variant: "success",
    });
  }, [ensureProAccessWithTrialPrompt, showTrialStartFailureNotice, t, toast]);

  useEffect(() => {
    const daysLeft =
      licenseStatus?.plan === "trial" && !licenseStatus?.keyPresent
        ? licenseStatus?.trialDaysLeft
        : null;
    if (daysLeft !== 7 && daysLeft !== 1) return;
    const reminderKey = `pro-trial-reminder:${licenseStatus?.trialExpiresAt || "trial"}:${daysLeft}:${i18n.language}`;
    if (localStorage.getItem(reminderKey) === "true") return;
    localStorage.setItem(reminderKey, "true");
    toast({
      title: t("settingsPage.account.trialReminder.title", { days: daysLeft }),
      description: t("settingsPage.account.trialReminder.description", { days: daysLeft }),
      duration: 7000,
    });
  }, [
    licenseStatus?.plan,
    licenseStatus?.keyPresent,
    licenseStatus?.trialDaysLeft,
    licenseStatus?.trialExpiresAt,
    i18n.language,
    t,
    toast,
  ]);

  const renderSectionContent = () => {
    switch (activeSection) {
      case "account":
        return (
          <AccountSection
            isLoaded={true}
            isSignedIn={false}
            user={null}
            usage={null}
            licenseStatus={licenseStatus}
            licenseKeyInput={licenseKeyInput}
            setLicenseKeyInput={setLicenseKeyInput}
            showLicenseKeyInput={showLicenseKeyInput}
            setShowLicenseKeyInput={setShowLicenseKeyInput}
            licenseBusyAction={licenseBusyAction}
            licenseValidationFeedback={licenseValidationFeedback}
            trialOfferAvailable={trialOfferAvailable}
            startProTrialFromAccount={startProTrialFromAccount}
            openLicensePurchasePage={openLicensePurchasePage}
            handleActivateLicense={handleActivateLicense}
            handleValidateLicense={handleValidateLicense}
            handleClearLicense={handleClearLicense}
            handleSignOut={ignoreLegacyAccountAction}
            isSigningOut={false}
            showAlertDialog={showAlertDialog}
          />
        );

      case "general": {
        return (
          <GeneralSection
            theme={theme}
            setTheme={setTheme}
            uiLanguage={uiLanguage}
            setUiLanguage={setUiLanguage}
            uiLanguageOptions={UI_LANGUAGE_OPTIONS}
            preferredLanguage={preferredLanguage}
            updateTranscriptionSettings={updateTranscriptionSettings}
            selectedCueStyleValue={selectedCueStyleValue}
            handleDictationCueStyleChange={handleDictationCueStyleChange}
            recordingAnimationStyle={recordingAnimationStyle}
            setRecordingAnimationStyle={setRecordingAnimationStyle}
            autoStartEnabled={autoStartEnabled}
            handleAutoStartChange={handleAutoStartChange}
            autoStartLoading={autoStartLoading}
            trayIconEnabled={trayIconEnabled}
            handleTrayIconChange={handleTrayIconChange}
            trayIconLoading={trayIconLoading}
            autoCheckUpdateEnabled={autoCheckUpdateEnabled}
            handleAutoCheckUpdateChange={handleAutoCheckUpdateChange}
            autoCheckUpdateLoading={autoCheckUpdateLoading}
            currentVersion={currentVersion}
            isUpdateAvailable={isUpdateAvailable}
            checkingForUpdates={checkingForUpdates}
            downloadingUpdate={downloadingUpdate}
            installInitiated={installInitiated}
            updateInfo={updateInfo}
            updateDownloadProgress={updateDownloadProgress}
            updateStatus={updateStatus}
            manualUpdateUrl={manualUpdateUrl}
            isManualUpdate={isManualUpdate}
            formattedUpdateLastCheckedAt={formattedUpdateLastCheckedAt}
            checkForUpdates={checkForUpdates}
            downloadUpdate={downloadUpdate}
            installUpdateAction={installUpdateAction}
            showConfirmDialog={showConfirmDialog}
            showAlertDialog={showAlertDialog}
            platform={platform}
            preferBuiltInMic={preferBuiltInMic}
            selectedMicDeviceId={selectedMicDeviceId}
            setPreferBuiltInMic={setPreferBuiltInMic}
            setSelectedMicDeviceId={setSelectedMicDeviceId}
            fileTranscriptionCompletionAlertEnabled={fileTranscriptionCompletionAlertEnabled}
            setFileTranscriptionCompletionAlertEnabled={setFileTranscriptionCompletionAlertEnabled}
            tailCommandsEnabled={tailCommandsEnabled}
            setTailCommandsEnabled={setTailCommandsEnabled}
            pasteConfirmEnabled={pasteConfirmEnabled}
            setPasteConfirmEnabled={setPasteConfirmEnabled}
            pasteConfirmThreshold={pasteConfirmThreshold}
            setPasteConfirmThreshold={setPasteConfirmThreshold}
          />
        );
      }

      case "hotkeys":
        return (
          <HotkeysSection
            dictationKey={dictationKey}
            onPrimaryHotkeyChange={registerHotkey}
            isPrimaryHotkeyRegistering={isHotkeyRegistering}
            validatePrimaryHotkey={validateHotkeyForInput}
            workflows={hotkeyWorkflows}
            currentProfile={currentHotkeyProfile}
            onSaveWorkflows={saveHotkeyWorkflows}
            isSavingWorkflows={isSavingHotkeyWorkflows}
            validateWorkflowHotkey={validateSecondaryHotkeyForInput}
            isWorkflowFeatureLocked={isSecondaryHotkeyLocked}
            trialOfferAvailable={trialOfferAvailable}
            onUnlockWorkflows={async () => {
              const result = await ensureProAccessWithTrialPrompt("secondary-hotkey-locked");
              if (!result.allowed && !result.declinedTrial) {
                void openLicensePurchasePage("secondary-hotkey-locked");
              }
            }}
            onOpenTranscriptionSettings={() => {
              onSectionChange?.("transcription");
              onOpenTranscriptionSettings?.();
            }}
            onOpenAiModelsSettings={() => onSectionChange?.("aiModels")}
            isUsingGnomeHotkeys={isUsingGnomeHotkeys}
            activationMode={activationMode}
            setActivationMode={setActivationMode}
            showConfirmDialog={showConfirmDialog}
          />
        );

      case "transcription":
        return (
          <TranscriptionSection
            preferredLanguage={preferredLanguage}
            modelStorageRoot={modelStorageRoot}
            setModelStorageRoot={setModelStorageRoot}
            cloudTranscriptionMode={cloudTranscriptionMode}
            setCloudTranscriptionMode={setCloudTranscriptionMode}
            useLocalWhisper={useLocalWhisper}
            setUseLocalWhisper={setUseLocalWhisper}
            updateTranscriptionSettings={updateTranscriptionSettings}
            cloudTranscriptionProvider={cloudTranscriptionProvider}
            setCloudTranscriptionProvider={setCloudTranscriptionProvider}
            cloudTranscriptionModel={cloudTranscriptionModel}
            setCloudTranscriptionModel={setCloudTranscriptionModel}
            localTranscriptionProvider={localTranscriptionProvider}
            setLocalTranscriptionProvider={setLocalTranscriptionProvider}
            whisperModel={whisperModel}
            setWhisperModel={setWhisperModel}
            parakeetModel={parakeetModel}
            setParakeetModel={setParakeetModel}
            paraformerModel={paraformerModel}
            setParaformerModel={setParaformerModel}
            graniteModel={graniteModel}
            setGraniteModel={setGraniteModel}
            graniteRuntimeUrl={graniteRuntimeUrl}
            setGraniteRuntimeUrl={setGraniteRuntimeUrl}
            graniteRuntimeApiKey={graniteRuntimeApiKey}
            setGraniteRuntimeApiKey={setGraniteRuntimeApiKey}
            cohereModel={cohereModel}
            setCohereModel={setCohereModel}
            cohereRuntimeUrl={cohereRuntimeUrl}
            setCohereRuntimeUrl={setCohereRuntimeUrl}
            cohereRuntimeApiKey={cohereRuntimeApiKey}
            setCohereRuntimeApiKey={setCohereRuntimeApiKey}
            openaiApiKey={openaiApiKey}
            setOpenaiApiKey={setOpenaiApiKey}
            groqApiKey={groqApiKey}
            setGroqApiKey={setGroqApiKey}
            sonioxApiKey={sonioxApiKey}
            setSonioxApiKey={setSonioxApiKey}
            deepgramApiKey={deepgramApiKey}
            setDeepgramApiKey={setDeepgramApiKey}
            googleSttApiKey={googleSttApiKey}
            setGoogleSttApiKey={setGoogleSttApiKey}
            doubaoAppId={doubaoAppId}
            setDoubaoAppId={setDoubaoAppId}
            doubaoAccessToken={doubaoAccessToken}
            setDoubaoAccessToken={setDoubaoAccessToken}
            customTranscriptionApiKey={customTranscriptionApiKey}
            setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
            cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
            setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
            showConfirmDialog={showConfirmDialog}
            toast={toast}
          />
        );

      case "dictionary":
        return (
          <DictionaryManager
            agentName={agentName}
            customDictionary={customDictionary}
            newDictionaryWord={newDictionaryWord}
            setNewDictionaryWord={setNewDictionaryWord}
            setCustomDictionary={setCustomDictionary}
            handleAddDictionaryWord={handleAddDictionaryWord}
            handleRemoveDictionaryWord={handleRemoveDictionaryWord}
            showConfirmDialog={showConfirmDialog}
            showPageHeader
          />
        );

      case "aiModels":
        return (
          <AiModelsSection
            useReasoningModel={useReasoningModel}
            setUseReasoningModel={(value) => {
              setUseReasoningModel(value);
              updateReasoningSettings({ useReasoningModel: value });
            }}
            hasProAccess={hasProAccess}
            canOfferTrial={trialOfferAvailable}
            requestProAccess={ensureProAccessWithTrialPrompt}
            onUpgradeToPro={() => {
              void openLicensePurchasePage("ai-models-toggle");
            }}
            reasoningModel={reasoningModel}
            setReasoningModel={setReasoningModel}
            reasoningProvider={reasoningProvider}
            setReasoningProvider={setReasoningProvider}
            cloudReasoningBaseUrl={cloudReasoningBaseUrl}
            setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
            customReasoningProtocol={customReasoningProtocol}
            setCustomReasoningProtocol={setCustomReasoningProtocol}
            openaiApiKey={openaiApiKey}
            setOpenaiApiKey={setOpenaiApiKey}
            openrouterApiKey={openrouterApiKey}
            setOpenrouterApiKey={setOpenrouterApiKey}
            anthropicApiKey={anthropicApiKey}
            setAnthropicApiKey={setAnthropicApiKey}
            geminiApiKey={geminiApiKey}
            setGeminiApiKey={setGeminiApiKey}
            groqApiKey={groqApiKey}
            setGroqApiKey={setGroqApiKey}
            cerebrasApiKey={cerebrasApiKey}
            setCerebrasApiKey={setCerebrasApiKey}
            customReasoningApiKey={customReasoningApiKey}
            setCustomReasoningApiKey={setCustomReasoningApiKey}
            showConfirmDialog={showConfirmDialog}
            showAlertDialog={showAlertDialog}
          />
        );

      case "agentConfig":
        return (
          <AgentConfigSection
            agentName={agentName}
            agentNameInput={agentNameInput}
            setAgentNameInput={setAgentNameInput}
            onSaveAgentName={() => {
              const trimmed = agentNameInput.trim();
              setAgentName(trimmed);
              setAgentNameInput(trimmed);
              showAlertDialog({
                title: t("settingsPage.agentConfig.dialogs.updatedTitle"),
                description: t("settingsPage.agentConfig.dialogs.updatedDescription", {
                  name: trimmed,
                }),
              });
            }}
            dictionaryManager={
              <DictionaryManager
                agentName={agentName}
                customDictionary={customDictionary}
                newDictionaryWord={newDictionaryWord}
                setNewDictionaryWord={setNewDictionaryWord}
                setCustomDictionary={setCustomDictionary}
                handleAddDictionaryWord={handleAddDictionaryWord}
                handleRemoveDictionaryWord={handleRemoveDictionaryWord}
                showConfirmDialog={showConfirmDialog}
                embedded
              />
            }
          />
        );

      case "prompts":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.prompts.title")}
              description={t("settingsPage.prompts.description")}
            />
            <PromptStudio
              ensureTestAccess={ensurePromptTestAccess}
              canOfferTrial={trialOfferAvailable}
              onUpgradeToPro={() => {
                void (async () => {
                  const result = await ensureProAccessWithTrialPrompt("prompt-studio-test-locked");
                  if (!result.allowed && !result.declinedTrial) {
                    void openLicensePurchasePage("prompt-studio-test-locked");
                  }
                })();
              }}
            />
          </div>
        );

      case "callRecords":
        return <CallRecordsSection showConfirmDialog={showConfirmDialog} />;

      case "privacy":
      case "permissions":
        return (
          <PrivacyPermissionsSection
            permissions={permissionsHook}
            platform={platform}
            telemetryEnabled={telemetryEnabled}
            setTelemetryEnabled={setTelemetryEnabled}
            transcriptionHistoryEnabled={transcriptionHistoryEnabled}
            setTranscriptionHistoryEnabled={setTranscriptionHistoryEnabled}
            preferBuiltInMic={preferBuiltInMic}
            selectedMicDeviceId={selectedMicDeviceId}
            resetAccessibilityPermissions={resetAccessibilityPermissions}
          />
        );

      case "context":
        return (
          <ContextSettingsSection
            contextEnabled={false} // Pass default since component uses IPC state directly
            setContextEnabled={() => {}} // Dummy function since component uses IPC directly
            onOpenDictionary={() => onSectionChange?.("dictionary")}
            reasoningModel={reasoningModel}
            reasoningProvider={reasoningProvider}
            openaiApiKey={openaiApiKey}
            anthropicApiKey={anthropicApiKey}
            geminiApiKey={geminiApiKey}
            openrouterApiKey={openrouterApiKey}
            customReasoningApiKey={customReasoningApiKey}
          />
        );

      case "developer":
        return (
          <DeveloperDataSection
            cachePathHint={cachePathHint}
            isRemovingModels={isRemovingModels}
            onOpenModelCache={() =>
              window.electronAPI?.openModelCacheFolder?.(effectiveModelCacheRoot || undefined)
            }
            onClearModelCache={handleRemoveModels}
            onExportSettings={handleExportSettings}
            onImportSettings={handleImportSettings}
            onResetAppData={() => {
              showConfirmDialog({
                title: t("settingsPage.developer.resetAll.title"),
                description: t("settingsPage.developer.resetAll.description"),
                onConfirm: async () => {
                  try {
                    const result = await window.electronAPI?.cleanupApp?.();
                    if (result?.success) {
                      showAlertDialog({
                        title: t("settingsPage.developer.resetAll.successTitle"),
                        description: t("settingsPage.developer.resetAll.successDescription"),
                      });
                      scheduleApplicationRestart(1000);
                      return;
                    }

                    const firstError = result?.errors?.[0];
                    const details = firstError ? `\n\n${firstError.step}: ${firstError.error}` : "";
                    showAlertDialog({
                      title: t("settingsPage.developer.resetAll.failedTitle"),
                      description: `${t("settingsPage.developer.resetAll.failedDescription")}${details}`,
                    });
                    if (result?.requiresRestart) {
                      scheduleApplicationRestart(2200);
                    }
                  } catch {
                    showAlertDialog({
                      title: t("settingsPage.developer.resetAll.failedTitle"),
                      description: t("settingsPage.developer.resetAll.failedDescription"),
                    });
                  }
                },
                variant: "destructive",
                confirmText: t("settingsPage.developer.resetAll.confirmText"),
              });
            }}
          />
        );

      default:
        return null;
    }
  };

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        onCancel={confirmDialog.onCancel}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <div hidden={activeSection !== "fileTranscription"}>
        <FileTranscriptionSection
          onOpenTranscriptionHistory={onOpenTranscriptionHistory}
          onOpenTranscriptionSettings={onOpenTranscriptionSettings}
          refreshLicenseStatus={refreshLicenseStatus}
          toast={toast}
          requestProAccess={ensureProAccessWithTrialPrompt}
          onUpgradeToPro={showFileTranscriptionProDialog}
          useLocalStreaming={
            typeof window !== "undefined" && localStorage.getItem("useLocalStreaming") === "true"
          }
          localStreamingModelId={
            typeof window !== "undefined"
              ? normalizeStreamingModelId(
                  localStorage.getItem("localStreamingModelId"),
                  getDefaultLocalStreamingModelIdForLocale(uiLanguage)
                )
              : getDefaultLocalStreamingModelIdForLocale(uiLanguage) || DEFAULT_STREAMING_MODEL_ID
          }
          useLocalWhisper={useLocalWhisper}
          localTranscriptionProvider={localTranscriptionProvider}
          whisperModel={whisperModel}
          parakeetModel={parakeetModel}
          paraformerModel={paraformerModel}
          graniteModel={graniteModel}
          cohereModel={cohereModel}
          cloudTranscriptionMode={cloudTranscriptionMode}
          cloudTranscriptionProvider={cloudTranscriptionProvider}
          cloudTranscriptionModel={cloudTranscriptionModel}
        />
      </div>

      {activeSection !== "fileTranscription" ? renderSectionContent() : null}
    </>
  );
}
