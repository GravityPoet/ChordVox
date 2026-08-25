import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, FolderOpen, Loader2, Zap } from "lucide-react";
import { Button } from "./ui/button";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { useLocalStorage } from "../hooks/useLocalStorage";
import type {
  SherpaStreamingDownloadProgressData,
  SherpaStreamingModelInfo,
} from "../types/electron";
import type { DownloadProgress } from "../hooks/useModelDownload";
import streamingModels from "../config/streamingModels.json";
import { getTranscriptionModeCopy } from "../utils/transcriptionModeCopy";
import { shouldShowModelStorageRootNormalizedNotice } from "./settings/utils";
import { useToast } from "./ui/toastContext";
import {
  getStreamingModelDescription as getStreamingModelDescriptionText,
  getStreamingModelDisplayName,
} from "../utils/streamingModelI18n";
import {
  getDefaultLocalStreamingModelIdForLocale,
  isRecommendedLocalStreamingModelForLocale,
  LEGACY_STREAMING_DEFAULT_UPGRADE_STORAGE_KEY,
  LOCALE_STREAMING_DEFAULT_SYNC_STORAGE_KEY,
  normalizeStreamingModelId,
  syncRecommendedStreamingDefaultForLocale,
  upgradeLegacyStreamingDefaultForLocale,
} from "../utils/streamingModelSelection";

const STREAMING_MODELS = streamingModels;
const VISIBLE_STREAMING_MODELS = STREAMING_MODELS.filter((model) => !model.hidden);

interface OnboardingStreamingModelPickerProps {
  onReadyChange?: (ready: boolean) => void;
}

function joinModelStoragePath(rootPath: string | null | undefined, leaf: string): string {
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

function formatDirectoryDisplay(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
      return "%LOCALAPPDATA%\\ChordVox\\models\\streaming-models";
    }

    if (typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)) {
      return "~/Library/Application Support/ChordVox/models/streaming-models";
    }

    return "~/.cache/chordvox/models/streaming-models";
  }

  return trimmed.replace(/^\/Users\/[^/]+/, "~");
}

export default function OnboardingStreamingModelPicker({
  onReadyChange,
}: OnboardingStreamingModelPickerProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [modelStorageRoot, setModelStorageRoot] = useLocalStorage("modelStorageRoot", "", {
    serialize: String,
    deserialize: String,
  });
  const [localStreamingModelsDir, setLocalStreamingModelsDir] = useLocalStorage(
    "localStreamingModelsDir",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );
  const [localStreamingModelId, setLocalStreamingModelId] = useLocalStorage(
    "localStreamingModelId",
    getDefaultLocalStreamingModelIdForLocale(i18n.resolvedLanguage || i18n.language),
    {
      serialize: String,
      deserialize: (value) =>
        normalizeStreamingModelId(
          value,
          getDefaultLocalStreamingModelIdForLocale(i18n.resolvedLanguage || i18n.language)
        ),
    }
  );
  const [streamingModelsState, setStreamingModelsState] = useState<SherpaStreamingModelInfo[]>([]);
  const [effectiveStreamingModelsDir, setEffectiveStreamingModelsDir] = useState("");
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isChoosingDirectory, setIsChoosingDirectory] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    percentage: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  });
  const [downloadError, setDownloadError] = useState("");
  const cancelRequestedRef = useRef(false);
  const configuredStreamingModelsDir = useMemo(
    () =>
      modelStorageRoot.trim() !== ""
        ? joinModelStoragePath(modelStorageRoot, "streaming-models")
        : String(localStreamingModelsDir || "").trim(),
    [localStreamingModelsDir, modelStorageRoot]
  );
  const displayStreamingModelsDir = effectiveStreamingModelsDir || configuredStreamingModelsDir;
  const currentRootPickPath = modelStorageRoot || configuredStreamingModelsDir || undefined;

  useEffect(() => {
    const syncModelStorageRoot = async () => {
      const envRoot = String((await window.electronAPI?.getModelStorageRoot?.()) || "").trim();
      if (envRoot && envRoot !== modelStorageRoot) {
        setModelStorageRoot(envRoot);
      }
    };

    void syncModelStorageRoot();
  }, [modelStorageRoot, setModelStorageRoot]);

  const defaultModelName = useMemo(() => {
    const defaultModelId = getDefaultLocalStreamingModelIdForLocale(
      i18n.resolvedLanguage || i18n.language
    );
    const defaultModel =
      VISIBLE_STREAMING_MODELS.find((model) => model.id === defaultModelId) ||
      VISIBLE_STREAMING_MODELS[0];
    if (!defaultModel) return "";
    return getStreamingModelDisplayName(
      t,
      defaultModel.id,
      defaultModel.nameEn || defaultModel.name
    );
  }, [i18n.language, i18n.resolvedLanguage, t]);

  const transcriptionModeCopy = useMemo(
    () => getTranscriptionModeCopy(i18n.language, defaultModelName),
    [defaultModelName, i18n.language]
  );

  const loadStreamingModels = useCallback(async () => {
    if (!window.electronAPI?.sherpaStreamingGetModels) {
      return;
    }

    const primaryResult = await window.electronAPI.sherpaStreamingGetModels({
      modelsDir: configuredStreamingModelsDir || undefined,
    });

    let models = primaryResult?.success ? primaryResult.models || [] : [];
    let nextEffectiveDir = configuredStreamingModelsDir;
    const hasDownloadedInPrimary = models.some((model) => model.isDownloaded);

    // Older installs may keep a stale localStreamingModelsDir while the actual
    // downloaded models already live in the unified default root.
    if (!modelStorageRoot.trim() && configuredStreamingModelsDir && !hasDownloadedInPrimary) {
      const defaultResult = await window.electronAPI.sherpaStreamingGetModels({
        modelsDir: undefined,
      });
      const defaultModels = defaultResult?.success ? defaultResult.models || [] : [];

      if (defaultModels.some((model) => model.isDownloaded)) {
        models = defaultModels;
        nextEffectiveDir = "";
        setLocalStreamingModelsDir("");
      }
    }

    setStreamingModelsState(models);
    setEffectiveStreamingModelsDir(nextEffectiveDir);
  }, [configuredStreamingModelsDir, modelStorageRoot, setLocalStreamingModelsDir]);

  useEffect(() => {
    void loadStreamingModels();
  }, [loadStreamingModels]);

  useEffect(() => {
    const dispose = window.electronAPI?.onSherpaStreamingDownloadProgress?.(
      (_event: unknown, data: SherpaStreamingDownloadProgressData) => {
        if (!data) return;

        if (
          data.type === "source-connect" ||
          data.type === "source-switch" ||
          data.type === "verifying"
        ) {
          setDownloadProgress((prev) => ({
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
          setDownloadProgress((prev) => ({
            percentage: Math.max(prev.percentage || 0, data.percentage || 0),
            downloadedBytes: Math.max(prev.downloadedBytes || 0, data.downloaded_bytes || 0),
            totalBytes: Math.max(prev.totalBytes || 0, data.total_bytes || 0),
            statusMessage: undefined,
          }));
          return;
        }

        if (data.type === "installing") {
          setIsInstalling(true);
          setDownloadProgress((prev) => ({ ...prev, percentage: 100 }));
        }
      }
    );

    return () => {
      dispose?.();
    };
  }, [t]);

  useEffect(() => {
    const localizedDefaultModelId = getDefaultLocalStreamingModelIdForLocale(
      i18n.resolvedLanguage || i18n.language
    );
    const normalizedModelId = normalizeStreamingModelId(
      localStreamingModelId,
      localizedDefaultModelId
    );
    if (normalizedModelId !== localStreamingModelId) {
      setLocalStreamingModelId(normalizedModelId);
      return;
    }

    const upgradedModelId = upgradeLegacyStreamingDefaultForLocale(
      localStreamingModelId,
      i18n.resolvedLanguage || i18n.language,
      localStorage.getItem(LEGACY_STREAMING_DEFAULT_UPGRADE_STORAGE_KEY) === "true"
    );
    if (upgradedModelId !== localStreamingModelId) {
      setLocalStreamingModelId(upgradedModelId);
      localStorage.setItem(LEGACY_STREAMING_DEFAULT_UPGRADE_STORAGE_KEY, "true");
      return;
    }

    const syncedModelId = syncRecommendedStreamingDefaultForLocale(
      localStreamingModelId,
      i18n.resolvedLanguage || i18n.language,
      localStorage.getItem(LOCALE_STREAMING_DEFAULT_SYNC_STORAGE_KEY) === "true"
    );
    if (syncedModelId !== localStreamingModelId) {
      setLocalStreamingModelId(syncedModelId);
      localStorage.setItem(LOCALE_STREAMING_DEFAULT_SYNC_STORAGE_KEY, "true");
      return;
    }

    if (!streamingModelsState.length) return;

    const currentModel = streamingModelsState.find((model) => model.id === localStreamingModelId);
    if (currentModel && !currentModel.hidden) return;

    const fallbackModel =
      streamingModelsState.find((model) => model.isDownloaded && model.default && !model.hidden) ||
      streamingModelsState.find((model) => model.isDownloaded && !model.hidden);

    if (!fallbackModel) return;

    setLocalStreamingModelId(fallbackModel.id);
  }, [
    i18n.language,
    i18n.resolvedLanguage,
    localStreamingModelId,
    setLocalStreamingModelId,
    streamingModelsState,
  ]);

  const selectedModel = useMemo(
    () => streamingModelsState.find((model) => model.id === localStreamingModelId) || null,
    [localStreamingModelId, streamingModelsState]
  );
  const hasReadyStreamingModel = Boolean(selectedModel?.isDownloaded);

  useEffect(() => {
    onReadyChange?.(hasReadyStreamingModel);
  }, [hasReadyStreamingModel, onReadyChange]);

  const chooseModelStorageRoot = useCallback(async () => {
    if (!window.electronAPI?.pickModelStorageRoot || !window.electronAPI?.saveModelStorageRoot) {
      return;
    }

    setIsChoosingDirectory(true);
    try {
      const result = await window.electronAPI.pickModelStorageRoot(currentRootPickPath);
      if (!result?.success || result.cancelled || !result.path) {
        if (result?.error) {
          setDownloadError(result.error);
        }
        return;
      }

      const normalizedRoot = String(result.path || "").trim();
      const savedRoot = await window.electronAPI.saveModelStorageRoot(normalizedRoot);
      if (!savedRoot?.success) {
        setDownloadError(
          savedRoot?.error || t("settingsPage.transcription.storageLocation.saveFailedDescription")
        );
        return;
      }

      const persistedRoot = String(savedRoot.root ?? normalizedRoot).trim();
      const finalRoot = persistedRoot || normalizedRoot;
      const effectiveRoot = String(savedRoot.effectiveRoot || finalRoot).trim();
      const persistedStreamingDir = joinModelStoragePath(finalRoot, "streaming-models");
      const effectiveStreamingDir = joinModelStoragePath(effectiveRoot, "streaming-models");
      setModelStorageRoot(finalRoot);
      setLocalStreamingModelsDir(persistedStreamingDir);
      setEffectiveStreamingModelsDir(effectiveStreamingDir);
      if (shouldShowModelStorageRootNormalizedNotice(result.selectedPath, finalRoot)) {
        toast({
          title: t("settingsPage.transcription.storageLocation.normalizedTitle"),
          description: t("settingsPage.transcription.storageLocation.normalizedDescription", {
            path: finalRoot,
          }),
          duration: 7000,
        });
      }
      const nextModels = await window.electronAPI.sherpaStreamingGetModels?.({
        modelsDir: effectiveStreamingDir || undefined,
      });
      if (nextModels?.success) {
        setStreamingModelsState(nextModels.models || []);
      }
      setDownloadError("");
    } catch (error) {
      setDownloadError(
        error instanceof Error
          ? error.message
          : t("settingsPage.transcription.storageLocation.saveFailedDescription")
      );
    } finally {
      setIsChoosingDirectory(false);
    }
  }, [currentRootPickPath, setLocalStreamingModelsDir, setModelStorageRoot, t, toast]);

  const handleSelect = useCallback(
    (modelId: string) => {
      setLocalStreamingModelId(modelId);
      setDownloadError("");
    },
    [setLocalStreamingModelId]
  );

  const resetDownloadState = useCallback(() => {
    setDownloadingModelId(null);
    setIsInstalling(false);
    setDownloadProgress({
      percentage: 0,
      downloadedBytes: 0,
      totalBytes: 0,
    });
    cancelRequestedRef.current = false;
  }, []);

  const handleDownload = useCallback(
    async (modelId: string) => {
      if (!window.electronAPI?.sherpaStreamingDownloadModel || downloadingModelId) {
        return;
      }

      setDownloadError("");
      setDownloadingModelId(modelId);
      setIsInstalling(false);
      setDownloadProgress({
        percentage: 0,
        downloadedBytes: 0,
        totalBytes: 0,
      });

      try {
        const result = await window.electronAPI.sherpaStreamingDownloadModel(
          modelId,
          configuredStreamingModelsDir || undefined,
          { uiLanguage: i18n.resolvedLanguage || i18n.language }
        );

        if (!result?.success) {
          if (!cancelRequestedRef.current) {
            setDownloadError(
              result?.error ||
                t("settingsPage.transcription.streaming.toasts.downloadFailedDescription")
            );
          }
          return;
        }

        setLocalStreamingModelId(modelId);
      } catch (error) {
        if (!cancelRequestedRef.current) {
          setDownloadError(
            error instanceof Error
              ? error.message
              : t("settingsPage.transcription.streaming.toasts.downloadFailedDescription")
          );
        }
      } finally {
        await loadStreamingModels();
        resetDownloadState();
      }
    },
    [
      downloadingModelId,
      configuredStreamingModelsDir,
      i18n.language,
      i18n.resolvedLanguage,
      loadStreamingModels,
      resetDownloadState,
      setLocalStreamingModelId,
      t,
    ]
  );

  const handleCancel = useCallback(async () => {
    cancelRequestedRef.current = true;
    await window.electronAPI?.sherpaStreamingCancelDownload?.();
    await loadStreamingModels();
    resetDownloadState();
  }, [loadStreamingModels, resetDownloadState]);

  return (
    <div className="glass-panel glass-panel--success space-y-2.5 rounded-xl p-3">
      <div className="flex items-start gap-3">
        <div className="glass-chip glass-chip--success mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-emerald-700">
          <Zap className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <p className="text-[13px] font-semibold text-emerald-950">
            {transcriptionModeCopy.realTime.modelsLabel}
          </p>
          <p className="text-[11px] leading-5 text-emerald-900/80">
            {transcriptionModeCopy.realTime.downloadHint}
          </p>
        </div>
      </div>

      <div className="glass-panel glass-panel--soft rounded-lg px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-foreground">
              {t("onboarding.streamingModelPicker.currentFolderLabel")}
            </p>
            <p className="mt-1 break-all text-[10px] leading-5 text-muted-foreground">
              {formatDirectoryDisplay(displayStreamingModelsDir)}
            </p>
            <p className="mt-1 text-[10px] leading-5 text-muted-foreground/80">
              {t("onboarding.streamingModelPicker.currentFolderHint")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void chooseModelStorageRoot();
            }}
            disabled={Boolean(downloadingModelId || isChoosingDirectory)}
            className="shrink-0"
          >
            {isChoosingDirectory ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                {t("common.working")}
              </>
            ) : (
              <>
                <FolderOpen className="mr-1 h-3 w-3" />
                {t("common.chooseFolder")}
              </>
            )}
          </Button>
        </div>
      </div>

      {downloadingModelId ? (
        <div className="glass-panel glass-panel--soft overflow-hidden rounded-lg">
          <DownloadProgressBar
            modelName={getStreamingModelDisplayName(
              t,
              downloadingModelId,
              STREAMING_MODELS.find((model) => model.id === downloadingModelId)?.nameEn ||
                STREAMING_MODELS.find((model) => model.id === downloadingModelId)?.name ||
                downloadingModelId ||
                ""
            )}
            progress={downloadProgress}
            isInstalling={isInstalling}
          />
          <div className="flex justify-end px-3 py-2">
            <Button type="button" variant="outline" size="sm" onClick={handleCancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {downloadError ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
          {downloadError}
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        {VISIBLE_STREAMING_MODELS.map((tier) => {
          const modelInfo = streamingModelsState.find((model) => model.id === tier.id);
          const isDownloaded = modelInfo?.isDownloaded ?? false;
          const isSelected = localStreamingModelId === tier.id;
          const isDownloading = downloadingModelId === tier.id;
          const downloadPercent = Math.max(
            0,
            Math.min(100, Math.round(downloadProgress.percentage || 0))
          );
          const displayName = getStreamingModelDisplayName(t, tier.id, tier.nameEn || tier.name);
          const isRecommended = isRecommendedLocalStreamingModelForLocale(
            tier.id,
            i18n.resolvedLanguage || i18n.language
          );
          const isHighAccuracyRealtime = tier.tier === "high-accuracy-realtime";

          return (
            <div
              key={tier.id}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-all ${
                isSelected
                  ? "glass-panel glass-panel--success"
                  : "glass-panel glass-panel--soft glass-panel--hoverable"
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  if (isDownloaded) {
                    handleSelect(tier.id);
                  }
                }}
                disabled={!isDownloaded}
                className="flex flex-1 items-center gap-3 text-left disabled:cursor-not-allowed"
              >
                <div
                  className={`mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 transition-colors ${
                    isSelected
                      ? "border-emerald-500 bg-emerald-500"
                      : "border-border/80 bg-background"
                  }`}
                >
                  {isSelected ? (
                    <div className="flex h-full w-full items-center justify-center">
                      <div className="h-1.5 w-1.5 rounded-full bg-white" />
                    </div>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[13px] font-medium text-foreground">{displayName}</span>
                    <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                      {tier.size}
                    </span>
                    {isRecommended ? (
                      <span className="glass-chip glass-chip--accent rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {t("settingsPage.transcription.streaming.defaultRecommendedBadge")}
                      </span>
                    ) : null}
                    {isHighAccuracyRealtime ? (
                      <span className="glass-chip rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {t("settingsPage.transcription.streaming.highAccuracyBadge")}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                    {getStreamingModelDescriptionText(t, tier.id, tier.nameEn || tier.name)}
                  </p>
                </div>
              </button>

              {isDownloaded ? (
                <div className="flex items-center gap-1 text-[10px] font-medium text-emerald-700">
                  <Check className="h-3 w-3" />
                  {isSelected ? t("common.ready") : t("common.ready")}
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    if (!isDownloading) {
                      void handleDownload(tier.id);
                    }
                  }}
                  disabled={Boolean(downloadingModelId)}
                  className="h-8 shrink-0 px-3 text-[11px]"
                >
                  {isDownloading ? (
                    <>
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      {isInstalling
                        ? t("common.installing")
                        : `${t("common.downloading")} ${downloadPercent}%`}
                    </>
                  ) : (
                    <>
                      <Download className="mr-1 h-3 w-3" />
                      {t("common.download")}
                    </>
                  )}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {hasReadyStreamingModel ? (
        <div className="glass-panel glass-panel--soft rounded-lg px-3 py-2 text-[11px] leading-5 text-emerald-900">
          {t("onboarding.streamingModelPicker.readyDescription")}
        </div>
      ) : (
        <div className="glass-panel glass-panel--warning rounded-lg px-3 py-2 text-[11px] leading-5 text-amber-900">
          {transcriptionModeCopy.realTime.downloadHint}
        </div>
      )}
    </div>
  );
}
