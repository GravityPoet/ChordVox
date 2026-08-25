import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Key, Loader2, Trash2, FolderOpen, Download } from "lucide-react";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import { DownloadProgressBar } from "../ui/DownloadProgressBar";
import { getTranscriptionModeCopy } from "../../utils/transcriptionModeCopy";
import {
  getStreamingModelDescription as getStreamingModelDescriptionText,
  getStreamingModelDisplayName,
} from "../../utils/streamingModelI18n";
import {
  getDefaultLocalStreamingModelIdForLocale,
  isRecommendedLocalStreamingModelForLocale,
  LEGACY_STREAMING_DEFAULT_UPGRADE_STORAGE_KEY,
  LOCALE_STREAMING_DEFAULT_SYNC_STORAGE_KEY,
  normalizeStreamingModelId,
  syncRecommendedStreamingDefaultForLocale,
  upgradeLegacyStreamingDefaultForLocale,
} from "../../utils/streamingModelSelection";
import streamingModels from "../../config/streamingModels.json";
import {
  formatDirectoryDisplay,
  joinModelStoragePath,
  resolveModelStorageRoot,
  shouldShowModelStorageRootNormalizedNotice,
} from "./utils";
import { SettingsPanel, SettingsPanelRow, SectionCard } from "./shared";
import type {
  LocalTranscriptionProvider,
  ModelStorageRootSaveResult,
  SherpaStreamingDownloadProgressData,
  SherpaStreamingModelInfo,
} from "../../types/electron";
import type { DownloadProgress as ModelDownloadProgress } from "../../hooks/useModelDownload";
import { writeLocalStorageValue } from "../../hooks/useLocalStorage";

const STREAMING_MODELS = streamingModels;
const VISIBLE_STREAMING_MODELS = STREAMING_MODELS.filter((model) => !model.hidden);
const HIDDEN_STREAMING_MODELS = STREAMING_MODELS.filter((model) => model.hidden);

function isLocalTranscriptionProvider(
  providerId: string
): providerId is LocalTranscriptionProvider {
  switch (providerId) {
    case "whisper":
    case "nvidia":
    case "granite":
    case "paraformer":
    case "cohere":
      return true;
    default:
      return false;
  }
}

function normalizePersistedLocalStreamingModelId(uiLanguage: string): string {
  const localizedDefaultModelId = getDefaultLocalStreamingModelIdForLocale(uiLanguage);
  const storedModelId = localStorage.getItem("localStreamingModelId");
  const hasAlreadyUpgraded =
    localStorage.getItem(LEGACY_STREAMING_DEFAULT_UPGRADE_STORAGE_KEY) === "true";
  const hasAlreadySynced =
    localStorage.getItem(LOCALE_STREAMING_DEFAULT_SYNC_STORAGE_KEY) === "true";

  let nextModelId = normalizeStreamingModelId(storedModelId, localizedDefaultModelId);
  let shouldPersist = nextModelId !== storedModelId;
  let shouldMarkUpgraded = false;
  let shouldMarkSynced = false;

  const upgradedModelId = upgradeLegacyStreamingDefaultForLocale(
    nextModelId,
    uiLanguage,
    hasAlreadyUpgraded
  );
  if (upgradedModelId !== nextModelId) {
    nextModelId = upgradedModelId;
    shouldPersist = true;
    shouldMarkUpgraded = true;
  }

  const syncedModelId = syncRecommendedStreamingDefaultForLocale(
    nextModelId,
    uiLanguage,
    hasAlreadySynced
  );
  if (syncedModelId !== nextModelId) {
    nextModelId = syncedModelId;
    shouldPersist = true;
    shouldMarkSynced = true;
  }

  if (shouldPersist) {
    localStorage.setItem("localStreamingModelId", nextModelId);
  }
  if (shouldMarkUpgraded) {
    localStorage.setItem(LEGACY_STREAMING_DEFAULT_UPGRADE_STORAGE_KEY, "true");
  }
  if (shouldMarkSynced) {
    localStorage.setItem(LOCALE_STREAMING_DEFAULT_SYNC_STORAGE_KEY, "true");
  }

  return nextModelId;
}

export interface TranscriptionSectionProps {
  preferredLanguage: string;
  modelStorageRoot: string;
  setModelStorageRoot: (root: string) => Promise<ModelStorageRootSaveResult>;
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
  paraformerModel: string;
  setParaformerModel: (model: string) => void;
  graniteModel: string;
  setGraniteModel: (model: string) => void;
  graniteRuntimeUrl: string;
  setGraniteRuntimeUrl: (url: string) => void;
  graniteRuntimeApiKey: string;
  setGraniteRuntimeApiKey: (key: string) => void;
  cohereModel: string;
  setCohereModel: (model: string) => void;
  cohereRuntimeUrl: string;
  setCohereRuntimeUrl: (url: string) => void;
  cohereRuntimeApiKey: string;
  setCohereRuntimeApiKey: (key: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  sonioxApiKey: string;
  setSonioxApiKey: (key: string) => void;
  deepgramApiKey: string;
  setDeepgramApiKey: (key: string) => void;
  googleSttApiKey: string;
  setGoogleSttApiKey: (key: string) => void;
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

export function TranscriptionSection({
  preferredLanguage,
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
  paraformerModel,
  setParaformerModel,
  graniteModel,
  setGraniteModel,
  graniteRuntimeUrl,
  setGraniteRuntimeUrl,
  graniteRuntimeApiKey,
  setGraniteRuntimeApiKey,
  cohereModel,
  setCohereModel,
  cohereRuntimeUrl,
  setCohereRuntimeUrl,
  cohereRuntimeApiKey,
  setCohereRuntimeApiKey,
  openaiApiKey,
  setOpenaiApiKey,
  groqApiKey,
  setGroqApiKey,
  sonioxApiKey,
  setSonioxApiKey,
  deepgramApiKey,
  setDeepgramApiKey,
  googleSttApiKey,
  setGoogleSttApiKey,
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
  const uiLanguage = i18n.resolvedLanguage || i18n.language;

  // Local streaming mode state
  const [useLocalStreaming, setUseLocalStreaming] = useState(
    () => localStorage.getItem("useLocalStreaming") === "true"
  );
  const [localStreamingModelsDir, setLocalStreamingModelsDir] = useState(
    () => localStorage.getItem("localStreamingModelsDir") || ""
  );
  const [localStreamingModelId, setLocalStreamingModelId] = useState(() =>
    normalizePersistedLocalStreamingModelId(uiLanguage)
  );
  const [streamingModels, setStreamingModels] = useState<SherpaStreamingModelInfo[]>([]);
  const [downloadingStreamingModelId, setDownloadingStreamingModelId] = useState<string | null>(
    null
  );
  const [deletingStreamingModelId, setDeletingStreamingModelId] = useState<string | null>(null);
  const [isDeletingAllStreamingModels, setIsDeletingAllStreamingModels] = useState(false);
  const [isInstallingStreamingModel, setIsInstallingStreamingModel] = useState(false);
  const [isMigratingModelStorage, setIsMigratingModelStorage] = useState(false);
  const [modelStorageMigrationProgress, setModelStorageMigrationProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [streamingDownloadProgress, setStreamingDownloadProgress] = useState<ModelDownloadProgress>(
    {
      percentage: 0,
      downloadedBytes: 0,
      totalBytes: 0,
    }
  );
  const isLocalStreamingMode = useLocalStreaming;
  const streamingCancelRequestedRef = useRef(false);
  const normalizedLegacyStreamingModelsDir = localStreamingModelsDir.trim().replace(/[\\/]+$/, "");
  const resolvedStreamingModelsDir =
    modelStorageRoot.trim() !== ""
      ? joinModelStoragePath(modelStorageRoot, "streaming-models")
      : normalizedLegacyStreamingModelsDir
        ? /[\\/]streaming-models$/i.test(normalizedLegacyStreamingModelsDir)
          ? normalizedLegacyStreamingModelsDir
          : joinModelStoragePath(normalizedLegacyStreamingModelsDir, "streaming-models")
        : "";
  const effectiveModelStorageRoot = resolveModelStorageRoot(
    modelStorageRoot,
    localStreamingModelsDir
  );
  const modelStorageRootDisplay = formatDirectoryDisplay(effectiveModelStorageRoot);

  useEffect(() => {
    return window.electronAPI?.onModelStorageMigrationProgress?.((progress) => {
      setModelStorageMigrationProgress({
        completed: Math.max(0, Number(progress?.completed) || 0),
        total: Math.max(0, Number(progress?.total) || 0),
      });
    });
  }, []);

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

        if (
          data.type === "source-connect" ||
          data.type === "source-switch" ||
          data.type === "verifying"
        ) {
          setStreamingDownloadProgress((prev) => ({
            ...prev,
            statusMessage:
              data.type === "verifying"
                ? t("common.verifyingDownload")
                : data.type === "source-switch"
                  ? t("common.switchingDownloadNode")
                  : t("common.connectingDownloadNode"),
          }));
          return;
        }

        if (data.type === "progress") {
          setStreamingDownloadProgress((prev) => ({
            percentage: Math.max(prev.percentage || 0, data.percentage || 0),
            downloadedBytes: Math.max(prev.downloadedBytes || 0, data.downloaded_bytes || 0),
            totalBytes: Math.max(prev.totalBytes || 0, data.total_bytes || 0),
            statusMessage: undefined,
          }));
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
  }, [t]);

  useEffect(() => {
    if (!streamingModels.length) return;

    const localizedDefaultModelId = getDefaultLocalStreamingModelIdForLocale(uiLanguage);
    const normalizedModelId = normalizeStreamingModelId(
      localStreamingModelId,
      localizedDefaultModelId
    );
    if (normalizedModelId !== localStreamingModelId) {
      setLocalStreamingModelId(normalizedModelId);
      writeLocalStorageValue("localStreamingModelId", normalizedModelId);
      return;
    }

    const upgradedModelId = upgradeLegacyStreamingDefaultForLocale(
      localStreamingModelId,
      uiLanguage,
      localStorage.getItem(LEGACY_STREAMING_DEFAULT_UPGRADE_STORAGE_KEY) === "true"
    );
    if (upgradedModelId !== localStreamingModelId) {
      setLocalStreamingModelId(upgradedModelId);
      writeLocalStorageValue("localStreamingModelId", upgradedModelId);
      localStorage.setItem(LEGACY_STREAMING_DEFAULT_UPGRADE_STORAGE_KEY, "true");
      return;
    }

    const syncedModelId = syncRecommendedStreamingDefaultForLocale(
      localStreamingModelId,
      uiLanguage,
      localStorage.getItem(LOCALE_STREAMING_DEFAULT_SYNC_STORAGE_KEY) === "true"
    );
    if (syncedModelId !== localStreamingModelId) {
      setLocalStreamingModelId(syncedModelId);
      writeLocalStorageValue("localStreamingModelId", syncedModelId);
      localStorage.setItem(LOCALE_STREAMING_DEFAULT_SYNC_STORAGE_KEY, "true");
      return;
    }

    const currentModel = streamingModels.find((model) => model.id === localStreamingModelId);
    if (currentModel && !currentModel.hidden) return;

    const fallbackModel =
      streamingModels.find((model) => model.isDownloaded && model.default && !model.hidden) ||
      streamingModels.find((model) => model.isDownloaded && !model.hidden);

    if (!fallbackModel) return;

    setLocalStreamingModelId(fallbackModel.id);
    writeLocalStorageValue("localStreamingModelId", fallbackModel.id);
  }, [streamingModels, localStreamingModelId, uiLanguage]);

  const handleStreamingModelSelect = useCallback((modelId: string) => {
    setLocalStreamingModelId(modelId);
    writeLocalStorageValue("localStreamingModelId", modelId);
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
    async (dirPath: string) => {
      const normalized = String(dirPath || "").trim();
      const result = await setModelStorageRoot(normalized);
      const committedRoot = String(result.root || "").trim();
      persistStreamingModelsDir(
        committedRoot ? joinModelStoragePath(committedRoot, "streaming-models") : ""
      );
      return result;
    },
    [persistStreamingModelsDir, setModelStorageRoot]
  );

  const chooseModelStorageRoot = useCallback(async () => {
    const result = await window.electronAPI?.pickModelStorageRoot?.(
      effectiveModelStorageRoot || modelStorageRoot || localStreamingModelsDir || undefined
    );

    if (!result?.success || result.cancelled || !result.path) {
      if (result?.error) {
        toast({
          title: t("settingsPage.transcription.storageLocation.saveFailedTitle"),
          description: result.error,
          variant: "destructive",
        });
      }
      return null;
    }

    setIsMigratingModelStorage(true);
    setModelStorageMigrationProgress(null);
    try {
      const saveResult = await persistModelStorageRoot(result.path);
      if (shouldShowModelStorageRootNormalizedNotice(result.selectedPath, saveResult.root)) {
        toast({
          title: t("settingsPage.transcription.storageLocation.normalizedTitle"),
          description: t("settingsPage.transcription.storageLocation.normalizedDescription", {
            path: saveResult.root,
          }),
          duration: 7000,
        });
      } else {
        toast({
          title: t("settingsPage.transcription.storageLocation.migrationCompleteTitle"),
          description:
            saveResult.cleanupWarnings && saveResult.cleanupWarnings.length > 0
              ? t("settingsPage.transcription.storageLocation.migrationCompleteWithCopies")
              : t("settingsPage.transcription.storageLocation.migrationCompleteDescription"),
          variant: "success",
        });
      }
      return saveResult.root;
    } catch (error) {
      toast({
        title: t("settingsPage.transcription.storageLocation.saveFailedTitle"),
        description:
          error instanceof Error
            ? error.message
            : t("settingsPage.transcription.storageLocation.saveFailedDescription"),
        variant: "destructive",
        duration: 9000,
      });
      return null;
    } finally {
      setIsMigratingModelStorage(false);
      setModelStorageMigrationProgress(null);
    }
  }, [
    effectiveModelStorageRoot,
    localStreamingModelsDir,
    modelStorageRoot,
    persistModelStorageRoot,
    t,
    toast,
  ]);

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
          description: t(
            "settingsPage.transcription.streaming.toasts.downloadInProgressDescription"
          ),
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
          resolvedStreamingModelsDir || undefined,
          { uiLanguage: i18n.resolvedLanguage || i18n.language }
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
      i18n.language,
      i18n.resolvedLanguage,
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
                description: t(
                  "settingsPage.transcription.streaming.toasts.deleteSuccessDescription",
                  {
                    model: modelLabel,
                  }
                ),
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

  const transcriptionModeCopy = useMemo(
    () => getTranscriptionModeCopy(i18n.language),
    [i18n.language]
  );

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
  const downloadedHiddenStreamingModels = streamingModels.filter(
    (model) => model.isDownloaded && model.hidden
  );
  const downloadedVisibleStreamingModels = streamingModels.filter(
    (model) => model.isDownloaded && !model.hidden
  );

  return (
    <div className="space-y-5">
      {/* Mode selector: 3 modes */}
      <SectionCard
        title={t("settingsPage.transcription.title")}
        description={t("settingsPage.transcription.description")}
        variant="hero"
        className="transcription-mode-section"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <button
            onClick={() => {
              if (!isLocalStreamingMode) {
                setUseLocalStreaming(true);
                writeLocalStorageValue("useLocalStreaming", "true");
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
            className={`premium-option-card mode-depth-card flex w-full items-start gap-4 px-4 py-4 text-left ${
              isLocalStreamingMode ? "premium-option-card--active mode-depth-card--active" : ""
            }`}
          >
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                isLocalStreamingMode
                  ? "glass-chip glass-chip--success text-success"
                  : "glass-chip glass-chip--muted text-muted-foreground"
              }`}
            >
              <svg
                className="h-4 w-4"
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
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[15px] font-semibold text-foreground">
                  {transcriptionModeCopy.realTime.label}
                </p>
                {isLocalStreamingMode ? (
                  <Badge variant="success">{t("common.active")}</Badge>
                ) : null}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground/80">
                {transcriptionModeCopy.realTime.cardDescription}
              </p>
            </div>
          </button>

          <button
            onClick={() => {
              if (isLocalStreamingMode) {
                setUseLocalWhisper(true);
                updateTranscriptionSettings({ useLocalWhisper: true });
                setUseLocalStreaming(false);
                writeLocalStorageValue("useLocalStreaming", "false");
                toast({
                  title: transcriptionModeCopy.highAccuracy.switchedTitle,
                  description: transcriptionModeCopy.highAccuracy.switchedDescription,
                  variant: "success",
                  duration: 3000,
                });
              }
            }}
            className={`premium-option-card mode-depth-card flex w-full items-start gap-4 px-4 py-4 text-left ${
              !isLocalStreamingMode ? "premium-option-card--active mode-depth-card--active" : ""
            }`}
          >
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                !isLocalStreamingMode
                  ? "glass-chip glass-chip--accent text-primary"
                  : "glass-chip glass-chip--muted text-muted-foreground"
              }`}
            >
              <Key className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[15px] font-semibold text-foreground">
                  {transcriptionModeCopy.highAccuracy.label}
                </p>
                {!isLocalStreamingMode ? <Badge variant="info">{t("common.active")}</Badge> : null}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground/80">
                {transcriptionModeCopy.highAccuracy.cardDescription}
              </p>
            </div>
          </button>
        </div>
      </SectionCard>

      {/* Local Streaming model picker — shown when "实时转录" is active */}
      {isLocalStreamingMode && (
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <svg
                  className="w-4 h-4 text-success"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                <span className="text-[14px] font-semibold text-foreground">
                  {transcriptionModeCopy.realTime.modelsLabel}
                </span>
              </div>
              {downloadingStreamingModelId && (
                <div className="glass-chip glass-chip--success overflow-hidden rounded-lg">
                  <DownloadProgressBar
                    modelName={getStreamingModelDisplayName(
                      t,
                      downloadingStreamingModelId,
                      STREAMING_MODELS.find((model) => model.id === downloadingStreamingModelId)
                        ?.nameEn ||
                        STREAMING_MODELS.find((model) => model.id === downloadingStreamingModelId)
                          ?.name ||
                        downloadingStreamingModelId ||
                        ""
                    )}
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
                {VISIBLE_STREAMING_MODELS.map((tier) => {
                  const isSelected = localStreamingModelId === tier.id;
                  const modelInfo = streamingModels.find((m) => m.id === tier.id);
                  const isDownloaded = modelInfo?.isDownloaded ?? false;
                  const isDownloading = downloadingStreamingModelId === tier.id;
                  const isDeleting = deletingStreamingModelId === tier.id;
                  const downloadPercent = Math.max(
                    0,
                    Math.min(100, Math.round(streamingDownloadProgress.percentage || 0))
                  );
                  const fallbackName = tier.nameEn || tier.name;
                  const displayName = getStreamingModelDisplayName(t, tier.id, fallbackName);
                  const isRecommended = isRecommendedLocalStreamingModelForLocale(
                    tier.id,
                    uiLanguage
                  );
                  const isHighAccuracyRealtime = tier.tier === "high-accuracy-realtime";
                  return (
                    <div
                      key={tier.id}
                      className={`premium-option-card flex w-full items-center gap-3 px-3 py-3 text-left ${
                        isSelected ? "premium-option-card--active" : ""
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
                            isSelected ? "border-success bg-success" : "border-border-hover"
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
                            <span className="text-[13px] font-medium text-foreground">
                              {displayName}
                            </span>
                            <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                              {tier.size}
                            </span>
                            {isRecommended && (
                              <span className="glass-chip glass-chip--accent rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-primary">
                                {t("settingsPage.transcription.streaming.defaultRecommendedBadge")}
                              </span>
                            )}
                            {isHighAccuracyRealtime && (
                              <span className="glass-chip rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                                {t("settingsPage.transcription.streaming.highAccuracyBadge")}
                              </span>
                            )}
                            {isDownloaded && <span className="text-[11px] text-success">✓</span>}
                            {!isDownloaded && (
                              <span className="text-[13px] text-warning">
                                {t("common.downloadRequired")}
                              </span>
                            )}
                          </div>
                          <p className="text-[12px] text-muted-foreground/70 mt-0.5">
                            {getStreamingModelDescription(tier.id)}
                          </p>
                        </div>
                      </button>
                      {!isDownloaded && (
                        <Button
                          type="button"
                          variant={isDownloading ? "secondary" : "outline"}
                          size="sm"
                          disabled={Boolean(
                            downloadingStreamingModelId ||
                            deletingStreamingModelId ||
                            isDeletingAllStreamingModels
                          )}
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
                                : `${t("common.downloading")} ${downloadPercent}%`}
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
                          disabled={Boolean(
                            downloadingStreamingModelId ||
                            deletingStreamingModelId ||
                            isDeletingAllStreamingModels
                          )}
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
                {downloadedHiddenStreamingModels.map((model) => {
                  const sourceConfig =
                    HIDDEN_STREAMING_MODELS.find((tier) => tier.id === model.id) || model;
                  const isDeleting = deletingStreamingModelId === model.id;
                  const replacementName = sourceConfig.replacedBy
                    ? getStreamingModelDisplayName(
                        t,
                        sourceConfig.replacedBy,
                        STREAMING_MODELS.find((item) => item.id === sourceConfig.replacedBy)
                          ?.nameEn ||
                          STREAMING_MODELS.find((item) => item.id === sourceConfig.replacedBy)
                            ?.name ||
                          sourceConfig.replacedBy
                      )
                    : "";
                  return (
                    <div
                      key={model.id}
                      className="premium-option-card flex w-full items-center gap-3 px-3 py-3 text-left opacity-80"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-medium text-muted-foreground">
                            {getStreamingModelDisplayName(
                              t,
                              model.id,
                              sourceConfig.nameEn || sourceConfig.name || model.id
                            )}
                          </span>
                          <span className="glass-chip rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            {t("settingsPage.transcription.streaming.deprecatedBadge")}
                          </span>
                          {sourceConfig.size ? (
                            <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                              {sourceConfig.size}
                            </span>
                          ) : null}
                        </div>
                        <p className="text-[12px] text-muted-foreground/70 mt-0.5">
                          {t("settingsPage.transcription.streaming.deprecatedModelDescription", {
                            replacement: replacementName,
                          })}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={Boolean(
                          downloadingStreamingModelId ||
                          deletingStreamingModelId ||
                          isDeletingAllStreamingModels
                        )}
                        onClick={() => handleStreamingModelDelete(model.id)}
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
                    </div>
                  );
                })}
              </div>
              {!downloadedVisibleStreamingModels.length && (
                <p className="text-[12px] text-[color:var(--ui-warning-ink)]">
                  {transcriptionModeCopy.realTime.downloadHint}
                </p>
              )}
              {downloadedStreamingModels.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={Boolean(
                      downloadingStreamingModelId ||
                      deletingStreamingModelId ||
                      isDeletingAllStreamingModels
                    )}
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
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      )}

      {/* Transcription model picker — shown when high-accuracy transcription is active */}
      {!isLocalStreamingMode && (
        <TranscriptionModelPicker
          selectedCloudProvider={cloudTranscriptionProvider}
          onCloudProviderSelect={(providerId) => {
            setCloudTranscriptionProvider(providerId);
            if (cloudTranscriptionMode !== "byok") {
              setCloudTranscriptionMode("byok");
            }
          }}
          selectedCloudModel={cloudTranscriptionModel}
          onCloudModelSelect={setCloudTranscriptionModel}
          preferredLanguage={preferredLanguage}
          selectedLocalModel={
            localTranscriptionProvider === "nvidia"
              ? parakeetModel
              : localTranscriptionProvider === "paraformer"
                ? paraformerModel
                : localTranscriptionProvider === "granite"
                  ? graniteModel
                  : localTranscriptionProvider === "cohere"
                    ? cohereModel
                    : whisperModel
          }
          onLocalModelSelect={(modelId, providerId) => {
            const targetProvider = providerId || localTranscriptionProvider;
            if (targetProvider === "nvidia") {
              setParakeetModel(modelId);
            } else if (targetProvider === "paraformer") {
              setParaformerModel(modelId);
            } else if (targetProvider === "granite") {
              setGraniteModel(modelId);
            } else if (targetProvider === "cohere") {
              setCohereModel(modelId);
            } else {
              setWhisperModel(modelId);
            }
          }}
          selectedLocalProvider={localTranscriptionProvider}
          onLocalProviderSelect={(providerId) => {
            if (isLocalTranscriptionProvider(providerId)) {
              setLocalTranscriptionProvider(providerId);
            }
          }}
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
          graniteRuntimeUrl={graniteRuntimeUrl}
          setGraniteRuntimeUrl={setGraniteRuntimeUrl}
          graniteRuntimeApiKey={graniteRuntimeApiKey}
          setGraniteRuntimeApiKey={setGraniteRuntimeApiKey}
          cohereRuntimeUrl={cohereRuntimeUrl}
          setCohereRuntimeUrl={setCohereRuntimeUrl}
          cohereRuntimeApiKey={cohereRuntimeApiKey}
          setCohereRuntimeApiKey={setCohereRuntimeApiKey}
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
          variant="settings"
        />
      )}

      <SectionCard
        title={t("settingsPage.transcription.storageLocation.label")}
        description={t("settingsPage.transcription.storageLocation.streamingFolderHint")}
      >
        <div className="flex items-center gap-2.5">
          <span className="glass-chip glass-chip--accent flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-primary">
            <FolderOpen className="h-4 w-4" />
          </span>
          <p
            className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
            title={modelStorageRootDisplay}
            dir="ltr"
          >
            {modelStorageRootDisplay}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={chooseModelStorageRoot}
            disabled={isMigratingModelStorage}
            className="shrink-0"
          >
            {isMigratingModelStorage ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isMigratingModelStorage
              ? t("settingsPage.transcription.storageLocation.migrating", {
                  completed: modelStorageMigrationProgress?.completed || 0,
                  total: modelStorageMigrationProgress?.total || 0,
                })
              : t("common.chooseFolder")}
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
