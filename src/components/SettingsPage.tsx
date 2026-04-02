import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import {
  RefreshCw,
  Download,
  Upload,
  Command,
  Mic,
  Shield,
  FolderOpen,
  LogOut,
  UserCircle,
  Sun,
  Moon,
  Monitor,
  Cloud,
  Key,
  Sparkles,
  AlertTriangle,
  Loader2,
  Trash2,
} from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { NEON_AUTH_URL, signOut } from "../lib/neonAuth";
import MarkdownRenderer from "./ui/MarkdownRenderer";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import PermissionCard from "./ui/PermissionCard";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { useSettings } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { useAgentName } from "../utils/agentName";
import { useWhisper } from "../hooks/useWhisper";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useUpdater } from "../hooks/useUpdater";

import PromptStudio from "./ui/PromptStudio";
import ReasoningModelSelector from "./ReasoningModelSelector";

import { HotkeyInput } from "./ui/HotkeyInput";
import HotkeyGuidanceAccordion from "./ui/HotkeyGuidanceAccordion";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getPlatform } from "../utils/platform";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import { Toggle } from "./ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import DeveloperSection from "./DeveloperSection";
import EfficiencyOverview from "./EfficiencyOverview";
import CallRecordsSection from "./CallRecordsSection";
import LanguageSelector from "./ui/LanguageSelector";
import { Skeleton } from "./ui/skeleton";
import { Progress } from "./ui/progress";
import { useToast } from "./ui/Toast";
import { useTheme } from "../hooks/useTheme";
import type {
  LicenseStatusResult,
  LocalTranscriptionProvider,
  SherpaStreamingDownloadProgressData,
  SherpaStreamingModelInfo,
} from "../types/electron";
import type { DownloadProgress as ModelDownloadProgress } from "../hooks/useModelDownload";
import logger from "../utils/logger";
import AudioManager from "../helpers/audioManager";
import { SettingsRow } from "./ui/SettingsSection";
import { useUsage } from "../hooks/useUsage";
import { cn } from "./lib/utils";
import { canStartProTrial } from "../utils/proTrial";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { getTranscriptionModeCopy } from "../utils/transcriptionModeCopy";
import {
  getStreamingModelDescription as getStreamingModelDescriptionText,
  getStreamingModelDisplayName,
} from "../utils/streamingModelI18n";
import {
  CHORDVOX_CLOUD_MODE,
  dispatchChordVoxModelsCleared,
  isChordVoxCloudMode,
  isChordVoxCloudProvider,
} from "../utils/chordvoxCloud";
import streamingModels from "../config/streamingModels.json";

const STREAMING_MODELS = streamingModels;
const DEFAULT_STREAMING_MODEL_ID =
  STREAMING_MODELS.find((model) => model.default)?.id || STREAMING_MODELS[0]?.id;

export type SettingsSectionType =
  | "account"
  | "general"
  | "hotkeys"
  | "transcription"
  | "fileTranscription"
  | "dictionary"
  | "aiModels"
  | "callRecords"
  | "agentConfig"
  | "prompts"
  | "permissions"
  | "privacy"
  | "developer";

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
  onOpenTranscriptionHistory?: () => void;
}

type ProAccessResult = {
  allowed: boolean;
  declinedTrial: boolean;
  status: LicenseStatusResult | null;
};

const UI_LANGUAGE_OPTIONS: import("./ui/LanguageSelector").LanguageOption[] = [
  { value: "en", label: "English", flag: "🇺🇸" },
  { value: "es", label: "Español", flag: "🇪🇸" },
  { value: "fr", label: "Français", flag: "🇫🇷" },
  { value: "de", label: "Deutsch", flag: "🇩🇪" },
  { value: "pt", label: "Português", flag: "🇵🇹" },
  { value: "it", label: "Italiano", flag: "🇮🇹" },
  { value: "ru", label: "Русский", flag: "🇷🇺" },
  { value: "ja", label: "日本語", flag: "🇯🇵" },
  { value: "zh-CN", label: "简体中文", flag: "🇨🇳" },
  { value: "zh-TW", label: "繁體中文", flag: "🇹🇼" },
];

const MODIFIER_PARTS = new Set([
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

const SECONDARY_PROFILE_VERIFY_KEYS = [
  "useLocalWhisper",
  "localTranscriptionProvider",
  "whisperModel",
  "parakeetModel",
  "senseVoiceModelPath",
  "senseVoiceBinaryPath",
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

function getModelDisplayValue(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "—";
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

function formatDirectoryDisplay(value: string | null | undefined): string {
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

function joinModelStoragePath(rootPath: string | null | undefined, leaf: string): string {
  const trimmed = String(rootPath || "").trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";

  const separator =
    /^(?:[A-Za-z]:\\|\\\\)/.test(trimmed) || (trimmed.includes("\\") && !trimmed.includes("/"))
      ? "\\"
      : "/";

  return `${trimmed}${separator}${leaf}`;
}

function getCloudProviderLabel(providerId: string): string {
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

function getLocalTranscriptionProviderLabel(providerId: string): string {
  switch ((providerId || "").trim().toLowerCase()) {
    case "nvidia":
      return "NVIDIA Parakeet";
    case "sensevoice":
      return "Others";
    case "whisper":
    default:
      return "OpenAI Whisper";
  }
}

function getSavedCloudProviderLabel(providerId: string, cloudMode?: string): string {
  const normalizedProviderId = (providerId || "").trim().toLowerCase();
  if (normalizedProviderId) {
    if (isChordVoxCloudProvider(normalizedProviderId)) {
      return "ChordVox Cloud";
    }
    return getCloudProviderLabel(providerId);
  }

  return isChordVoxCloudMode(cloudMode) ? "ChordVox Cloud" : "—";
}

function formatSecondaryProfileSummary(
  profile: import("../hooks/useSettings").SecondaryHotkeyProfile,
  t: (key: string, options?: Record<string, unknown>) => string
): { transcription: string; reasoning: string } {
  const transcriptionProvider = profile.useLocalWhisper
    ? getLocalTranscriptionProviderLabel(profile.localTranscriptionProvider)
    : getSavedCloudProviderLabel(
        profile.cloudTranscriptionProvider,
        profile.cloudTranscriptionMode
      );

  const transcriptionModel = profile.useLocalWhisper
    ? profile.localTranscriptionProvider === "nvidia"
      ? getModelDisplayValue(profile.parakeetModel)
      : profile.localTranscriptionProvider === "sensevoice"
        ? getModelDisplayValue(profile.senseVoiceModelPath)
        : getModelDisplayValue(profile.whisperModel)
    : getModelDisplayValue(profile.cloudTranscriptionModel);

  if (!profile.useReasoningModel) {
    return {
      transcription: t("settingsPage.general.hotkey.secondary.profileSavedTranscriptionSummary", {
        provider: transcriptionProvider,
        model: transcriptionModel,
      }),
      reasoning: t("settingsPage.general.hotkey.secondary.profileSavedReasoningDisabled"),
    };
  }

  const reasoningProvider = getSavedCloudProviderLabel(
    profile.reasoningProvider,
    profile.cloudReasoningMode
  );

  return {
    transcription: t("settingsPage.general.hotkey.secondary.profileSavedTranscriptionSummary", {
      provider: transcriptionProvider,
      model: transcriptionModel,
    }),
    reasoning: t("settingsPage.general.hotkey.secondary.profileSavedReasoningSummary", {
      provider: reasoningProvider,
      model: getModelDisplayValue(profile.reasoningModel),
    }),
  };
}

function SettingsPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm divide-y divide-border/30 dark:divide-border-subtle/50 ${className}`}
    >
      {children}
    </div>
  );
}

function SettingsPanelRow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`px-4 py-3 ${className}`}>{children}</div>;
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-[13px] font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
    </div>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/50 bg-card/40 dark:bg-card/20 px-4 py-4 sm:px-5 sm:py-5">
      <div className="mb-4">
        <h3 className="text-[15px] font-semibold text-foreground tracking-tight">{title}</h3>
        {description && (
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/80">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function SubsectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-3">
      <h4 className="text-[13px] font-semibold text-foreground tracking-tight">{title}</h4>
      {description && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/75">{description}</p>
      )}
    </div>
  );
}

function getLicenseStatusLabel(
  status: LicenseStatusResult["status"] | undefined,
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

function getLocalizedLicenseErrorDescription(
  error: string | null | undefined,
  t: (key: string, options?: any) => string
): string | null {
  switch (error) {
    case "LICENSE_SERVER_NOT_CONFIGURED":
      return t("settingsPage.account.desktopLicense.toasts.serverNotReadyDescription");
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

interface TranscriptionSectionProps {
  isSignedIn: boolean;
  modelStorageRoot: string;
  setModelStorageRoot: (root: string) => void;
  cloudTranscriptionMode: string;
  setCloudTranscriptionMode: (mode: string) => void;
  useLocalWhisper: boolean;
  setUseLocalWhisper: (value: boolean) => void;
  updateTranscriptionSettings: (settings: { useLocalWhisper: boolean }) => void;
  cloudTranscriptionProvider: string;
  setCloudTranscriptionProvider: (provider: string) => void;
  cloudTranscriptionModel: string;
  setCloudTranscriptionModel: (model: string) => void;
  localTranscriptionProvider: string;
  setLocalTranscriptionProvider: (provider: LocalTranscriptionProvider) => void;
  whisperModel: string;
  setWhisperModel: (model: string) => void;
  parakeetModel: string;
  setParakeetModel: (model: string) => void;
  senseVoiceModelPath: string;
  setSenseVoiceModelPath: (path: string) => void;
  senseVoiceBinaryPath: string;
  setSenseVoiceBinaryPath: (path: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  doubaoAppId: string;
  setDoubaoAppId: (key: string) => void;
  doubaoAccessToken: string;
  setDoubaoAccessToken: (key: string) => void;
  customTranscriptionApiKey: string;
  setCustomTranscriptionApiKey: (key: string) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl: (url: string) => void;
  showConfirmDialog: (dialog: {
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    variant?: "default" | "destructive";
    onConfirm: () => void;
    onCancel?: () => void;
  }) => void;
  toast: (opts: {
    title: string;
    description: string;
    variant?: "default" | "destructive" | "success";
    duration?: number;
  }) => void;
}

function TranscriptionSection({
  isSignedIn,
  modelStorageRoot,
  setModelStorageRoot,
  cloudTranscriptionMode,
  setCloudTranscriptionMode,
  useLocalWhisper,
  setUseLocalWhisper,
  updateTranscriptionSettings,
  cloudTranscriptionProvider,
  setCloudTranscriptionProvider,
  cloudTranscriptionModel,
  setCloudTranscriptionModel,
  localTranscriptionProvider,
  setLocalTranscriptionProvider,
  whisperModel,
  setWhisperModel,
  parakeetModel,
  setParakeetModel,
  senseVoiceModelPath,
  setSenseVoiceModelPath,
  senseVoiceBinaryPath,
  setSenseVoiceBinaryPath,
  openaiApiKey,
  setOpenaiApiKey,
  groqApiKey,
  setGroqApiKey,
  doubaoAppId,
  setDoubaoAppId,
  doubaoAccessToken,
  setDoubaoAccessToken,
  customTranscriptionApiKey,
  setCustomTranscriptionApiKey,
  cloudTranscriptionBaseUrl,
  setCloudTranscriptionBaseUrl,
  showConfirmDialog,
  toast,
}: TranscriptionSectionProps) {
  const { t, i18n } = useTranslation();
  const isCustomMode = cloudTranscriptionMode === "byok" || useLocalWhisper;
  const isCloudMode = isSignedIn && isChordVoxCloudMode(cloudTranscriptionMode) && !useLocalWhisper;

  // Local streaming mode state
  const [useLocalStreaming, setUseLocalStreaming] = useState(
    () => localStorage.getItem("useLocalStreaming") === "true"
  );
  const [localStreamingModelsDir, setLocalStreamingModelsDir] = useState(
    () => localStorage.getItem("localStreamingModelsDir") || ""
  );
  const [localStreamingModelId, setLocalStreamingModelId] = useState(
    () => localStorage.getItem("localStreamingModelId") || DEFAULT_STREAMING_MODEL_ID
  );
  const [streamingModels, setStreamingModels] = useState<SherpaStreamingModelInfo[]>([]);
  const [downloadingStreamingModelId, setDownloadingStreamingModelId] = useState<string | null>(
    null
  );
  const [deletingStreamingModelId, setDeletingStreamingModelId] = useState<string | null>(null);
  const [isDeletingAllStreamingModels, setIsDeletingAllStreamingModels] = useState(false);
  const [isInstallingStreamingModel, setIsInstallingStreamingModel] = useState(false);
  const [streamingDownloadProgress, setStreamingDownloadProgress] =
    useState<ModelDownloadProgress>({
      percentage: 0,
      downloadedBytes: 0,
      totalBytes: 0,
    });
  const isLocalStreamingMode = useLocalStreaming;
  const streamingCancelRequestedRef = useRef(false);
  const resolvedStreamingModelsDir =
    modelStorageRoot.trim() !== ""
      ? joinModelStoragePath(modelStorageRoot, "streaming-models")
      : localStreamingModelsDir;

  const loadStreamingModels = useCallback(async () => {
    if (!window.electronAPI?.sherpaStreamingGetModels) {
      return;
    }

    const result = await window.electronAPI.sherpaStreamingGetModels({
      modelsDir: resolvedStreamingModelsDir || undefined,
    });
    if (result?.success) {
      setStreamingModels(result.models || []);
    }
  }, [resolvedStreamingModelsDir]);

  // Fetch streaming model info when local streaming is selected
  useEffect(() => {
    if (isLocalStreamingMode) {
      loadStreamingModels();
    }
  }, [isLocalStreamingMode, loadStreamingModels]);

  useEffect(() => {
    const dispose = window.electronAPI?.onSherpaStreamingDownloadProgress?.(
      (_event: unknown, data: SherpaStreamingDownloadProgressData) => {
        if (!data) return;

        if (data.type === "progress") {
          setStreamingDownloadProgress({
            percentage: data.percentage || 0,
            downloadedBytes: data.downloaded_bytes || 0,
            totalBytes: data.total_bytes || 0,
          });
          return;
        }

        if (data.type === "installing") {
          setIsInstallingStreamingModel(true);
          setStreamingDownloadProgress((prev) => ({
            ...prev,
            percentage: 100,
          }));
        }
      }
    );

    return () => {
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (!streamingModels.length) return;

    const currentModel = streamingModels.find((model) => model.id === localStreamingModelId);
    if (currentModel?.isDownloaded) return;

    const fallbackModel =
      streamingModels.find((model) => model.isDownloaded && model.default) ||
      streamingModels.find((model) => model.isDownloaded);

    if (!fallbackModel) return;

    setLocalStreamingModelId(fallbackModel.id);
    localStorage.setItem("localStreamingModelId", fallbackModel.id);
  }, [streamingModels, localStreamingModelId]);

  const handleStreamingModelSelect = useCallback((modelId: string) => {
    setLocalStreamingModelId(modelId);
    localStorage.setItem("localStreamingModelId", modelId);
  }, []);

  const persistStreamingModelsDir = useCallback((dirPath: string) => {
    const normalized = String(dirPath || "").trim();
    setLocalStreamingModelsDir(normalized);
    if (normalized) {
      localStorage.setItem("localStreamingModelsDir", normalized);
    } else {
      localStorage.removeItem("localStreamingModelsDir");
    }
  }, []);

  const persistModelStorageRoot = useCallback(
    (dirPath: string) => {
      const normalized = String(dirPath || "").trim();
      setModelStorageRoot(normalized);
      persistStreamingModelsDir(
        normalized ? joinModelStoragePath(normalized, "streaming-models") : ""
      );
    },
    [persistStreamingModelsDir, setModelStorageRoot]
  );

  const chooseModelStorageRoot = useCallback(async () => {
    const result = await window.electronAPI?.pickModelStorageRoot?.(
      modelStorageRoot || localStreamingModelsDir || undefined
    );

    if (!result?.success || result.cancelled || !result.path) {
      return null;
    }

    persistModelStorageRoot(result.path);
    return result.path;
  }, [localStreamingModelsDir, modelStorageRoot, persistModelStorageRoot]);

  const resetStreamingDownloadState = useCallback(() => {
    setDownloadingStreamingModelId(null);
    setIsInstallingStreamingModel(false);
    setStreamingDownloadProgress({
      percentage: 0,
      downloadedBytes: 0,
      totalBytes: 0,
    });
    streamingCancelRequestedRef.current = false;
  }, []);

  const handleStreamingModelDownload = useCallback(
    async (modelId: string) => {
      if (!window.electronAPI?.sherpaStreamingDownloadModel) {
        return;
      }

      if (downloadingStreamingModelId) {
        toast({
          title: t("settingsPage.transcription.streaming.toasts.downloadInProgressTitle"),
          description: t("settingsPage.transcription.streaming.toasts.downloadInProgressDescription"),
        });
        return;
      }

      setDownloadingStreamingModelId(modelId);
      setIsInstallingStreamingModel(false);
      setStreamingDownloadProgress({
        percentage: 0,
        downloadedBytes: 0,
        totalBytes: 0,
      });

      try {
        const result = await window.electronAPI.sherpaStreamingDownloadModel(
          modelId,
          resolvedStreamingModelsDir || undefined
        );
        if (result?.success) {
          await loadStreamingModels();
          handleStreamingModelSelect(modelId);
          toast({
            title: t("settingsPage.transcription.streaming.toasts.modelReadyTitle"),
            description: t("settingsPage.transcription.streaming.toasts.modelReadyDescription"),
            variant: "success",
            duration: 3000,
          });
          return;
        }

        if (!streamingCancelRequestedRef.current) {
          toast({
            title: t("settingsPage.transcription.streaming.toasts.downloadFailedTitle"),
            description:
              result?.error ||
              t("settingsPage.transcription.streaming.toasts.downloadFailedDescription"),
            variant: "destructive",
            duration: 4000,
          });
        }
      } catch (error) {
        if (!streamingCancelRequestedRef.current) {
          toast({
            title: t("settingsPage.transcription.streaming.toasts.downloadFailedTitle"),
            description:
              error instanceof Error
                ? error.message
                : t("settingsPage.transcription.streaming.toasts.downloadFailedDescription"),
            variant: "destructive",
            duration: 4000,
          });
        }
      } finally {
        await loadStreamingModels();
        resetStreamingDownloadState();
      }
    },
    [
      downloadingStreamingModelId,
      handleStreamingModelSelect,
      loadStreamingModels,
      resolvedStreamingModelsDir,
      resetStreamingDownloadState,
      t,
      toast,
    ]
  );

  const handleStreamingDownloadCancel = useCallback(async () => {
    streamingCancelRequestedRef.current = true;
    await window.electronAPI?.sherpaStreamingCancelDownload?.();
    toast({
      title: t("settingsPage.transcription.streaming.toasts.downloadCancelledTitle"),
      description: t("settingsPage.transcription.streaming.toasts.downloadCancelledDescription"),
      duration: 2500,
    });
  }, [t, toast]);

  const handleStreamingModelDelete = useCallback(
    (modelId: string) => {
      const fallbackName =
        STREAMING_MODELS.find((model) => model.id === modelId)?.nameEn ||
        STREAMING_MODELS.find((model) => model.id === modelId)?.name ||
        modelId;
      const modelLabel = getStreamingModelDisplayName(t, modelId, fallbackName);

      showConfirmDialog({
        title: t("settingsPage.transcription.streaming.toasts.deleteDialogTitle"),
        description: t("settingsPage.transcription.streaming.toasts.deleteDialogDescription", {
          model: modelLabel,
        }),
        confirmText: t("common.delete"),
        cancelText: t("common.cancel"),
        variant: "destructive",
        onConfirm: async () => {
          try {
            setDeletingStreamingModelId(modelId);
            const result = await window.electronAPI?.sherpaStreamingDeleteModel?.(
              modelId,
              resolvedStreamingModelsDir || undefined
            );
            await loadStreamingModels();

            if (result?.success) {
              toast({
                title: t("settingsPage.transcription.streaming.toasts.deleteSuccessTitle"),
                description: t("settingsPage.transcription.streaming.toasts.deleteSuccessDescription", {
                  model: modelLabel,
                }),
                variant: "success",
                duration: 2500,
              });
              return;
            }

            toast({
              title: t("settingsPage.transcription.streaming.toasts.deleteFailedTitle"),
              description:
              result?.error ||
                t("settingsPage.transcription.streaming.toasts.deleteFailedDescription"),
              variant: "destructive",
              duration: 3500,
            });
          } finally {
            setDeletingStreamingModelId(null);
          }
        },
      });
    },
    [loadStreamingModels, resolvedStreamingModelsDir, showConfirmDialog, t, toast]
  );

  const transcriptionModeCopy = useMemo(() => getTranscriptionModeCopy(i18n.language), [i18n.language]);

  const handleDeleteAllStreamingModels = useCallback(() => {
    showConfirmDialog({
      title: transcriptionModeCopy.realTime.clearModelsTitle,
      description: transcriptionModeCopy.realTime.clearModelsDescription,
      confirmText: t("common.deleteAll"),
      cancelText: t("common.cancel"),
      variant: "destructive",
      onConfirm: async () => {
        try {
          setIsDeletingAllStreamingModels(true);
          const result = await window.electronAPI?.sherpaStreamingDeleteAllModels?.(
            resolvedStreamingModelsDir || undefined
          );
          await loadStreamingModels();

          if (result?.success) {
            toast({
              title: transcriptionModeCopy.realTime.clearedModelsTitle,
              description: transcriptionModeCopy.realTime.clearedModelsDescription,
              variant: "success",
              duration: 2500,
            });
            return;
          }

          toast({
            title: t("settingsPage.transcription.streaming.toasts.clearFailedTitle"),
            description:
              result?.error ||
              t("settingsPage.transcription.streaming.toasts.clearFailedDescription"),
            variant: "destructive",
            duration: 3500,
          });
        } finally {
          setIsDeletingAllStreamingModels(false);
        }
      },
    });
  }, [
    loadStreamingModels,
    resolvedStreamingModelsDir,
    showConfirmDialog,
    t,
    toast,
    transcriptionModeCopy,
  ]);

  const getStreamingModelDescription = useCallback(
    (modelId: string) => {
      const fallbackDescription =
        STREAMING_MODELS.find((model) => model.id === modelId)?.nameEn ||
        STREAMING_MODELS.find((model) => model.id === modelId)?.name ||
        "";
      return getStreamingModelDescriptionText(t, modelId, fallbackDescription);
    },
    [t]
  );

  const downloadedStreamingModels = streamingModels.filter((model) => model.isDownloaded);

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.transcription.title")}
        description={t("settingsPage.transcription.description")}
      />

      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.transcription.storageLocation.label")}
            description={t("settingsPage.transcription.storageLocation.description")}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-[260px] rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {formatDirectoryDisplay(modelStorageRoot)}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={chooseModelStorageRoot}>
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {t("common.chooseFolder")}
              </Button>
            </div>
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      {/* Mode selector: 3 modes */}
      <SettingsPanel>
        {/* ⚡ Local Streaming mode (实时转录) */}
        <SettingsPanelRow>
          <button
            onClick={() => {
              if (!isLocalStreamingMode) {
                setUseLocalStreaming(true);
                localStorage.setItem("useLocalStreaming", "true");
                // Deactivate other modes
                setUseLocalWhisper(false);
                updateTranscriptionSettings({ useLocalWhisper: false });
                toast({
                  title: transcriptionModeCopy.realTime.switchedTitle,
                  description: transcriptionModeCopy.realTime.switchedDescription,
                  variant: "success",
                  duration: 3000,
                });
              }
            }}
            className="w-full flex items-center gap-3 text-left cursor-pointer group"
          >
            <div
              className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                isLocalStreamingMode
                  ? "bg-emerald-500/10 dark:bg-emerald-500/15"
                  : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
              }`}
            >
              <svg
                className={`w-4 h-4 transition-colors ${
                  isLocalStreamingMode ? "text-emerald-500" : "text-muted-foreground"
                }`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-foreground">
                  {`⚡ ${transcriptionModeCopy.realTime.label}`}
                </span>
                {isLocalStreamingMode && (
                  <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 dark:bg-emerald-500/15 px-1.5 py-px rounded-sm">
                    {t("common.active")}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                {transcriptionModeCopy.realTime.cardDescription}
              </p>
            </div>
            <div
              className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                isLocalStreamingMode
                  ? "border-emerald-500 bg-emerald-500"
                  : "border-border-hover dark:border-border-subtle"
              }`}
            >
              {isLocalStreamingMode && (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-white" />
                </div>
              )}
            </div>
          </button>
        </SettingsPanelRow>

        {/* 🎯 High-accuracy transcription mode */}
        <SettingsPanelRow>
          <button
            onClick={() => {
              if (isLocalStreamingMode) {
                setCloudTranscriptionMode("byok");
                setUseLocalWhisper(false);
                updateTranscriptionSettings({ useLocalWhisper: false });
                // Deactivate local streaming
                setUseLocalStreaming(false);
                localStorage.setItem("useLocalStreaming", "false");
                toast({
                  title: transcriptionModeCopy.highAccuracy.switchedTitle,
                  description: transcriptionModeCopy.highAccuracy.switchedDescription,
                  variant: "success",
                  duration: 3000,
                });
              }
            }}
            className="w-full flex items-center gap-3 text-left cursor-pointer group"
          >
            <div
              className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                !isLocalStreamingMode
                  ? "bg-accent/10 dark:bg-accent/15"
                  : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
              }`}
            >
              <Key
                className={`w-4 h-4 transition-colors ${
                  !isLocalStreamingMode ? "text-accent" : "text-muted-foreground"
                }`}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-foreground">
                  {`🎯 ${transcriptionModeCopy.highAccuracy.label}`}
                </span>
                {!isLocalStreamingMode && (
                  <span className="text-[10px] font-medium text-accent bg-accent/10 dark:bg-accent/15 px-1.5 py-px rounded-sm">
                    {t("common.active")}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                {transcriptionModeCopy.highAccuracy.cardDescription}
              </p>
            </div>
            <div
              className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                !isLocalStreamingMode
                  ? "border-accent bg-accent"
                  : "border-border-hover dark:border-border-subtle"
              }`}
            >
              {!isLocalStreamingMode && (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent-foreground" />
                </div>
              )}
            </div>
          </button>
        </SettingsPanelRow>
      </SettingsPanel>

      {/* Local Streaming model picker — shown when "实时转录" is active */}
      {isLocalStreamingMode && (
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-4 h-4 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                <span className="text-[12px] font-semibold text-foreground">
                  {transcriptionModeCopy.realTime.modelsLabel}
                </span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 dark:bg-surface-2/50 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-[11px] font-medium text-foreground">
                        {t("settingsPage.transcription.streaming.currentFolderLabel")}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground/70 mt-1 break-all">
                      {formatDirectoryDisplay(resolvedStreamingModelsDir)}
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      {t("settingsPage.transcription.streaming.currentFolderHint")}
                    </p>
                  </div>
                </div>
              </div>
              {downloadingStreamingModelId && (
                <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 dark:bg-emerald-500/10 overflow-hidden">
                  <DownloadProgressBar
                    modelName={
                      getStreamingModelDisplayName(
                        t,
                        downloadingStreamingModelId,
                        STREAMING_MODELS.find((model) => model.id === downloadingStreamingModelId)
                          ?.nameEn ||
                          STREAMING_MODELS.find((model) => model.id === downloadingStreamingModelId)
                            ?.name ||
                          downloadingStreamingModelId ||
                          ""
                      )
                    }
                    progress={streamingDownloadProgress}
                    isInstalling={isInstallingStreamingModel}
                  />
                  <div className="px-2.5 py-2 flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleStreamingDownloadCancel}
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                {STREAMING_MODELS.map((tier) => {
                  const isSelected = localStreamingModelId === tier.id;
                  const modelInfo = streamingModels.find((m) => m.id === tier.id);
                  const isDownloaded = modelInfo?.isDownloaded ?? false;
                  const isDownloading = downloadingStreamingModelId === tier.id;
                  const isDeleting = deletingStreamingModelId === tier.id;
                  const fallbackName = tier.nameEn || tier.name;
                  const displayName = getStreamingModelDisplayName(t, tier.id, fallbackName);
                  return (
                    <div
                      key={tier.id}
                      className={`w-full flex items-center gap-3 text-left px-3 py-2.5 rounded-lg border transition-all ${
                        isSelected
                          ? "border-emerald-500/50 bg-emerald-500/5 dark:bg-emerald-500/10"
                          : "border-transparent hover:bg-muted/50 dark:hover:bg-surface-3/50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (isDownloaded) {
                            handleStreamingModelSelect(tier.id);
                          }
                        }}
                        disabled={!isDownloaded}
                        className="flex-1 flex items-center gap-3 text-left disabled:cursor-not-allowed"
                      >
                        <div
                          className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-colors ${
                            isSelected
                              ? "border-emerald-500 bg-emerald-500"
                              : "border-border-hover dark:border-border-subtle"
                          }`}
                        >
                          {isSelected && (
                            <div className="w-full h-full flex items-center justify-center">
                              <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-foreground">
                              {displayName}
                            </span>
                            <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                              {tier.size}
                            </span>
                            {isDownloaded && (
                              <span className="text-[9px] text-emerald-600 dark:text-emerald-400">✓</span>
                            )}
                            {!isDownloaded && (
                              <span className="text-[9px] text-amber-500">
                                {t("common.downloadRequired")}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                            {getStreamingModelDescription(tier.id)}
                          </p>
                        </div>
                      </button>
                      {!isDownloaded && (
                        <Button
                          type="button"
                          variant={isDownloading ? "secondary" : "outline"}
                          size="sm"
                          disabled={Boolean(downloadingStreamingModelId || deletingStreamingModelId || isDeletingAllStreamingModels)}
                          onClick={() => {
                            if (!isDownloading) {
                              handleStreamingModelDownload(tier.id);
                            }
                          }}
                          className="shrink-0"
                        >
                          {isDownloading ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                              {isInstallingStreamingModel
                                ? t("common.installing")
                                : t("common.downloading")}
                            </>
                          ) : (
                            <>
                              <Download className="w-3.5 h-3.5 mr-1" />
                              {t("common.download")}
                            </>
                          )}
                        </Button>
                      )}
                      {isDownloaded && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={Boolean(downloadingStreamingModelId || deletingStreamingModelId || isDeletingAllStreamingModels)}
                          onClick={() => handleStreamingModelDelete(tier.id)}
                          className="shrink-0"
                        >
                          {isDeleting ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                              {t("common.deleting")}
                            </>
                          ) : (
                            <>
                              <Trash2 className="w-3.5 h-3.5 mr-1" />
                              {t("common.delete")}
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
              {!downloadedStreamingModels.length && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400">
                  {transcriptionModeCopy.realTime.downloadHint}
                </p>
              )}
              {downloadedStreamingModels.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={Boolean(downloadingStreamingModelId || deletingStreamingModelId || isDeletingAllStreamingModels)}
                    onClick={handleDeleteAllStreamingModels}
                  >
                    {isDeletingAllStreamingModels ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                        {t("common.clearing")}
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        {t("settingsPage.transcription.streaming.clearAllButton")}
                      </>
                    )}
                  </Button>
                </div>
              )}
              <p className="text-[10px] text-muted-foreground/60 mt-2">
                {t("settingsPage.transcription.streaming.folderAutoInstallHint")}
              </p>
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      )}

      {/* Transcription model picker — shown when high-accuracy transcription is active */}
      {!isLocalStreamingMode && (
        <TranscriptionModelPicker
          selectedCloudProvider={cloudTranscriptionProvider}
          onCloudProviderSelect={setCloudTranscriptionProvider}
          selectedCloudModel={cloudTranscriptionModel}
          onCloudModelSelect={setCloudTranscriptionModel}
          selectedLocalModel={
            localTranscriptionProvider === "nvidia"
              ? parakeetModel
              : localTranscriptionProvider === "sensevoice"
                ? senseVoiceModelPath
                : whisperModel
          }
          onLocalModelSelect={(modelId, providerId) => {
            const targetProvider = providerId || localTranscriptionProvider;
            if (targetProvider === "nvidia") {
              setParakeetModel(modelId);
            } else if (targetProvider === "sensevoice") {
              setSenseVoiceModelPath(modelId);
            } else {
              setWhisperModel(modelId);
            }
          }}
          selectedLocalProvider={localTranscriptionProvider}
          onLocalProviderSelect={setLocalTranscriptionProvider}
          useLocalWhisper={useLocalWhisper}
          onModeChange={(isLocal) => {
            setUseLocalWhisper(isLocal);
            updateTranscriptionSettings({ useLocalWhisper: isLocal });
            if (isLocal) {
              setCloudTranscriptionMode("byok");
            }
          }}
          openaiApiKey={openaiApiKey}
          setOpenaiApiKey={setOpenaiApiKey}
          groqApiKey={groqApiKey}
          setGroqApiKey={setGroqApiKey}
          doubaoAppId={doubaoAppId}
          setDoubaoAppId={setDoubaoAppId}
          doubaoAccessToken={doubaoAccessToken}
          setDoubaoAccessToken={setDoubaoAccessToken}
          customTranscriptionApiKey={customTranscriptionApiKey}
          setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
          senseVoiceModelPath={senseVoiceModelPath}
          setSenseVoiceModelPath={setSenseVoiceModelPath}
          senseVoiceBinaryPath={senseVoiceBinaryPath}
          setSenseVoiceBinaryPath={setSenseVoiceBinaryPath}
          cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
          setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
          variant="settings"
        />
      )}
    </div>
  );
}

type FileTranscriptionStage =
  | "idle"
  | "preparing"
  | "transcribing"
  | "enhancing"
  | "saving"
  | "complete";

interface FileTranscriptionSectionProps {
  onOpenTranscriptionHistory?: () => void;
  refreshLicenseStatus: () => Promise<void>;
  toast: (opts: {
    title: string;
    description: string;
    variant?: "default" | "destructive" | "success";
    duration?: number;
  }) => void;
  requestProAccess: (source: string) => Promise<ProAccessResult>;
  onUpgradeToPro: () => void;
  useLocalStreaming: boolean;
  localStreamingModelId: string;
  useLocalWhisper: boolean;
  localTranscriptionProvider: string;
  whisperModel: string;
  parakeetModel: string;
  senseVoiceModelPath: string;
  cloudTranscriptionMode: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
}

function FileTranscriptionSection({
  onOpenTranscriptionHistory,
  refreshLicenseStatus,
  toast,
  requestProAccess,
  onUpgradeToPro,
  useLocalStreaming,
  localStreamingModelId,
  useLocalWhisper,
  localTranscriptionProvider,
  whisperModel,
  parakeetModel,
  senseVoiceModelPath,
  cloudTranscriptionMode,
  cloudTranscriptionProvider,
  cloudTranscriptionModel,
}: FileTranscriptionSectionProps) {
  const { t, i18n } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileAudioManagerRef = useRef<AudioManager | null>(null);
  const activeFileNameRef = useRef("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [activeFileName, setActiveFileName] = useState("");
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<FileTranscriptionStage>("idle");

  const isLocalFileRoute = useLocalStreaming || useLocalWhisper;
  const RouteIcon = isLocalFileRoute ? Mic : Cloud;

  const activeProviderLabel = useMemo(() => {
    if (useLocalStreaming) {
      return t("settingsPage.fileTranscription.route.streamingProvider");
    }
    if (useLocalWhisper) {
      return getLocalTranscriptionProviderLabel(localTranscriptionProvider);
    }
    return getSavedCloudProviderLabel(cloudTranscriptionProvider, cloudTranscriptionMode);
  }, [
    cloudTranscriptionMode,
    cloudTranscriptionProvider,
    localTranscriptionProvider,
    t,
    useLocalStreaming,
    useLocalWhisper,
  ]);

  const activeModelLabel = useMemo(() => {
    if (useLocalStreaming) {
      const fallbackName =
        STREAMING_MODELS.find((item) => item.id === localStreamingModelId)?.nameEn ||
        STREAMING_MODELS.find((item) => item.id === localStreamingModelId)?.name ||
        getModelDisplayValue(localStreamingModelId);
      return getStreamingModelDisplayName(t, localStreamingModelId, fallbackName);
    }
    if (useLocalWhisper) {
      if (localTranscriptionProvider === "nvidia") {
        return getModelDisplayValue(parakeetModel);
      }
      if (localTranscriptionProvider === "sensevoice") {
        return getModelDisplayValue(senseVoiceModelPath);
      }
      return getModelDisplayValue(whisperModel);
    }
    return getModelDisplayValue(cloudTranscriptionModel);
  }, [
    cloudTranscriptionModel,
    localTranscriptionProvider,
    localStreamingModelId,
    parakeetModel,
    senseVoiceModelPath,
    t,
    useLocalStreaming,
    useLocalWhisper,
    whisperModel,
  ]);

  const routeTitle = useMemo(() => {
    if (useLocalStreaming) {
      return t("settingsPage.fileTranscription.route.streamingTitle");
    }
    if (isLocalFileRoute) {
      return t("settingsPage.fileTranscription.route.localTitle");
    }
    return t("settingsPage.fileTranscription.route.cloudTitle");
  }, [isLocalFileRoute, t, useLocalStreaming]);

  const routeDescription = useMemo(() => {
    if (useLocalStreaming) {
      return t("settingsPage.fileTranscription.route.streamingDescription");
    }
    if (isLocalFileRoute) {
      return t("settingsPage.fileTranscription.route.localDescription");
    }
    return t("settingsPage.fileTranscription.route.cloudDescription");
  }, [isLocalFileRoute, t, useLocalStreaming]);

  const stageToneClass = useMemo(() => {
    switch (stage) {
      case "complete":
        return "border-success/30 bg-success/10 text-success";
      case "enhancing":
      case "transcribing":
        return "border-primary/30 bg-primary/10 text-primary";
      case "saving":
      case "preparing":
        return "border-warning/30 bg-warning/10 text-warning";
      default:
        return "border-border/50 bg-muted/30 text-muted-foreground";
    }
  }, [stage]);

  useEffect(() => {
    const audioManager = new AudioManager();
    fileAudioManagerRef.current = audioManager;

    audioManager.setCallbacks({
      onStateChange: ({ isProcessing }) => {
        setIsTranscribing(Boolean(isProcessing));
      },
      onProgress: ({ progress: nextProgress, stage: nextStage }) => {
        setProgress(Math.max(0, Math.min(100, Math.round(nextProgress || 0))));
        setStage((nextStage as FileTranscriptionStage) || "idle");
      },
      onPartialTranscript: () => {},
      onAudioLevel: () => {},
      onError: (error) => {
        setIsTranscribing(false);
        setProgress(0);
        setStage("idle");
        toast({
          title:
            error?.code === "LICENSE_REQUIRED"
              ? t("controlPanel.history.fileTranscriptionRequiresProTitle")
              : t("controlPanel.history.couldNotTranscribeFileTitle"),
          description:
            error?.code === "LICENSE_REQUIRED"
              ? t("controlPanel.history.fileTranscriptionRequiresProDescription")
              : error?.description ||
                error?.message ||
                t("controlPanel.history.couldNotTranscribeFileDescription"),
          variant: "destructive",
        });
      },
      onTranscriptionComplete: async (result) => {
        if (!result?.success || !result?.text) {
          return;
        }

        await audioManager.saveTranscription(result.text, {
          recordingDurationMs: result.recordingDurationMs,
        });
        setProgress(100);
        setStage("complete");
        toast({
          title: t("controlPanel.history.transcribedFileTitle"),
          description: t("controlPanel.history.transcribedFileDescription", {
            name: activeFileNameRef.current || t("controlPanel.history.selectedFileFallback"),
          }),
          variant: "success",
          duration: 3000,
        });
      },
    });

    return () => {
      audioManager.cleanup();
      fileAudioManagerRef.current = null;
    };
  }, [t, toast]);

  const ensureFileTranscriptionAccess = useCallback(async () => {
    const result = await requestProAccess("file-transcription");
    await refreshLicenseStatus();
    return result;
  }, [refreshLicenseStatus, requestProAccess]);

  const requestFileTranscription = useCallback(async () => {
    if (isTranscribing) {
      return;
    }

    const { allowed, declinedTrial } = await ensureFileTranscriptionAccess();
    if (!allowed) {
      if (declinedTrial) {
        return;
      }
      toast({
        title: t("controlPanel.history.fileTranscriptionRequiresProTitle"),
        description: t("controlPanel.history.fileTranscriptionRequiresProDescription"),
        variant: "destructive",
      });
      onUpgradeToPro();
      return;
    }

    fileInputRef.current?.click();
  }, [ensureFileTranscriptionAccess, isTranscribing, onUpgradeToPro, t, toast]);

  const handleFileInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) {
        return;
      }

      const { allowed, declinedTrial } = await ensureFileTranscriptionAccess();
      if (!allowed) {
        if (declinedTrial) {
          return;
        }
        toast({
          title: t("controlPanel.history.fileTranscriptionRequiresProTitle"),
          description: t("controlPanel.history.fileTranscriptionRequiresProDescription"),
          variant: "destructive",
        });
        onUpgradeToPro();
        return;
      }

      if (!fileAudioManagerRef.current) {
        toast({
          title: t("controlPanel.history.couldNotTranscribeFileTitle"),
          description: t("controlPanel.history.couldNotTranscribeFileDescription"),
          variant: "destructive",
        });
        return;
      }

      if (file.size <= 0) {
        toast({
          title: t("controlPanel.history.couldNotTranscribeFileTitle"),
          description: t("controlPanel.history.emptyFileDescription"),
          variant: "destructive",
        });
        return;
      }

      activeFileNameRef.current = file.name;
      setActiveFileName(file.name);
      setProgress(5);
      setStage("preparing");

      try {
        await fileAudioManagerRef.current.transcribeFile(file, {
          sourceType: "file",
          sourceFileName: file.name,
          mimeType: file.type || null,
        });
      } catch (error: any) {
        setIsTranscribing(false);
        setProgress(0);
        setStage("idle");
        toast({
          title: t("controlPanel.history.couldNotTranscribeFileTitle"),
          description:
            error?.message || t("controlPanel.history.couldNotTranscribeFileDescription"),
          variant: "destructive",
        });
      }
    },
    [ensureFileTranscriptionAccess, onUpgradeToPro, t, toast]
  );

  return (
    <div className="space-y-4">
      <SectionHeader title={t("settingsPage.fileTranscription.title")} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
        <SectionCard
          title={t("settingsPage.fileTranscription.chooseFile")}
        >
          <div className="space-y-4">
            <div className="rounded-2xl border border-border/50 bg-muted/15 px-4 py-4">
              <div className="flex flex-wrap items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/40 bg-card/70 shadow-sm">
                  <RouteIcon size={18} className="text-foreground/85" />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                      {t("settingsPage.fileTranscription.route.label")}
                    </p>
                  </div>
                  <p className="text-[15px] font-semibold text-foreground">{routeTitle}</p>
                  <p className="text-[12px] leading-relaxed text-muted-foreground/75">
                    {routeDescription}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-border/40 bg-card/60 px-3 py-3">
                  <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
                    {t("settingsPage.fileTranscription.route.provider")}
                  </p>
                  <p className="mt-2 text-[13px] font-semibold text-foreground">
                    {activeProviderLabel}
                  </p>
                </div>
                <div className="rounded-xl border border-border/40 bg-card/60 px-3 py-3">
                  <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
                    {t("settingsPage.fileTranscription.route.model")}
                  </p>
                  <p className="mt-2 text-[13px] font-semibold leading-relaxed text-foreground break-words">
                    {activeModelLabel}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={requestFileTranscription} disabled={isTranscribing} size="sm">
                {isTranscribing ? (
                  <Loader2 size={14} className="mr-1.5 animate-spin" />
                ) : (
                  <FolderOpen size={14} className="mr-1.5" />
                )}
                {isTranscribing
                  ? t("controlPanel.history.transcribeFileProgress", {
                      progress: Math.max(1, Math.round(progress)),
                    })
                  : t("settingsPage.fileTranscription.chooseFile")}
              </Button>
              {onOpenTranscriptionHistory && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenTranscriptionHistory?.()}
                >
                  {t("settingsPage.fileTranscription.historyButton")}
                </Button>
              )}
              <Badge variant="outline" className="h-8 rounded-full px-3 text-[10px]">
                {t("settingsPage.account.badges.pro")}
              </Badge>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title={t("settingsPage.fileTranscription.progressTitle")}
        >
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px] sm:items-start">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                  {t("settingsPage.fileTranscription.currentFile")}
                </p>
                <p className="mt-1 text-[13px] font-semibold leading-relaxed text-foreground break-all">
                  {activeFileName || t("controlPanel.history.selectedFileFallback")}
                </p>
              </div>
              <div className="text-left sm:text-right">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                  {t("settingsPage.fileTranscription.progressLabel")}
                </p>
                <p className="mt-1 text-[22px] font-semibold tabular-nums text-foreground">
                  {Math.round(progress)}%
                </p>
              </div>
            </div>

            <Progress value={progress} className="h-2.5 [&>div]:bg-primary" />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em]",
                  stageToneClass
                )}
              >
                {t(`settingsPage.fileTranscription.stages.short.${stage}`)}
              </span>
            </div>

            <div className="rounded-xl border border-border/40 bg-muted/10 px-3 py-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                {t(`settingsPage.fileTranscription.stages.${stage}`)}
              </p>
            </div>
          </div>
        </SectionCard>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.m4v,.mov,.webm,.mkv"
        onChange={handleFileInputChange}
      />
    </div>
  );
}

interface AiModelsSectionProps {
  isSignedIn: boolean;
  cloudReasoningMode: string;
  setCloudReasoningMode: (mode: string) => void;
  useReasoningModel: boolean;
  setUseReasoningModel: (value: boolean) => void;
  canOfferTrial: boolean;
  requestProAccess: (source: string) => Promise<ProAccessResult>;
  onUpgradeToPro: () => void;
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  reasoningProvider: string;
  setReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (url: string) => void;
  customReasoningProtocol: "auto" | "chat" | "responses";
  setCustomReasoningProtocol: (protocol: "auto" | "chat" | "responses") => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (key: string) => void;
  geminiApiKey: string;
  setGeminiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  openrouterApiKey: string;
  setOpenrouterApiKey: (key: string) => void;
  customReasoningApiKey: string;
  setCustomReasoningApiKey: (key: string) => void;
  showAlertDialog: (dialog: { title: string; description: string }) => void;
  toast: (opts: {
    title: string;
    description: string;
    variant?: "default" | "destructive" | "success";
    duration?: number;
  }) => void;
}

function AiModelsSection({
  isSignedIn,
  cloudReasoningMode,
  setCloudReasoningMode,
  useReasoningModel,
  setUseReasoningModel,
  canOfferTrial,
  requestProAccess,
  onUpgradeToPro,
  reasoningModel,
  setReasoningModel,
  reasoningProvider,
  setReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  customReasoningProtocol,
  setCustomReasoningProtocol,
  openaiApiKey,
  setOpenaiApiKey,
  anthropicApiKey,
  setAnthropicApiKey,
  geminiApiKey,
  setGeminiApiKey,
  groqApiKey,
  setGroqApiKey,
  openrouterApiKey,
  setOpenrouterApiKey,
  customReasoningApiKey,
  setCustomReasoningApiKey,
  showAlertDialog,
  toast,
}: AiModelsSectionProps) {
  const { t, i18n } = useTranslation();
  const isCustomMode = cloudReasoningMode === "byok";
  const isCloudMode = isSignedIn && isChordVoxCloudMode(cloudReasoningMode);
  const handleUseReasoningModelChange = useCallback(
    async (value: boolean) => {
      if (!value) {
        setUseReasoningModel(false);
        return;
      }

      const result = await requestProAccess("ai-models-toggle");
      if (result.allowed) {
        setUseReasoningModel(true);
        return;
      }

      if (!result.declinedTrial) {
        onUpgradeToPro();
      }
    },
    [onUpgradeToPro, requestProAccess, setUseReasoningModel]
  );

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.aiModels.title")}
        description={t("settingsPage.aiModels.description")}
      />

      {/* Enable toggle — always at top */}
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.aiModels.enableTextCleanup")}
            description={t("settingsPage.aiModels.enableTextCleanupDescription")}
          >
            <Toggle checked={useReasoningModel} onChange={handleUseReasoningModelChange} />
          </SettingsRow>
        </SettingsPanelRow>
        {canOfferTrial && !useReasoningModel && (
          <SettingsPanelRow>
            <p className="text-[11px] text-primary/80">
              {t("settingsPage.aiModels.trialHint")}
            </p>
          </SettingsPanelRow>
        )}
      </SettingsPanel>

      {useReasoningModel && (
        <>
          {/* Mode selector */}
          {isSignedIn && (
            <SettingsPanel>
              <SettingsPanelRow>
                <button
                  onClick={() => {
                    if (!isCloudMode) {
                      setCloudReasoningMode(CHORDVOX_CLOUD_MODE);
                      toast({
                        title: t("settingsPage.aiModels.toasts.switchedCloud.title"),
                        description: t("settingsPage.aiModels.toasts.switchedCloud.description"),
                        variant: "success",
                        duration: 3000,
                      });
                    }
                  }}
                  className="w-full flex items-center gap-3 text-left cursor-pointer group"
                >
                  <div
                    className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${isCloudMode
                        ? "bg-primary/10 dark:bg-primary/15"
                        : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
                      }`}
                  >
                    <Cloud
                      className={`w-4 h-4 transition-colors ${isCloudMode ? "text-primary" : "text-muted-foreground"
                        }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-foreground">
                        {t("settingsPage.aiModels.chordvoxCloud")}
                      </span>
                      {isCloudMode && (
                        <span className="text-[10px] font-medium text-primary bg-primary/10 dark:bg-primary/15 px-1.5 py-px rounded-sm">
                          {t("common.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                      {t("settingsPage.aiModels.chordvoxCloudDescription")}
                    </p>
                  </div>
                  <div
                    className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${isCloudMode
                        ? "border-primary bg-primary"
                        : "border-border-hover dark:border-border-subtle"
                      }`}
                  >
                    {isCloudMode && (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
                      </div>
                    )}
                  </div>
                </button>
              </SettingsPanelRow>
              <SettingsPanelRow>
                <button
                  onClick={() => {
                    if (!isCustomMode) {
                      setCloudReasoningMode("byok");
                      toast({
                        title: t("settingsPage.aiModels.toasts.switchedCustom.title"),
                        description: t("settingsPage.aiModels.toasts.switchedCustom.description"),
                        variant: "success",
                        duration: 3000,
                      });
                    }
                  }}
                  className="w-full flex items-center gap-3 text-left cursor-pointer group"
                >
                  <div
                    className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${isCustomMode
                        ? "bg-accent/10 dark:bg-accent/15"
                        : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
                      }`}
                  >
                    <Key
                      className={`w-4 h-4 transition-colors ${isCustomMode ? "text-accent" : "text-muted-foreground"
                        }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-foreground">
                        {t("settingsPage.aiModels.customSetup")}
                      </span>
                      {isCustomMode && (
                        <span className="text-[10px] font-medium text-accent bg-accent/10 dark:bg-accent/15 px-1.5 py-px rounded-sm">
                          {t("common.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                      {t("settingsPage.aiModels.customSetupDescription")}
                    </p>
                  </div>
                  <div
                    className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${isCustomMode
                        ? "border-accent bg-accent"
                        : "border-border-hover dark:border-border-subtle"
                      }`}
                  >
                    {isCustomMode && (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-foreground" />
                      </div>
                    )}
                  </div>
                </button>
              </SettingsPanelRow>
            </SettingsPanel>
          )}

          {/* Custom Setup model picker — shown when Custom Setup is active or not signed in */}
          {(isCustomMode || !isSignedIn) && (
            <ReasoningModelSelector
              useReasoningModel={useReasoningModel}
              setUseReasoningModel={setUseReasoningModel}
              reasoningModel={reasoningModel}
              setReasoningModel={setReasoningModel}
              localReasoningProvider={reasoningProvider}
              setLocalReasoningProvider={setReasoningProvider}
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
              customReasoningApiKey={customReasoningApiKey}
              setCustomReasoningApiKey={setCustomReasoningApiKey}
              showAlertDialog={showAlertDialog}
            />
          )}
        </>
      )}
    </div>
  );
}

export default function SettingsPage({
  activeSection = "general",
  onOpenTranscriptionHistory,
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
    senseVoiceModelPath,
    senseVoiceBinaryPath,
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
    doubaoAppId,
    doubaoAccessToken,
    dictationKey,
    dictationKeySecondary,
    secondaryHotkeyProfile,
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
    setSenseVoiceModelPath,
    setSenseVoiceBinaryPath,
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
    setDoubaoAppId,
    setDoubaoAccessToken,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
    customReasoningApiKey,
    setCustomReasoningApiKey,
    setDictationKey,
    setDictationKeySecondary,
    captureSecondaryHotkeyProfileFromCurrent,
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
    cloudBackupEnabled,
    setCloudBackupEnabled,
    telemetryEnabled,
    setTelemetryEnabled,
    transcriptionHistoryEnabled,
    setTranscriptionHistoryEnabled,
  } = useSettings();

  const { t, i18n } = useTranslation();
  const { toast } = useToast();

  const dictationCueStyleOptions = useMemo(
    () => [
      { value: "off", label: t("settingsPage.general.soundEffects.cueStyles.off") },
      { value: "electronic", label: t("settingsPage.general.soundEffects.cueStyles.electronic") },
      { value: "droplet1", label: t("settingsPage.general.soundEffects.cueStyles.droplet1") },
      { value: "droplet2", label: t("settingsPage.general.soundEffects.cueStyles.droplet2") },
    ],
    [t]
  );

  const recordingAnimationOptions = useMemo(
    () => [
      { value: "line", label: t("settingsPage.general.floatingIcon.animationStyles.line") },
      {
        value: "particles",
        label: t("settingsPage.general.floatingIcon.animationStyles.particles"),
      },
      { value: "level", label: t("settingsPage.general.floatingIcon.animationStyles.level") },
    ],
    [t]
  );

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
  const cachePathHint = formatDirectoryDisplay(modelStorageRoot);

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
  const [secondaryProfileSaveFeedback, setSecondaryProfileSaveFeedback] = useState<{
    ok: boolean;
    message: string;
    at: number;
  } | null>(null);
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
  const usage = useUsage();
  const hasProAccess = licenseStatus ? Boolean(licenseStatus.isActive) : true;
  const isSecondaryHotkeyLocked = Boolean(licenseStatus) && !hasProAccess;
  const secondaryProfileSummary = useMemo(
    () =>
      secondaryHotkeyProfile ? formatSecondaryProfileSummary(secondaryHotkeyProfile, t) : null,
    [secondaryHotkeyProfile, t]
  );
  const hasShownApproachingToast = useRef(false);
  useEffect(() => {
    if (usage?.isApproachingLimit && !hasShownApproachingToast.current) {
      hasShownApproachingToast.current = true;
      toast({
        title: t("settingsPage.account.toasts.approachingLimit.title"),
        description: t("settingsPage.account.toasts.approachingLimit.description", {
          used: usage.wordsUsed.toLocaleString(i18n.language),
          limit: usage.limit.toLocaleString(i18n.language),
        }),
        duration: 6000,
      });
    }
  }, [usage?.isApproachingLimit, usage?.wordsUsed, usage?.limit, toast, t, i18n.language]);

  const refreshLicenseStatus = useCallback(async () => {
    if (!window.electronAPI?.licenseGetStatus) return;
    try {
      const result = await window.electronAPI.licenseGetStatus();
      setLicenseStatus(result);
    } catch (error) {
      logger.error("Failed to load license status", error, "license");
    }
  }, []);

  useEffect(() => {
    refreshLicenseStatus();
  }, [refreshLicenseStatus]);

  const trialOfferAvailable = canStartProTrial(licenseStatus);

  const promptToStartProTrial = useCallback(async () => {
    return new Promise<boolean>((resolve) => {
      showConfirmDialog({
        title: t("settingsPage.account.trialStartDialog.title"),
        description: t("settingsPage.account.trialStartDialog.description"),
        confirmText: t("settingsPage.account.trialStartDialog.confirm"),
        cancelText: t("settingsPage.account.trialStartDialog.cancel"),
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }, [showConfirmDialog, t]);

  const ensureProAccessWithTrialPrompt = useCallback(
    async (_source: string): Promise<ProAccessResult> => {
      if (!window.electronAPI?.licenseEnsureProAccess && !window.electronAPI?.licenseGetStatus) {
        return { allowed: false, declinedTrial: false, status: null };
      }

      let currentStatus: LicenseStatusResult | null = null;

      if (window.electronAPI?.licenseGetStatus) {
        try {
          currentStatus = await window.electronAPI.licenseGetStatus();
        } catch (_error) {
          currentStatus = null;
        }
      }

      if (currentStatus?.isActive) {
        await refreshLicenseStatus();
        return { allowed: true, declinedTrial: false, status: currentStatus };
      }

      if (canStartProTrial(currentStatus)) {
        const confirmed = await promptToStartProTrial();
        if (!confirmed) {
          await refreshLicenseStatus();
          return { allowed: false, declinedTrial: true, status: currentStatus };
        }
      }

      try {
        const nextStatus = window.electronAPI.licenseEnsureProAccess
          ? await window.electronAPI.licenseEnsureProAccess()
          : currentStatus;
        await refreshLicenseStatus();
        return {
          allowed: Boolean(nextStatus?.isActive),
          declinedTrial: false,
          status: nextStatus || currentStatus,
        };
      } catch (_error) {
        await refreshLicenseStatus();
        return { allowed: false, declinedTrial: false, status: currentStatus };
      }
    },
    [promptToStartProTrial, refreshLicenseStatus]
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
    if (!window.electronAPI?.licenseActivate) return;
    const licenseKey = licenseKeyInput.trim();
    setLicenseValidationFeedback(null);
    if (!licenseKey) {
      toast({
        title: t("settingsPage.account.desktopLicense.toasts.keyRequiredTitle"),
        description: t("settingsPage.account.desktopLicense.toasts.keyRequiredDescription"),
        variant: "destructive",
      });
      return;
    }

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
  }, [licenseKeyInput, t, toast]);

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
    setLicenseValidationFeedback(null);

    showConfirmDialog({
      title: t("settingsPage.account.desktopLicense.dialogs.removeTitle"),
      description: t("settingsPage.account.desktopLicense.dialogs.removeDescription"),
      confirmText: t("settingsPage.account.desktopLicense.dialogs.removeConfirm"),
      variant: "destructive",
      onConfirm: async () => {
        setLicenseBusyAction("clear");
        try {
          const result = await window.electronAPI.licenseClear();
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

      if (
        /^Right(Control|Ctrl|Alt|Option|Shift|Super|Win|Meta|Command|Cmd)$/i.test(normalized)
      ) {
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

  const [isSecondaryHotkeyRegistering, setIsSecondaryHotkeyRegistering] = useState(false);

  const registerSecondaryHotkey = useCallback(
    async (hotkey: string) => {
      if (!hotkey || !hotkey.trim()) {
        try {
          setIsSecondaryHotkeyRegistering(true);
          await window.electronAPI?.updateSecondaryHotkey?.("");
          setDictationKeySecondary("");
          return true;
        } finally {
          setIsSecondaryHotkeyRegistering(false);
        }
      }

      if (!hasProAccess) {
        const access = await ensureProAccessWithTrialPrompt("secondary-hotkey");
        if (!access.allowed) {
          if (!access.declinedTrial) {
            showSecondaryHotkeyRequiresPro();
          }
          return false;
        }
      }

      const validationError = validateSecondaryHotkeyForInput(hotkey);
      if (validationError) {
        showAlertDialog({
          title: t("hooks.hotkeyRegistration.titles.invalidHotkey"),
          description: validationError,
        });
        return false;
      }

      if (!window.electronAPI?.updateSecondaryHotkey) {
        setDictationKeySecondary(hotkey);
        return true;
      }

      try {
        setIsSecondaryHotkeyRegistering(true);
        const result = await window.electronAPI.updateSecondaryHotkey(hotkey);
        if (!result?.success) {
          if (result?.code === "LICENSE_REQUIRED") {
            showSecondaryHotkeyRequiresPro();
            return false;
          }
          showAlertDialog({
            title: t("hooks.hotkeyRegistration.titles.notRegistered"),
            description:
              result?.message || t("settingsPage.general.hotkey.secondary.registerFailed"),
          });
          return false;
        }

        setDictationKeySecondary(hotkey);
        toast({
          title: t("settingsPage.general.hotkey.secondary.savedTitle"),
          description: t("settingsPage.general.hotkey.secondary.savedDescription"),
          variant: "success",
        });
        return true;
      } catch (error) {
        showAlertDialog({
          title: t("hooks.hotkeyRegistration.titles.error"),
          description:
            error instanceof Error
              ? error.message
              : t("settingsPage.general.hotkey.secondary.registerRetry"),
        });
        return false;
      } finally {
        setIsSecondaryHotkeyRegistering(false);
      }
    },
    [
      ensureProAccessWithTrialPrompt,
      hasProAccess,
      setDictationKeySecondary,
      showAlertDialog,
      showSecondaryHotkeyRequiresPro,
      t,
      toast,
      validateSecondaryHotkeyForInput,
    ]
  );

  const saveCurrentAsSecondaryProfile = useCallback(async () => {
    const savedAt = Date.now();
    if (!hasProAccess) {
      const access = await ensureProAccessWithTrialPrompt("secondary-hotkey-profile");
      if (!access.allowed) {
        if (!access.declinedTrial) {
          showSecondaryHotkeyRequiresPro();
        }
        return;
      }
    }
    try {
      const profile = captureSecondaryHotkeyProfileFromCurrent();
      const rawSavedProfile = localStorage.getItem("secondaryHotkeyProfile");
      const persistedProfile = rawSavedProfile ? JSON.parse(rawSavedProfile) : null;
      const persisted =
        persistedProfile &&
        typeof persistedProfile === "object" &&
        SECONDARY_PROFILE_VERIFY_KEYS.every((key) =>
          Object.is((persistedProfile as Record<string, unknown>)[key], profile[key])
        );

      if (!persisted) {
        throw new Error("secondary profile persistence verification failed");
      }

      const feedbackMessage = t("settingsPage.general.hotkey.secondary.profileSavedVerifiedAt", {
        time: new Date(savedAt).toLocaleTimeString(),
      });
      setSecondaryProfileSaveFeedback({ ok: true, message: feedbackMessage, at: savedAt });
      toast({
        title: t("settingsPage.general.hotkey.secondary.profileSavedTitle"),
        description: t("settingsPage.general.hotkey.secondary.profileSavedDescription"),
        variant: "success",
      });
    } catch (error) {
      logger.error("Failed to save secondary hotkey profile", error, "settings");
      const feedbackMessage = t("settingsPage.general.hotkey.secondary.profileSaveFailed");
      setSecondaryProfileSaveFeedback({ ok: false, message: feedbackMessage, at: savedAt });
      toast({
        title: t("settingsPage.general.hotkey.secondary.profileSaveFailedTitle"),
        description: feedbackMessage,
        variant: "destructive",
      });
    }
  }, [
    captureSecondaryHotkeyProfileFromCurrent,
    ensureProAccessWithTrialPrompt,
    hasProAccess,
    showSecondaryHotkeyRequiresPro,
    t,
    toast,
  ]);

  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);

  const platform = useMemo(() => {
    if (typeof window !== "undefined" && window.electronAPI?.getPlatform) {
      return window.electronAPI.getPlatform();
    }
    return "linux";
  }, []);

  const [newDictionaryWord, setNewDictionaryWord] = useState("");

  const handleAddDictionaryWord = useCallback(() => {
    const word = newDictionaryWord.trim();
    if (word && !customDictionary.includes(word)) {
      setCustomDictionary([...customDictionary, word]);
      setNewDictionaryWord("");
    }
  }, [newDictionaryWord, customDictionary, setCustomDictionary]);

  const handleRemoveDictionaryWord = useCallback(
    (wordToRemove: string) => {
      if (wordToRemove === agentName) return;
      setCustomDictionary(customDictionary.filter((word) => word !== wordToRemove));
    },
    [customDictionary, setCustomDictionary, agentName]
  );

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);

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
        const info = await window.electronAPI?.getHotkeyModeInfo();
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

  const collectSettingsSnapshot = useCallback(async () => {
    const localStorageData: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key);
      if (value !== null) {
        localStorageData[key] = value;
      }
    }

    const dictionary =
      (await window.electronAPI?.getDictionary?.().catch(() => [])) ||
      [];
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
      localStorage: localStorageData,
      dictionary: Array.isArray(dictionary) ? dictionary : [],
      runtime: {
        dictationKey,
        activationMode,
        licenseApiBaseUrl,
      },
    };
  }, [currentVersion, getAppVersion]);

  const handleExportSettings = useCallback(async () => {
    if (!window.electronAPI?.exportSettingsFile) return;
    try {
      const snapshot = await collectSettingsSnapshot();
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
    async (data: any) => {
      if (!data || typeof data !== "object") {
        throw new Error("Invalid settings payload");
      }

      const localStorageData =
        data.localStorage && typeof data.localStorage === "object" ? data.localStorage : data;

      if (!localStorageData || typeof localStorageData !== "object") {
        throw new Error("Invalid localStorage data");
      }

      localStorage.clear();
      Object.entries(localStorageData).forEach(([key, value]) => {
        localStorage.setItem(key, String(value ?? ""));
      });

      const parsedDictionary = (() => {
        if (Array.isArray(data.dictionary)) return data.dictionary;
        const raw = localStorageData.customDictionary;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === "string") {
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : null;
          } catch {
            return null;
          }
        }
        return null;
      })();

      if (parsedDictionary && window.electronAPI?.setDictionary) {
        await window.electronAPI.setDictionary(
          parsedDictionary
            .filter((word: any) => typeof word === "string")
            .map((word: string) => word.trim())
            .filter(Boolean)
        );
      }

      const dictationKey = data?.runtime?.dictationKey || localStorageData.dictationKey;
      if (typeof dictationKey === "string" && window.electronAPI?.saveDictationKey) {
        await window.electronAPI.saveDictationKey(dictationKey);
      }

      const activationMode = data?.runtime?.activationMode || localStorageData.activationMode;
      if (
        (activationMode === "tap" || activationMode === "push") &&
        window.electronAPI?.saveActivationMode
      ) {
        await window.electronAPI.saveActivationMode(activationMode);
      }

      const licenseApiBaseUrl =
        data?.runtime?.licenseApiBaseUrl || localStorageData.licenseApiBaseUrl;
      if (typeof licenseApiBaseUrl === "string" && window.electronAPI?.saveLicenseApiBaseUrl) {
        await window.electronAPI.saveLicenseApiBaseUrl(licenseApiBaseUrl);
      }

      if (window.electronAPI?.saveAllKeysToEnv) {
        await window.electronAPI.saveAllKeysToEnv();
      }

      if (window.electronAPI?.syncStartupPreferences) {
        const localProviderRaw = String(localStorageData.localTranscriptionProvider || "whisper");
        const localProvider: LocalTranscriptionProvider =
          localProviderRaw === "nvidia" || localProviderRaw === "sensevoice"
            ? localProviderRaw
            : "whisper";
        const useLocalWhisperValue = String(localStorageData.useLocalWhisper || "true") !== "false";
        const reasoningProviderValue = String(localStorageData.reasoningProvider || "openai");

        let model = String(localStorageData.whisperModel || "turbo");
        if (localProvider === "nvidia") {
          model = String(localStorageData.parakeetModel || "");
        } else if (localProvider === "sensevoice") {
          model = String(localStorageData.senseVoiceModelPath || "");
        }

        await window.electronAPI.syncStartupPreferences({
          useLocalWhisper: useLocalWhisperValue,
          localTranscriptionProvider: localProvider,
          model: model || undefined,
          senseVoiceBinaryPath:
            localProvider === "sensevoice" && localStorageData.senseVoiceBinaryPath
              ? String(localStorageData.senseVoiceBinaryPath)
              : undefined,
          reasoningProvider: reasoningProviderValue,
          reasoningModel:
            reasoningProviderValue === "local" && localStorageData.reasoningModel
              ? String(localStorageData.reasoningModel)
              : undefined,
        });
      }
    },
    []
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
            await applyImportedSettings(importedData);
            showAlertDialog({
              title: t("settingsPage.developer.settingsTransfer.importSuccessTitle"),
              description: t("settingsPage.developer.settingsTransfer.importSuccessDescription"),
            });
            setTimeout(() => {
              window.location.reload();
            }, 800);
          } catch (error) {
            showAlertDialog({
              title: t("settingsPage.developer.settingsTransfer.importFailedTitle"),
              description: t("settingsPage.developer.settingsTransfer.importFailedDescription"),
            });
          }
        },
        variant: "destructive",
      });
    } catch (error) {
      showAlertDialog({
        title: t("settingsPage.developer.settingsTransfer.importFailedTitle"),
        description: t("settingsPage.developer.settingsTransfer.importFailedDescription"),
      });
    }
  }, [applyImportedSettings, showAlertDialog, showConfirmDialog, t]);

  const { isSignedIn, isLoaded, user } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isOpeningBilling, setIsOpeningBilling] = useState(false);

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await signOut();
      window.location.reload();
    } catch (error) {
      logger.error("Sign out failed", error, "auth");
      showAlertDialog({
        title: t("settingsPage.account.signOut.failedTitle"),
        description: t("settingsPage.account.signOut.failedDescription"),
      });
    } finally {
      setIsSigningOut(false);
    }
  }, [showAlertDialog, t]);

  const openLicensePurchasePage = useCallback(
    async (source: string, extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({
        source,
        lang: i18n.language || "en",
        ...extra,
      });
      const result = await window.electronAPI?.openExternal?.(
        `https://chordvox.com/?${params.toString()}#pricing`
      );
      if (result && result.success === false) {
        toast({
          title: t("settingsPage.account.checkout.couldNotOpenTitle"),
          description: t("settingsPage.account.checkout.couldNotOpenDescription"),
          variant: "destructive",
        });
      }
    },
    [i18n.language, t, toast]
  );

  const startProTrialFromAccount = useCallback(async () => {
    const result = await ensureProAccessWithTrialPrompt("account-trial-card");
    if (!result.allowed) {
      if (!result.declinedTrial) {
        void openLicensePurchasePage("start-pro-trial");
      }
      return;
    }

    toast({
      title: t("settingsPage.account.trialStartDialog.startedTitle"),
      description: t("settingsPage.account.trialStartDialog.startedDescription"),
      variant: "success",
    });
  }, [ensureProAccessWithTrialPrompt, openLicensePurchasePage, t, toast]);

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

  const renderHotkeysSection = () => (
    <div className="space-y-5">
      <SectionHeader
        title={t("settingsPage.general.hotkey.title")}
        description={t("settingsPage.general.hotkey.description")}
      />

      <SettingsPanel>
        <SettingsPanelRow>
          <HotkeyInput
            value={dictationKey}
            onChange={async (newHotkey) => {
              await registerHotkey(newHotkey);
            }}
            disabled={isHotkeyRegistering}
            validate={validateHotkeyForInput}
            captureScope="primary"
          />
        </SettingsPanelRow>

        <SettingsPanelRow>
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-foreground">
                  {t("settingsPage.general.hotkey.secondary.title")}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/80 leading-relaxed">
                  {t("settingsPage.general.hotkey.secondary.requiresProDescription")}
                </p>
              </div>
              <Badge variant="outline">{t("settingsPage.account.badges.pro")}</Badge>
            </div>

            {isSecondaryHotkeyLocked && (
              <Alert
                variant="warning"
                className="dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200 dark:[&>svg]:text-amber-400"
              >
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{t("settingsPage.general.hotkey.secondary.requiresProTitle")}</AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>{t("settingsPage.general.hotkey.secondary.requiresProDescription")}</p>
                  <Button
                    size="sm"
                    onClick={async () => {
                      const result = await ensureProAccessWithTrialPrompt("secondary-hotkey-locked");
                      if (!result.allowed && !result.declinedTrial) {
                        void openLicensePurchasePage("secondary-hotkey-locked");
                      }
                    }}
                    className="w-full sm:w-auto"
                  >
                    {trialOfferAvailable
                      ? t("settingsPage.account.trialStartDialog.confirm")
                      : t("settingsPage.account.checkout.upgradeToPro")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            <HotkeyInput
              value={dictationKeySecondary}
              onChange={async (newHotkey) => {
                await registerSecondaryHotkey(newHotkey);
              }}
              disabled={isSecondaryHotkeyRegistering}
              validate={validateSecondaryHotkeyForInput}
              captureScope="secondary"
            />

            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground/80">
                {secondaryHotkeyProfile
                  ? t("settingsPage.general.hotkey.secondary.profileSavedState")
                  : t("settingsPage.general.hotkey.secondary.profileUnsavedState")}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={saveCurrentAsSecondaryProfile}
                className="h-7 px-2 text-[11px]"
              >
                {t("settingsPage.general.hotkey.secondary.saveCurrentAsProfile2")}
              </Button>
            </div>

            {secondaryProfileSummary && (
              <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground/90">
                <p>{secondaryProfileSummary.transcription}</p>
                <p className="mt-1">{secondaryProfileSummary.reasoning}</p>
              </div>
            )}

            {secondaryProfileSaveFeedback && (
              <p
                className={cn(
                  "text-[11px]",
                  secondaryProfileSaveFeedback.ok ? "text-success" : "text-destructive"
                )}
                key={secondaryProfileSaveFeedback.at}
              >
                {secondaryProfileSaveFeedback.message}
              </p>
            )}

          </div>
        </SettingsPanelRow>

        {!isUsingGnomeHotkeys && (
          <SettingsPanelRow>
            <p className="text-[11px] font-medium text-muted-foreground/80 mb-2">
              {t("settingsPage.general.hotkey.activationMode")}
            </p>
            <ActivationModeSelector value={activationMode} onChange={setActivationMode} />
          </SettingsPanelRow>
        )}
      </SettingsPanel>
    </div>
  );

  const renderLicensePanel = () => {
    const status = licenseStatus?.status;
    const isActive = Boolean(licenseStatus?.isActive);
    const keyPresent = Boolean(licenseStatus?.keyPresent);
    const isTrial = licenseStatus?.plan === "trial" && !keyPresent;
    const showKeyInput = !isActive || !keyPresent || showLicenseKeyInput;
    const licenseBadgeVariant: "success" | "warning" | "destructive" | "outline" =
      status === "active"
        ? "success"
        : status === "offline_grace"
          ? "warning"
          : status === "expired" || status === "invalid"
            ? "destructive"
            : "outline";

    const currentStatusDescription =
      licenseStatus?.error === "LICENSE_SERVER_NOT_CONFIGURED"
        ? t("settingsPage.account.desktopLicense.currentStatusNotConfigured")
        : getLocalizedLicenseErrorDescription(licenseStatus?.error, t) ||
        (isTrial
          ? licenseStatus?.trialActive
            ? t("settingsPage.account.desktopLicense.currentStatusTrialDescription", {
              days: licenseStatus?.trialDaysLeft ?? licenseStatus?.trialDays ?? 0,
            })
            : t("settingsPage.account.desktopLicense.currentStatusTrialExpiredDescription")
          : licenseStatus?.isActive
            ? t("settingsPage.account.desktopLicense.currentStatusActiveDescription")
            : t("settingsPage.account.desktopLicense.currentStatusDescription"));
    const currentStatusLabel = isTrial
      ? t("settingsPage.account.desktopLicense.statusLabels.trial")
      : getLicenseStatusLabel(status, t);
    const shouldShowTrialReminder =
      isTrial && (licenseStatus?.trialDaysLeft === 7 || licenseStatus?.trialDaysLeft === 1);

    return (
      <div className="space-y-3">
        <SectionHeader title={t("settingsPage.account.desktopLicense.title")} />
        {trialOfferAvailable && (
          <Alert className="border-primary/20 bg-primary/5 dark:bg-primary/10">
            <Sparkles className="h-4 w-4" />
            <AlertTitle>{t("settingsPage.account.trialCta.title")}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{t("settingsPage.account.trialCta.description")}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void startProTrialFromAccount()}>
                  {t("settingsPage.account.trialCta.button")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void openLicensePurchasePage("desktop-license-trial-offer");
                  }}
                >
                  {t("settingsPage.account.trialReminder.button")}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {shouldShowTrialReminder && (
          <Alert className="border-primary/20 bg-primary/5 dark:bg-primary/10">
            <Sparkles className="h-4 w-4" />
            <AlertTitle>
              {t("settingsPage.account.trialReminder.title", {
                days: licenseStatus?.trialDaysLeft,
              })}
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {t("settingsPage.account.trialReminder.description", {
                  days: licenseStatus?.trialDaysLeft,
                })}
              </p>
              <Button
                size="sm"
                onClick={() =>
                  openLicensePurchasePage("pro-trial-reminder", {
                    days: String(licenseStatus?.trialDaysLeft || ""),
                  })
                }
              >
                {t("settingsPage.account.trialReminder.button")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.account.desktopLicense.currentStatusLabel")}
              description={currentStatusDescription}
            >
              <Badge variant={licenseBadgeVariant}>{currentStatusLabel}</Badge>
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <div className="space-y-3">
              {showKeyInput && (
                <Input
                  value={licenseKeyInput}
                  onChange={(event) => setLicenseKeyInput(event.target.value)}
                  placeholder={t("settingsPage.account.desktopLicense.inputPlaceholder")}
                  className="h-8 text-sm"
                />
              )}

              <div className="flex items-center gap-2">
                {showKeyInput ? (
                  <Button
                    size="sm"
                    onClick={handleActivateLicense}
                    disabled={licenseBusyAction !== null}
                  >
                    {licenseBusyAction === "activate" ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        {t("settingsPage.account.desktopLicense.actions.activating")}
                      </>
                    ) : (
                      t("settingsPage.account.desktopLicense.actions.activate")
                    )}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowLicenseKeyInput(true)}
                    disabled={licenseBusyAction !== null}
                  >
                    {t("settingsPage.account.desktopLicense.actions.changeKey")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleValidateLicense}
                  disabled={licenseBusyAction !== null || !keyPresent}
                >
                  {licenseBusyAction === "validate" ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      {t("settingsPage.account.desktopLicense.actions.checking")}
                    </>
                  ) : (
                    t("settingsPage.account.desktopLicense.actions.validate")
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleClearLicense}
                  disabled={licenseBusyAction !== null || !keyPresent}
                >
                  {t("settingsPage.account.desktopLicense.actions.clear")}
                </Button>
              </div>
              {licenseBusyAction === "validate" && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 size={12} className="animate-spin shrink-0" />
                  <span>{t("settingsPage.account.desktopLicense.toasts.validatingDescription")}</span>
                </div>
              )}
              {licenseBusyAction !== "validate" && licenseValidationFeedback && (
                <Alert
                  variant={licenseValidationFeedback.ok ? "success" : "destructive"}
                  className="py-2"
                >
                  <AlertTitle className="text-[12px]">
                    {licenseValidationFeedback.title}
                  </AlertTitle>
                  <AlertDescription className="text-[11px]">
                    <div className="space-y-1">
                      <p>{licenseValidationFeedback.description}</p>
                      <p className="text-current/70">
                        {new Date(licenseValidationFeedback.at).toLocaleString(i18n.language)}
                      </p>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              {licenseStatus?.plan && (
                <p className="text-[11px] text-muted-foreground">
                  {t("settingsPage.account.desktopLicense.meta.plan", { plan: licenseStatus.plan })}
                </p>
              )}
              {licenseStatus?.expiresAt && (
                <p className="text-[11px] text-muted-foreground">
                  {t("settingsPage.account.desktopLicense.meta.expires", {
                    date: new Date(licenseStatus.expiresAt).toLocaleString(i18n.language),
                  })}
                </p>
              )}
              {!licenseStatus?.expiresAt && isActive && keyPresent && !isTrial && (
                <p className="text-[11px] text-muted-foreground">
                  {t("settingsPage.account.desktopLicense.meta.expiresPermanent")}
                </p>
              )}
              {licenseStatus?.lastValidatedAt && (
                <p className="text-[11px] text-muted-foreground">
                  {t("settingsPage.account.desktopLicense.meta.lastCheck", {
                    date: new Date(licenseStatus.lastValidatedAt).toLocaleString(i18n.language),
                  })}
                </p>
              )}
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    );
  };

  const renderSectionContent = () => {
    const renderDictionaryManager = (showPageHeader = false, embedded = false) => (
      <div className={embedded ? "space-y-4" : "space-y-5"}>
        {showPageHeader && (
          <SectionHeader
            title={t("settingsPage.dictionary.title")}
            description={t("settingsPage.dictionary.description")}
          />
        )}

        <div>
          {!showPageHeader && !embedded && (
            <SectionHeader
              title={t("settingsPage.dictionary.title")}
              description={t("settingsPage.dictionary.description")}
            />
          )}

          <SettingsPanel>
            <SettingsPanelRow>
              <div className="space-y-2">
                <p className="text-[13px] font-semibold text-foreground tracking-tight">
                  {t("settingsPage.dictionary.addWordOrPhrase")}
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder={t("settingsPage.dictionary.placeholder")}
                    value={newDictionaryWord}
                    onChange={(e) => setNewDictionaryWord(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleAddDictionaryWord();
                      }
                    }}
                    className="flex-1 h-8 text-[12px]"
                  />
                  <Button
                    onClick={handleAddDictionaryWord}
                    disabled={!newDictionaryWord.trim()}
                    size="sm"
                    className="h-8"
                  >
                    {t("settingsPage.dictionary.add")}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground/50">
                  {t("settingsPage.dictionary.pressEnterToAdd")}
                </p>
              </div>
            </SettingsPanelRow>
          </SettingsPanel>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[13px] font-semibold text-foreground tracking-tight">
              {t("settingsPage.dictionary.yourWords")}
              {customDictionary.length > 0 && (
                <span className="ml-1.5 text-muted-foreground/50 font-normal text-[11px]">
                  {customDictionary.length}
                </span>
              )}
            </p>
            {customDictionary.length > 0 && (
              <button
                onClick={() => {
                  showConfirmDialog({
                    title: t("settingsPage.dictionary.clearDictionaryTitle"),
                    description: t("settingsPage.dictionary.clearDictionaryDescription"),
                    confirmText: t("settingsPage.dictionary.clearAll"),
                    variant: "destructive",
                    onConfirm: () =>
                      setCustomDictionary(customDictionary.filter((w) => w === agentName)),
                  });
                }}
                className="text-[10px] text-muted-foreground/40 hover:text-destructive transition-colors"
              >
                {t("settingsPage.dictionary.clearAll")}
              </button>
            )}
          </div>

          {customDictionary.length > 0 ? (
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="flex flex-wrap gap-1">
                  {customDictionary.map((word) => {
                    const isAgentName = word === agentName;
                    return (
                      <span
                        key={word}
                        className={`group inline-flex items-center gap-0.5 py-0.5 rounded-[5px] text-[11px] border transition-all ${
                          isAgentName
                            ? "pl-2 pr-2 bg-primary/10 dark:bg-primary/15 text-primary border-primary/20 dark:border-primary/30"
                            : "pl-2 pr-1 bg-primary/5 dark:bg-primary/10 text-foreground border-border/30 dark:border-border-subtle hover:border-destructive/40 hover:bg-destructive/5"
                        }`}
                        title={
                          isAgentName
                            ? t("settingsPage.dictionary.agentNameAutoManaged")
                            : undefined
                        }
                      >
                        {word}
                        {!isAgentName && (
                          <button
                            onClick={() => handleRemoveDictionaryWord(word)}
                            className="ml-0.5 p-0.5 rounded-sm text-muted-foreground/40 hover:text-destructive transition-colors"
                            title={t("settingsPage.dictionary.removeWord")}
                          >
                            <svg
                              width="9"
                              height="9"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                            >
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          ) : (
            <div className="rounded-lg border border-dashed border-border/40 dark:border-border-subtle py-6 flex flex-col items-center justify-center text-center">
              <p className="text-[11px] text-muted-foreground/50">
                {t("settingsPage.dictionary.noWords")}
              </p>
              <p className="text-[10px] text-muted-foreground/40 mt-0.5">
                {t("settingsPage.dictionary.wordsAppearHere")}
              </p>
            </div>
          )}
        </div>

        <div>
          <SubsectionHeader title={t("settingsPage.dictionary.howItWorksTitle")} />
          <SettingsPanel>
            <SettingsPanelRow>
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                {t("settingsPage.dictionary.howItWorksDescription")}
              </p>
            </SettingsPanelRow>
            <SettingsPanelRow>
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">
                  {t("settingsPage.dictionary.tipLabel")}
                </span>{" "}
                {t("settingsPage.dictionary.tipDescription")}
              </p>
            </SettingsPanelRow>
          </SettingsPanel>
        </div>
      </div>
    );

    switch (activeSection) {
      case "account":
        return (
          <div className="space-y-5">
            {renderLicensePanel()}
            {NEON_AUTH_URL && (isLoaded && isSignedIn && user ? (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 overflow-hidden bg-primary/10 dark:bg-primary/15">
                        {user.image ? (
                          <img
                            src={user.image}
                            alt={user.name || t("settingsPage.account.user")}
                            className="w-10 h-10 rounded-full object-cover"
                          />
                        ) : (
                          <UserCircle className="w-5 h-5 text-primary" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-foreground truncate">
                          {user.name || t("settingsPage.account.user")}
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
                      </div>
                      <Badge variant="success">{t("settingsPage.account.signedIn")}</Badge>
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SectionHeader title={t("settingsPage.account.planTitle")} />
                {!usage || !usage.hasLoaded ? (
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <div className="flex items-center justify-between">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-5 w-16 rounded-full" />
                      </div>
                    </SettingsPanelRow>
                    <SettingsPanelRow>
                      <div className="space-y-2">
                        <Skeleton className="h-3 w-48" />
                        <Skeleton className="h-8 w-full rounded" />
                      </div>
                    </SettingsPanelRow>
                  </SettingsPanel>
                ) : (
                  <SettingsPanel>
                    {usage.isPastDue && (
                      <SettingsPanelRow>
                        <Alert
                          variant="warning"
                          className="dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200 dark:[&>svg]:text-amber-400"
                        >
                          <AlertTriangle className="h-4 w-4" />
                          <AlertTitle>{t("settingsPage.account.pastDue.title")}</AlertTitle>
                          <AlertDescription>
                            {t("settingsPage.account.pastDue.description")}
                          </AlertDescription>
                        </Alert>
                      </SettingsPanelRow>
                    )}

                    <SettingsPanelRow>
                      <SettingsRow
                        label={
                          usage.isTrial
                            ? t("settingsPage.account.planLabels.trial")
                            : usage.isPastDue
                              ? t("settingsPage.account.planLabels.free")
                              : usage.isSubscribed
                                ? t("settingsPage.account.planLabels.pro")
                                : t("settingsPage.account.planLabels.free")
                        }
                        description={
                          usage.isTrial
                            ? t("settingsPage.account.planDescriptions.trial", {
                              days: usage.trialDaysLeft,
                            })
                            : usage.isPastDue
                              ? t("settingsPage.account.planDescriptions.pastDue", {
                                used: usage.wordsUsed.toLocaleString(i18n.language),
                                limit: usage.limit.toLocaleString(i18n.language),
                              })
                              : usage.isSubscribed
                                ? usage.currentPeriodEnd
                                  ? t("settingsPage.account.planDescriptions.nextBilling", {
                                    date: new Date(usage.currentPeriodEnd).toLocaleDateString(
                                      i18n.language,
                                      { month: "short", day: "numeric", year: "numeric" }
                                    ),
                                  })
                                  : t("settingsPage.account.planDescriptions.unlimited")
                                : t("settingsPage.account.planDescriptions.freeUsage", {
                                  used: usage.wordsUsed.toLocaleString(i18n.language),
                                  limit: usage.limit.toLocaleString(i18n.language),
                                })
                        }
                      >
                        {usage.isTrial ? (
                          <Badge variant="info">{t("settingsPage.account.badges.trial")}</Badge>
                        ) : usage.isPastDue ? (
                          <Badge variant="destructive">
                            {t("settingsPage.account.badges.pastDue")}
                          </Badge>
                        ) : usage.isSubscribed ? (
                          <Badge variant="success">{t("settingsPage.account.badges.pro")}</Badge>
                        ) : usage.isOverLimit ? (
                          <Badge variant="warning">
                            {t("settingsPage.account.badges.limitReached")}
                          </Badge>
                        ) : (
                          <Badge variant="outline">{t("settingsPage.account.badges.free")}</Badge>
                        )}
                      </SettingsRow>
                    </SettingsPanelRow>

                    {!usage.isSubscribed && !usage.isTrial && (
                      <SettingsPanelRow>
                        <div className="space-y-1.5">
                          <Progress
                            value={
                              usage.limit > 0
                                ? Math.min(100, (usage.wordsUsed / usage.limit) * 100)
                                : 0
                            }
                            className={cn(
                              "h-1.5",
                              usage.isOverLimit
                                ? "[&>div]:bg-destructive"
                                : usage.isApproachingLimit
                                  ? "[&>div]:bg-warning"
                                  : "[&>div]:bg-primary"
                            )}
                          />
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span className="tabular-nums">
                              {usage.wordsUsed.toLocaleString(i18n.language)} /{" "}
                              {usage.limit.toLocaleString(i18n.language)}
                            </span>
                            {usage.isApproachingLimit && (
                              <span className="text-warning">
                                {t("settingsPage.account.wordsRemaining", {
                                  remaining: usage.wordsRemaining.toLocaleString(i18n.language),
                                })}
                              </span>
                            )}
                            {!usage.isApproachingLimit && !usage.isOverLimit && (
                              <span>{t("settingsPage.account.rollingWeeklyLimit")}</span>
                            )}
                          </div>
                        </div>
                      </SettingsPanelRow>
                    )}

                    <SettingsPanelRow>
                      {usage.isPastDue ? (
                        <Button
                          onClick={async () => {
                            setIsOpeningBilling(true);
                            try {
                              const result = await usage.openBillingPortal();
                              if (!result.success) {
                                toast({
                                  title: t("settingsPage.account.billing.couldNotOpenTitle"),
                                  description: t(
                                    "settingsPage.account.billing.couldNotOpenDescription"
                                  ),
                                  variant: "destructive",
                                });
                              }
                            } finally {
                              setIsOpeningBilling(false);
                            }
                          }}
                          disabled={isOpeningBilling}
                          size="sm"
                          className="w-full"
                        >
                          {isOpeningBilling ? (
                            <>
                              <Loader2 size={14} className="animate-spin" />
                              {t("settingsPage.account.billing.opening")}
                            </>
                          ) : (
                            t("settingsPage.account.billing.updatePaymentMethod")
                          )}
                        </Button>
                      ) : usage.isSubscribed && !usage.isTrial ? (
                        <Button
                          onClick={async () => {
                            const result = await usage.openBillingPortal();
                            if (!result.success) {
                              toast({
                                title: t("settingsPage.account.billing.couldNotOpenTitle"),
                                description: t(
                                  "settingsPage.account.billing.couldNotOpenDescription"
                                ),
                                variant: "destructive",
                              });
                            }
                          }}
                          variant="outline"
                          size="sm"
                          className="w-full"
                          disabled={usage.checkoutLoading}
                        >
                          {usage.checkoutLoading
                            ? t("settingsPage.account.billing.opening")
                            : t("settingsPage.account.billing.manageBilling")}
                        </Button>
                      ) : (
                        <Button
                          onClick={async () => {
                            const result = await usage.openCheckout();
                            if (!result.success) {
                              toast({
                                title: t("settingsPage.account.checkout.couldNotOpenTitle"),
                                description: t(
                                  "settingsPage.account.checkout.couldNotOpenDescription"
                                ),
                                variant: "destructive",
                              });
                            }
                          }}
                          size="sm"
                          className="w-full"
                          disabled={usage.checkoutLoading}
                        >
                          {usage.checkoutLoading
                            ? t("settingsPage.account.checkout.opening")
                            : t("settingsPage.account.checkout.upgradeToPro")}
                        </Button>
                      )}
                    </SettingsPanelRow>
                  </SettingsPanel>
                )}

                <SettingsPanel>
                  <SettingsPanelRow>
                    <Button
                      onClick={handleSignOut}
                      variant="outline"
                      disabled={isSigningOut}
                      size="sm"
                      className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
                    >
                      <LogOut className="mr-1.5 h-3.5 w-3.5" />
                      {isSigningOut
                        ? t("settingsPage.account.signOut.signingOut")
                        : t("settingsPage.account.signOut.signOut")}
                    </Button>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded ? (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.notSignedIn")}
                      description={t("settingsPage.account.notSignedInDescription")}
                    >
                      <Badge variant="outline">{t("settingsPage.account.offline")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <div className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/3 dark:bg-primary/6 p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center shrink-0 mt-0.5">
                      <Sparkles className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2.5">
                      <div>
                        <p className="text-[13px] font-medium text-foreground">
                          {t("settingsPage.account.trialCta.title")}
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                          {t("settingsPage.account.trialCta.description")}
                        </p>
                      </div>
                      <Button
                        onClick={() => {
                          if (trialOfferAvailable) {
                            void startProTrialFromAccount();
                            return;
                          }
                          void openLicensePurchasePage("upgrade-pro");
                        }}
                        size="sm"
                        className="w-full"
                      >
                        <UserCircle className="mr-1.5 h-3.5 w-3.5" />
                        {trialOfferAvailable
                          ? t("settingsPage.account.trialCta.button")
                          : t("settingsPage.account.trialReminder.button")}
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ))}

            <div className="border-t border-border/40 pt-5">
              <EfficiencyOverview />
            </div>
          </div>
        );

      case "general":
        return (
          <div className="space-y-6">
            {/* Updates */}
            <div>
              <SectionHeader title={t("settingsPage.general.updates.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.updates.currentVersion")}
                    description={
                      updateStatus.isDevelopment
                        ? t("settingsPage.general.updates.devMode")
                        : isUpdateAvailable
                          ? t("settingsPage.general.updates.newVersionAvailable")
                          : t("settingsPage.general.updates.latestVersion")
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-[13px] tabular-nums text-muted-foreground font-mono">
                        {currentVersion || t("settingsPage.general.updates.versionPlaceholder")}
                      </span>
                      {updateStatus.isDevelopment ? (
                        <Badge variant="warning">
                          {t("settingsPage.general.updates.badges.dev")}
                        </Badge>
                      ) : isUpdateAvailable ? (
                        <Badge variant="success">
                          {t("settingsPage.general.updates.badges.update")}
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          {t("settingsPage.general.updates.badges.latest")}
                        </Badge>
                      )}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <div className="space-y-2.5">
                    <Button
                      onClick={async () => {
                        try {
                          const result = await checkForUpdates();
                          if (result?.updateAvailable) {
                            if (result.manualOnly && result.manualDownloadUrl) {
                              showConfirmDialog({
                                title: t(
                                  "settingsPage.general.updates.dialogs.manualUpdateAvailable.title"
                                ),
                                description: t(
                                  "settingsPage.general.updates.dialogs.manualUpdateAvailable.description",
                                  {
                                    version:
                                      result.version ||
                                      t("settingsPage.general.updates.newVersion"),
                                  }
                                ),
                                confirmText: t(
                                  "settingsPage.general.updates.dialogs.manualUpdateAvailable.confirmText"
                                ),
                                onConfirm: async () => {
                                  await window.electronAPI.openExternal(result.manualDownloadUrl);
                                },
                              });
                            } else {
                              showConfirmDialog({
                                title: t(
                                  "settingsPage.general.updates.dialogs.updateAvailable.title"
                                ),
                                description: t(
                                  "settingsPage.general.updates.dialogs.updateAvailable.description",
                                  {
                                    version:
                                      result.version ||
                                      t("settingsPage.general.updates.newVersion"),
                                  }
                                ),
                                confirmText: t("settingsPage.general.updates.downloadUpdate", {
                                  version: result.version || "",
                                }),
                                onConfirm: async () => {
                                  try {
                                    await downloadUpdate();
                                  } catch (error: any) {
                                    showAlertDialog({
                                      title: t(
                                        "settingsPage.general.updates.dialogs.downloadFailed.title"
                                      ),
                                      description: t(
                                        "settingsPage.general.updates.dialogs.downloadFailed.description"
                                      ),
                                    });
                                  }
                                },
                              });
                            }
                          } else if (result?.error) {
                            showAlertDialog({
                              title: t("settingsPage.general.updates.dialogs.checkFailed.title"),
                              description: t(
                                "settingsPage.general.updates.dialogs.checkFailed.description",
                                {
                                  message: result.error,
                                }
                              ),
                            });
                          } else {
                            showAlertDialog({
                              title: t("settingsPage.general.updates.dialogs.noUpdates.title"),
                              description: t(
                                "settingsPage.general.updates.dialogs.noUpdates.description"
                              ),
                            });
                          }
                        } catch (error: any) {
                          showAlertDialog({
                            title: t("settingsPage.general.updates.dialogs.noUpdates.title"),
                            description: t("settingsPage.general.updates.dialogs.noUpdates.description"),
                          });
                        }
                      }}
                      disabled={checkingForUpdates || updateStatus.isDevelopment}
                      variant="outline"
                      className="w-full"
                      size="sm"
                    >
                      <RefreshCw
                        size={13}
                        className={`mr-1.5 ${checkingForUpdates ? "animate-spin" : ""}`}
                      />
                      {checkingForUpdates
                        ? t("settingsPage.general.updates.checking")
                        : t("settingsPage.general.updates.checkForUpdates")}
                    </Button>

                    {isUpdateAvailable && !updateStatus.updateDownloaded && (
                      <div className="space-y-2">
                        <Button
                          onClick={async () => {
                            try {
                              if (isManualUpdate && manualUpdateUrl) {
                                await window.electronAPI.openExternal(manualUpdateUrl);
                              } else {
                                await downloadUpdate();
                              }
                            } catch (error: any) {
                              showAlertDialog({
                                title: t(
                                  "settingsPage.general.updates.dialogs.downloadFailed.title"
                                ),
                                description: t(
                                  "settingsPage.general.updates.dialogs.downloadFailed.description"
                                ),
                              });
                            }
                          }}
                          disabled={downloadingUpdate}
                          variant="success"
                          className="w-full"
                          size="sm"
                        >
                          <Download
                            size={13}
                            className={`mr-1.5 ${downloadingUpdate ? "animate-pulse" : ""}`}
                          />
                          {isManualUpdate
                            ? t("settingsPage.general.updates.openReleasePage")
                            : downloadingUpdate
                              ? t("settingsPage.general.updates.downloading", {
                                progress: Math.round(updateDownloadProgress),
                              })
                              : t("settingsPage.general.updates.downloadUpdate", {
                                version: updateInfo?.version || "",
                              })}
                        </Button>

                        {downloadingUpdate && (
                          <div className="h-1 w-full overflow-hidden rounded-full bg-muted/50">
                            <div
                              className="h-full bg-success transition-all duration-200 rounded-full"
                              style={{
                                width: `${Math.min(100, Math.max(0, updateDownloadProgress))}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {updateStatus.updateDownloaded && (
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.general.updates.dialogs.installUpdate.title"),
                            description: t(
                              "settingsPage.general.updates.dialogs.installUpdate.description",
                              { version: updateInfo?.version || "" }
                            ),
                            confirmText: t(
                              "settingsPage.general.updates.dialogs.installUpdate.confirmText"
                            ),
                            onConfirm: async () => {
                              try {
                                await installUpdateAction();
                              } catch (error: any) {
                                showAlertDialog({
                                  title: t(
                                    "settingsPage.general.updates.dialogs.installFailed.title"
                                  ),
                                  description: t(
                                    "settingsPage.general.updates.dialogs.installFailed.description"
                                  ),
                                });
                              }
                            },
                          });
                        }}
                        disabled={installInitiated}
                        className="w-full"
                        size="sm"
                      >
                        <RefreshCw
                          size={14}
                          className={`mr-2 ${installInitiated ? "animate-spin" : ""}`}
                        />
                        {installInitiated
                          ? t("settingsPage.general.updates.restarting")
                          : t("settingsPage.general.updates.installAndRestart")}
                      </Button>
                    )}
                  </div>

                  {(checkingForUpdates || formattedUpdateLastCheckedAt) && (
                    <p className="text-[11px] text-muted-foreground/75">
                      {checkingForUpdates
                        ? t("settingsPage.general.updates.checking")
                        : t("settingsPage.account.desktopLicense.meta.lastCheck", {
                            date: formattedUpdateLastCheckedAt,
                          })}
                    </p>
                  )}

                  {updateInfo?.releaseNotes && (
                    <div className="mt-4 pt-4 border-t border-border/30">
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        {t("settingsPage.general.updates.whatsNew", {
                          version: updateInfo.version,
                        })}
                      </p>
                      <div className="text-[12px] text-muted-foreground">
                        <MarkdownRenderer content={updateInfo.releaseNotes} />
                      </div>
                    </div>
                  )}
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Appearance */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.appearance.title")}
                description={t("settingsPage.general.appearance.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.appearance.theme")}
                    description={t("settingsPage.general.appearance.themeDescription")}
                  >
                    <div className="inline-flex items-center gap-px p-0.5 bg-muted/60 dark:bg-surface-2 rounded-md">
                      {(
                        [
                          {
                            value: "light",
                            icon: Sun,
                            label: t("settingsPage.general.appearance.light"),
                          },
                          {
                            value: "dark",
                            icon: Moon,
                            label: t("settingsPage.general.appearance.dark"),
                          },
                          {
                            value: "auto",
                            icon: Monitor,
                            label: t("settingsPage.general.appearance.auto"),
                          },
                        ] as const
                      ).map((option) => {
                        const Icon = option.icon;
                        const isSelected = theme === option.value;
                        return (
                          <button
                            key={option.value}
                            onClick={() => setTheme(option.value)}
                            className={`
                              flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-[11px] font-medium
                              transition-all duration-100
                              ${isSelected
                                ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                              }
                            `}
                          >
                            <Icon className={`w-3 h-3 ${isSelected ? "text-primary" : ""}`} />
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Sound Effects */}
            <div>
              <SectionHeader title={t("settingsPage.general.soundEffects.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.soundEffects.dictationSounds")}
                    description={t("settingsPage.general.soundEffects.dictationSoundsDescription")}
                  >
                    <Select
                      value={selectedCueStyleValue}
                      onValueChange={handleDictationCueStyleChange}
                    >
                      <SelectTrigger className="w-[196px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {dictationCueStyleOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Floating Icon */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.floatingIcon.title")}
                description={t("settingsPage.general.floatingIcon.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.floatingIcon.recordingAnimation")}
                    description={t(
                      "settingsPage.general.floatingIcon.recordingAnimationDescription"
                    )}
                  >
                    <Select
                      value={recordingAnimationStyle}
                      onValueChange={(value) =>
                        setRecordingAnimationStyle(
                          value === "line" || value === "particles" ? value : "level"
                        )
                      }
                    >
                      <SelectTrigger className="w-[196px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {recordingAnimationOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Language */}
            <div>
              <SectionHeader
                title={t("settings.language.sectionTitle")}
                description={t("settings.language.sectionDescription")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.uiLabel")}
                    description={t("settings.language.uiDescription")}
                  >
                    <LanguageSelector
                      value={uiLanguage}
                      onChange={setUiLanguage}
                      options={UI_LANGUAGE_OPTIONS}
                      className="min-w-32"
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.transcriptionLabel")}
                    description={t("settings.language.transcriptionDescription")}
                  >
                    <LanguageSelector
                      value={preferredLanguage}
                      onChange={(value) =>
                        updateTranscriptionSettings({ preferredLanguage: value })
                      }
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Startup */}
            <div>
              <SectionHeader title={t("settingsPage.general.startup.title")} />
              <SettingsPanel>
                {platform !== "linux" && (
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.general.startup.launchAtLogin")}
                      description={t("settingsPage.general.startup.launchAtLoginDescription")}
                    >
                      <Toggle
                        checked={autoStartEnabled}
                        onChange={(checked: boolean) => handleAutoStartChange(checked)}
                        disabled={autoStartLoading}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                )}
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.startup.autoCheckUpdate")}
                    description={t("settingsPage.general.startup.autoCheckUpdateDescription")}
                  >
                    <Toggle
                      checked={autoCheckUpdateEnabled}
                      onChange={(checked: boolean) => handleAutoCheckUpdateChange(checked)}
                      disabled={autoCheckUpdateLoading}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Microphone */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.microphone.title")}
                description={t("settingsPage.general.microphone.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <MicrophoneSettings
                    preferBuiltInMic={preferBuiltInMic}
                    selectedMicDeviceId={selectedMicDeviceId}
                    onPreferBuiltInChange={setPreferBuiltInMic}
                    onDeviceSelect={setSelectedMicDeviceId}
                  />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      case "hotkeys":
        return renderHotkeysSection();

      case "transcription":
        return (
          <TranscriptionSection
            isSignedIn={isSignedIn ?? false}
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
            senseVoiceModelPath={senseVoiceModelPath}
            setSenseVoiceModelPath={setSenseVoiceModelPath}
            senseVoiceBinaryPath={senseVoiceBinaryPath}
            setSenseVoiceBinaryPath={setSenseVoiceBinaryPath}
            openaiApiKey={openaiApiKey}
            setOpenaiApiKey={setOpenaiApiKey}
            groqApiKey={groqApiKey}
            setGroqApiKey={setGroqApiKey}
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

      case "fileTranscription":
        return (
          <FileTranscriptionSection
            onOpenTranscriptionHistory={onOpenTranscriptionHistory}
            refreshLicenseStatus={refreshLicenseStatus}
            toast={toast}
            requestProAccess={ensureProAccessWithTrialPrompt}
            onUpgradeToPro={() => {
              void openLicensePurchasePage("file-transcription-locked");
            }}
            useLocalStreaming={
              typeof window !== "undefined" && localStorage.getItem("useLocalStreaming") === "true"
            }
            localStreamingModelId={
              (typeof window !== "undefined" && localStorage.getItem("localStreamingModelId")) ||
              DEFAULT_STREAMING_MODEL_ID
            }
            useLocalWhisper={useLocalWhisper}
            localTranscriptionProvider={localTranscriptionProvider}
            whisperModel={whisperModel}
            parakeetModel={parakeetModel}
            senseVoiceModelPath={senseVoiceModelPath}
            cloudTranscriptionMode={cloudTranscriptionMode}
            cloudTranscriptionProvider={cloudTranscriptionProvider}
            cloudTranscriptionModel={cloudTranscriptionModel}
          />
        );

      case "dictionary":
        return renderDictionaryManager(true);

      case "aiModels":
        return (
          <AiModelsSection
            isSignedIn={isSignedIn ?? false}
            cloudReasoningMode={cloudReasoningMode}
            setCloudReasoningMode={setCloudReasoningMode}
            useReasoningModel={useReasoningModel}
            setUseReasoningModel={(value) => {
              setUseReasoningModel(value);
              updateReasoningSettings({ useReasoningModel: value });
            }}
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
            customReasoningApiKey={customReasoningApiKey}
            setCustomReasoningApiKey={setCustomReasoningApiKey}
            showAlertDialog={showAlertDialog}
            toast={toast}
          />
        );

      case "agentConfig":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.agentConfig.title")}
              description={t("settingsPage.agentConfig.description")}
            />

            <SectionCard
              title={t("settingsPage.agentConfig.title")}
              description={t("settingsPage.agentConfig.description")}
            >
              <div className="space-y-5">
                <div>
                  <SubsectionHeader
                    title={t("settingsPage.agentConfig.agentName")}
                    description={t("settingsPage.agentConfig.helper")}
                  />
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <Input
                            placeholder={t("settingsPage.agentConfig.placeholder")}
                            value={agentNameInput}
                            onChange={(e) => setAgentNameInput(e.target.value)}
                            className="flex-1 text-center text-base font-mono"
                          />
                          <Button
                            onClick={() => {
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
                            disabled={!agentNameInput.trim()}
                            size="sm"
                          >
                            {t("settingsPage.agentConfig.save")}
                          </Button>
                        </div>
                      </div>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>

                <div>
                  <SubsectionHeader title={t("settingsPage.agentConfig.howItWorksTitle")} />
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <p className="text-[12px] text-muted-foreground leading-relaxed">
                        {t("settingsPage.agentConfig.howItWorksDescription", { agentName })}
                      </p>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>

                <div>
                  <SubsectionHeader title={t("settingsPage.agentConfig.examplesTitle")} />
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <div className="space-y-2.5">
                        {[
                          {
                            input: `Hi ${agentName}, write a formal email about the budget`,
                            mode: t("settingsPage.agentConfig.instructionMode"),
                          },
                          {
                            input: `Hi ${agentName}, make this more professional`,
                            mode: t("settingsPage.agentConfig.instructionMode"),
                          },
                          {
                            input: `Hi ${agentName}, convert this to bullet points`,
                            mode: t("settingsPage.agentConfig.instructionMode"),
                          },
                          {
                            input: t("settingsPage.agentConfig.cleanupExample"),
                            mode: t("settingsPage.agentConfig.cleanupMode"),
                          },
                        ].map((example, i) => (
                          <div key={i} className="flex items-start gap-3">
                            <span
                              className={`shrink-0 mt-0.5 text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded ${example.mode === t("settingsPage.agentConfig.instructionMode")
                                  ? "bg-primary/10 text-primary dark:bg-primary/15"
                                  : "bg-muted text-muted-foreground"
                                }`}
                            >
                              {example.mode}
                            </span>
                            <p className="text-[12px] text-muted-foreground leading-relaxed">
                              "{example.input}"
                            </p>
                          </div>
                        ))}
                      </div>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title={t("settingsPage.dictionary.title")}
              description={t("settingsPage.dictionary.description")}
            >
              {renderDictionaryManager(false, true)}
            </SectionCard>
          </div>
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
        return <CallRecordsSection />;

      case "privacy":
      case "permissions":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.permissions.title")}
            />

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.9fr)] xl:items-start">
              <div className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <SectionHeader
                    title={t("settingsPage.permissions.systemTitle")}
                    description={t("settingsPage.permissions.systemDescription")}
                  />
                  <div className="flex flex-wrap gap-2 sm:pt-0.5">
                    <Badge
                      variant={permissionsHook.micPermissionGranted ? "success" : "warning"}
                      className="text-[10px]"
                    >
                      {t("settingsPage.permissions.microphoneTitle")}
                    </Badge>
                    {platform === "darwin" && (
                      <Badge
                        variant={
                          permissionsHook.accessibilityPermissionGranted ? "success" : "warning"
                        }
                        className="text-[10px]"
                      >
                        {t("settingsPage.permissions.accessibilityTitle")}
                      </Badge>
                    )}
                  </div>
                </div>

                <SettingsPanel className="overflow-hidden">
                  <SettingsPanelRow>
                    <div className="grid gap-3 md:grid-cols-2">
                      <PermissionCard
                        icon={Mic}
                        title={t("settingsPage.permissions.microphoneTitle")}
                        description={t("settingsPage.permissions.microphoneDescription")}
                        granted={permissionsHook.micPermissionGranted}
                        onRequest={permissionsHook.requestMicPermission}
                        buttonText={t("settingsPage.permissions.test")}
                        onOpenSettings={permissionsHook.openMicPrivacySettings}
                      />

                      {platform === "darwin" && (
                        <PermissionCard
                          icon={Shield}
                          title={t("settingsPage.permissions.accessibilityTitle")}
                          description={t("settingsPage.permissions.accessibilityDescription")}
                          granted={permissionsHook.accessibilityPermissionGranted}
                          onRequest={permissionsHook.testAccessibilityPermission}
                          buttonText={t("settingsPage.permissions.testAndGrant")}
                          onOpenSettings={permissionsHook.openAccessibilitySettings}
                        />
                      )}
                    </div>
                  </SettingsPanelRow>
                  {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
                    <SettingsPanelRow className="pt-0">
                      <MicPermissionWarning
                        error={permissionsHook.micPermissionError}
                        onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                        onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
                      />
                    </SettingsPanelRow>
                  )}
                  {platform === "linux" &&
                    permissionsHook.pasteToolsInfo &&
                    !permissionsHook.pasteToolsInfo.available && (
                      <SettingsPanelRow className="pt-0">
                        <PasteToolsInfo
                          pasteToolsInfo={permissionsHook.pasteToolsInfo}
                          isChecking={permissionsHook.isCheckingPasteTools}
                          onCheck={permissionsHook.checkPasteToolsAvailability}
                        />
                      </SettingsPanelRow>
                    )}
                </SettingsPanel>

                {platform === "darwin" && (
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] font-medium text-foreground">
                            {t("settingsPage.permissions.troubleshootingTitle")}
                          </p>
                          <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-relaxed">
                            {t("settingsPage.permissions.resetAccessibility.rowDescription")}
                          </p>
                        </div>
                        <Button
                          onClick={resetAccessibilityPermissions}
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-[11px] shrink-0"
                        >
                          {t("settingsPage.permissions.troubleshoot")}
                        </Button>
                      </div>
                    </SettingsPanelRow>
                  </SettingsPanel>
                )}
              </div>

              <div className="space-y-4">
                <SectionHeader
                  title={t("settingsPage.privacy.title")}
                  description={t("settingsPage.privacy.description")}
                />
                <SettingsPanel>
                  {isSignedIn && (
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settingsPage.privacy.cloudBackup")}
                        description={t("settingsPage.privacy.cloudBackupDescription")}
                      >
                        <Toggle checked={cloudBackupEnabled} onChange={setCloudBackupEnabled} />
                      </SettingsRow>
                    </SettingsPanelRow>
                  )}
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.privacy.transcriptionHistory")}
                      description={t("settingsPage.privacy.transcriptionHistoryDescription")}
                    >
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-[11px]"
                          disabled={!onOpenTranscriptionHistory}
                          onClick={() => onOpenTranscriptionHistory?.()}
                        >
                          {t("settingsPage.developer.open")}
                        </Button>
                        <Toggle
                          checked={transcriptionHistoryEnabled}
                          onChange={setTranscriptionHistoryEnabled}
                        />
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.privacy.usageAnalytics")}
                      description={t("settingsPage.privacy.usageAnalyticsDescription")}
                    >
                      <Toggle checked={telemetryEnabled} onChange={setTelemetryEnabled} />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            </div>
          </div>
        );

      case "developer":
        return (
          <div className="space-y-6">
            <DeveloperSection />

            {/* Data Management — moved from General */}
            <div className="border-t border-border/40 pt-8">
              <SectionHeader
                title={t("settingsPage.developer.dataManagementTitle")}
                description={t("settingsPage.developer.dataManagementDescription")}
              />

              <div className="space-y-4">
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.modelCache")}
                      description={cachePathHint}
                    >
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => window.electronAPI?.openWhisperModelsFolder?.()}
                        >
                          <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                          {t("settingsPage.developer.open")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleRemoveModels}
                          disabled={isRemovingModels}
                        >
                          {isRemovingModels
                            ? t("settingsPage.developer.removing")
                            : t("settingsPage.developer.clearCache")}
                        </Button>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.settingsTransfer.title")}
                      description={t("settingsPage.developer.settingsTransfer.description")}
                    >
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={handleExportSettings}>
                          <Download className="mr-1.5 h-3.5 w-3.5" />
                          {t("settingsPage.developer.settingsTransfer.export")}
                        </Button>
                        <Button variant="outline" size="sm" onClick={handleImportSettings}>
                          <Upload className="mr-1.5 h-3.5 w-3.5" />
                          {t("settingsPage.developer.settingsTransfer.import")}
                        </Button>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.resetAppData")}
                      description={t("settingsPage.developer.resetAppDataDescription")}
                    >
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.developer.resetAll.title"),
                            description: t("settingsPage.developer.resetAll.description"),
                            onConfirm: () => {
                              window.electronAPI
                                ?.cleanupApp()
                                .then(() => {
                                  showAlertDialog({
                                    title: t("settingsPage.developer.resetAll.successTitle"),
                                    description: t(
                                      "settingsPage.developer.resetAll.successDescription"
                                    ),
                                  });
                                  setTimeout(() => {
                                    window.location.reload();
                                  }, 1000);
                                })
                                .catch(() => {
                                  showAlertDialog({
                                    title: t("settingsPage.developer.resetAll.failedTitle"),
                                    description: t(
                                      "settingsPage.developer.resetAll.failedDescription"
                                    ),
                                  });
                                });
                            },
                            variant: "destructive",
                            confirmText: t("settingsPage.developer.resetAll.confirmText"),
                          });
                        }}
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        {t("common.reset")}
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            </div>
          </div>
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
        onOk={() => { }}
      />

      {renderSectionContent()}
    </>
  );
}
