import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  FolderOpen,
  Loader2,
  Mic,
  Cloud,
  Sparkles,
  Upload,
  FileAudio,
  Settings2,
  X,
  Clipboard,
  Check,
} from "lucide-react";
import { Progress } from "../ui/progress";
import AudioManager from "../../helpers/audioManager";
import { cn } from "../lib/utils";
import streamingModels from "../../config/streamingModels.json";
import { getStreamingModelDisplayName } from "../../utils/streamingModelI18n";
import {
  getMediaDurationSeconds,
  isSupportedMediaFile,
  SUPPORTED_MEDIA_ACCEPT,
} from "../../utils/mediaFile";
import {
  getModelDisplayValue,
  getLocalTranscriptionProviderLabel,
  getSavedCloudProviderLabel,
} from "./utils";
import { SectionCard } from "./shared";
import type { ProAccessResult } from "./types";

const STREAMING_MODELS = streamingModels;

export type FileTranscriptionStage =
  | "idle"
  | "preparing"
  | "transcribing"
  | "enhancing"
  | "saving"
  | "complete";

interface FileAudioStateChange {
  isProcessing?: boolean;
}

interface FileAudioProgress {
  progress?: number;
  stage?: FileTranscriptionStage;
}

interface FileAudioError {
  code?: string;
  description?: string;
  message?: string;
}

interface FileTranscriptionResult {
  success?: boolean;
  text?: string;
  recordingDurationMs?: number;
}

function getErrorMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return null;
  }

  return typeof error.message === "string" ? error.message : null;
}

export interface FileTranscriptionSectionProps {
  onOpenTranscriptionHistory?: () => void;
  onOpenTranscriptionSettings?: () => void;
  refreshLicenseStatus: () => Promise<void>;
  toast: (opts: {
    title: string;
    description: string;
    action?: React.ReactNode;
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
  paraformerModel: string;
  graniteModel: string;
  cohereModel: string;
  cloudTranscriptionMode: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
}

export function FileTranscriptionSection({
  onOpenTranscriptionHistory,
  onOpenTranscriptionSettings,
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
  paraformerModel,
  graniteModel,
  cohereModel,
  cloudTranscriptionMode,
  cloudTranscriptionProvider,
  cloudTranscriptionModel,
}: FileTranscriptionSectionProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileAudioManagerRef = useRef<AudioManager | null>(null);
  const activeFileNameRef = useRef("");
  const latestCallbacksRef = useRef({
    onOpenTranscriptionHistory,
    t,
    toast,
  });
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [activeFileName, setActiveFileName] = useState("");
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<FileTranscriptionStage>("idle");
  const [isDragActive, setIsDragActive] = useState(false);
  const [lastCompletedText, setLastCompletedText] = useState("");
  const [hasCopiedCompletion, setHasCopiedCompletion] = useState(false);

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
      if (localTranscriptionProvider === "paraformer") {
        return getModelDisplayValue(paraformerModel);
      }
      if (localTranscriptionProvider === "granite") {
        return getModelDisplayValue(graniteModel);
      }
      if (localTranscriptionProvider === "cohere") {
        return getModelDisplayValue(cohereModel);
      }
      return getModelDisplayValue(whisperModel);
    }
    return getModelDisplayValue(cloudTranscriptionModel);
  }, [
    cloudTranscriptionModel,
    localTranscriptionProvider,
    localStreamingModelId,
    parakeetModel,
    paraformerModel,
    graniteModel,
    cohereModel,
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

  const dropzoneDescription = isTranscribing
    ? t("settingsPage.fileTranscription.dropzoneBusyDescription")
    : isDragActive
      ? t("settingsPage.fileTranscription.dropzoneActiveDescription")
      : null;

  const stageToneClass = useMemo(() => {
    switch (stage) {
      case "complete":
        return "glass-chip glass-chip--success text-success";
      case "enhancing":
      case "transcribing":
        return "glass-chip glass-chip--accent text-primary";
      case "saving":
      case "preparing":
        return "glass-chip glass-chip--warning text-warning";
      default:
        return "glass-chip glass-chip--muted text-muted-foreground";
    }
  }, [stage]);

  const isIdleState =
    !isTranscribing && stage === "idle" && progress === 0 && activeFileName === "";

  useEffect(() => {
    latestCallbacksRef.current = {
      onOpenTranscriptionHistory,
      t,
      toast,
    };
  }, [onOpenTranscriptionHistory, t, toast]);

  useEffect(() => {
    const audioManager = new AudioManager();
    fileAudioManagerRef.current = audioManager;

    audioManager.setCallbacks({
      onStateChange: ({ isProcessing }: FileAudioStateChange) => {
        setIsTranscribing(Boolean(isProcessing));
      },
      onProgress: ({ progress: nextProgress, stage: nextStage }: FileAudioProgress) => {
        setProgress(Math.max(0, Math.min(100, Math.round(nextProgress || 0))));
        setStage(nextStage || "idle");
      },
      onPartialTranscript: () => {},
      onAudioLevel: () => {},
      onError: (error: FileAudioError) => {
        const { t: latestT, toast: latestToast } = latestCallbacksRef.current;
        const isNoAudio = error?.code === "NO_AUDIO_DETECTED";
        activeFileNameRef.current = "";
        setActiveFileName("");
        setIsTranscribing(false);
        setProgress(0);
        setStage("idle");
        setLastCompletedText("");
        setHasCopiedCompletion(false);
        latestToast({
          title:
            error?.code === "LICENSE_REQUIRED"
              ? latestT("controlPanel.history.fileTranscriptionRequiresProTitle")
              : isNoAudio
                ? latestT("audio.errors.noAudio.title")
                : latestT("controlPanel.history.couldNotTranscribeFileTitle"),
          description:
            error?.code === "LICENSE_REQUIRED"
              ? latestT("controlPanel.history.fileTranscriptionRequiresProDescription")
              : isNoAudio
                ? latestT("audio.errors.noAudio.description")
                : error?.description ||
                  error?.message ||
                  latestT("controlPanel.history.couldNotTranscribeFileDescription"),
          variant: "destructive",
        });
      },
      onTranscriptionComplete: async (result: FileTranscriptionResult) => {
        if (!result?.success || !result?.text) {
          return;
        }

        const saveHistory = localStorage.getItem("transcriptionHistoryEnabled") !== "false";
        const saveResult = saveHistory
          ? await audioManager.saveTranscription(result.text, {
              recordingDurationMs: result.recordingDurationMs,
            })
          : null;
        setProgress(100);
        setStage("complete");
        setLastCompletedText(result.text);
        setHasCopiedCompletion(false);
        const { t: latestT, toast: latestToast } = latestCallbacksRef.current;

        if (saveHistory && saveResult?.success !== true) {
          latestToast({
            title: latestT("controlPanel.history.couldNotSaveFileTitle"),
            description: latestT("controlPanel.history.couldNotSaveFileDescription"),
            variant: "destructive",
          });
          return;
        }

        const fileName =
          activeFileNameRef.current || latestT("controlPanel.history.selectedFileFallback");
        const title = latestT("controlPanel.history.transcribedFileTitle");
        const description = latestT("controlPanel.history.transcribedFileDescription", {
          name: fileName,
        });
        const savedTranscriptionId =
          saveResult && typeof saveResult === "object"
            ? (saveResult as { id?: number; transcription?: { id?: number } }).id ||
              (saveResult as { id?: number; transcription?: { id?: number } }).transcription?.id ||
              null
            : null;

        if (localStorage.getItem("fileTranscriptionCompletionAlertEnabled") !== "false") {
          void window.electronAPI?.showFileTranscriptionCompletionAlert?.({
            id: savedTranscriptionId || null,
            text: result.text,
            title,
            description,
            fileName,
          });
        }
      },
    });

    return () => {
      audioManager.cancelProcessing();
      audioManager.cleanup();
      fileAudioManagerRef.current = null;
    };
  }, []);

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
      onUpgradeToPro();
      return;
    }

    fileInputRef.current?.click();
  }, [ensureFileTranscriptionAccess, isTranscribing, onUpgradeToPro]);

  const cancelFileTranscription = useCallback(() => {
    const cancelled = fileAudioManagerRef.current?.cancelProcessing?.();
    if (!cancelled) {
      return;
    }

    activeFileNameRef.current = "";
    setActiveFileName("");
    setIsTranscribing(false);
    setProgress(0);
    setStage("idle");
    setLastCompletedText("");
    setHasCopiedCompletion(false);
    toast({
      title: t("settingsPage.fileTranscription.cancelledTitle"),
      description: t("settingsPage.fileTranscription.cancelledDescription"),
      variant: "default",
    });
  }, [t, toast]);

  const startFileTranscription = useCallback(
    async (file: File) => {
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

      if (!isSupportedMediaFile(file)) {
        toast({
          title: t("controlPanel.history.couldNotTranscribeFileTitle"),
          description: t("controlPanel.history.unsupportedFileDescription"),
          variant: "destructive",
        });
        return;
      }

      activeFileNameRef.current = file.name;
      setActiveFileName(file.name);
      setIsTranscribing(true);
      setProgress(5);
      setStage("preparing");
      setLastCompletedText("");
      setHasCopiedCompletion(false);

      try {
        const durationSeconds = await getMediaDurationSeconds(file);
        await fileAudioManagerRef.current.transcribeFile(file, {
          sourceType: "file",
          sourceFileName: file.name,
          mimeType: file.type || null,
          durationSeconds,
        });
      } catch (error: unknown) {
        activeFileNameRef.current = "";
        setActiveFileName("");
        setIsTranscribing(false);
        setProgress(0);
        setStage("idle");
        setLastCompletedText("");
        setHasCopiedCompletion(false);
        toast({
          title: t("controlPanel.history.couldNotTranscribeFileTitle"),
          description:
            getErrorMessage(error) || t("controlPanel.history.couldNotTranscribeFileDescription"),
          variant: "destructive",
        });
      }
    },
    [t, toast]
  );

  const handleFileInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) {
        return;
      }

      await startFileTranscription(file);
    },
    [startFileTranscription]
  );

  const handleDropZoneDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragActive(false);

      if (isTranscribing) {
        return;
      }

      const file = event.dataTransfer.files?.[0];
      if (!file) {
        return;
      }

      if (!isSupportedMediaFile(file)) {
        toast({
          title: t("controlPanel.history.couldNotTranscribeFileTitle"),
          description: t("controlPanel.history.unsupportedFileDescription"),
          variant: "destructive",
        });
        return;
      }

      const { allowed, declinedTrial } = await ensureFileTranscriptionAccess();
      if (!allowed) {
        if (!declinedTrial) {
          onUpgradeToPro();
        }
        return;
      }

      await startFileTranscription(file);
    },
    [
      ensureFileTranscriptionAccess,
      isTranscribing,
      onUpgradeToPro,
      startFileTranscription,
      t,
      toast,
    ]
  );

  const copyCompletedTranscription = useCallback(async () => {
    if (!lastCompletedText) {
      return;
    }

    const result = await window.electronAPI?.writeClipboard?.(lastCompletedText);
    if (!result || result.success !== true) {
      toast({
        title: t("controlPanel.history.couldNotCopyTitle"),
        description: t("controlPanel.history.couldNotCopyDescription"),
        variant: "destructive",
      });
      return;
    }

    setHasCopiedCompletion(true);
    toast({
      title: t("controlPanel.history.copiedTitle"),
      description: t("controlPanel.history.copiedDescription"),
      variant: "success",
      duration: 2000,
    });
    window.setTimeout(() => setHasCopiedCompletion(false), 1600);
  }, [lastCompletedText, t, toast]);

  return (
    <div className="file-transcription-section space-y-4">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.6fr)]">
        <SectionCard>
          <div className="space-y-4">
            <div
              role="button"
              tabIndex={isTranscribing ? -1 : 0}
              className={cn(
                "file-drop-zone",
                isDragActive && !isTranscribing && "file-drop-zone--hover",
                isTranscribing && "file-drop-zone--disabled"
              )}
              onClick={() => {
                if (!isTranscribing) {
                  void requestFileTranscription();
                }
              }}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && !isTranscribing) {
                  event.preventDefault();
                  void requestFileTranscription();
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (!isTranscribing) {
                  setIsDragActive(true);
                }
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  return;
                }
                setIsDragActive(false);
              }}
              onDrop={(event) => {
                void handleDropZoneDrop(event);
              }}
            >
              <div className="glass-chip glass-chip--accent flex h-11 w-11 items-center justify-center rounded-2xl text-primary">
                {isTranscribing ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Upload className="h-5 w-5" />
                )}
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-semibold text-foreground">
                  {isTranscribing
                    ? t("settingsPage.fileTranscription.dropzoneBusyTitle")
                    : t("settingsPage.fileTranscription.dropzoneTitle")}
                </p>
                {dropzoneDescription ? (
                  <p className="text-[13px] leading-5 text-muted-foreground">
                    {dropzoneDescription}
                  </p>
                ) : null}
                <p className="text-[13px] leading-5 text-muted-foreground/80">
                  {t("settingsPage.fileTranscription.supportedFormats")}
                </p>
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
              {isTranscribing ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={cancelFileTranscription}
                  className="text-destructive hover:text-destructive"
                >
                  <X size={14} className="mr-1.5" />
                  {t("settingsPage.fileTranscription.cancelButton")}
                </Button>
              ) : null}
              {onOpenTranscriptionHistory && (
                <Button variant="outline" size="sm" onClick={() => onOpenTranscriptionHistory?.()}>
                  {t("settingsPage.fileTranscription.historyButton")}
                </Button>
              )}
              <Badge variant="outline" className="h-8 rounded-full px-3 text-[11px]">
                {t("settingsPage.account.badges.pro")}
              </Badge>
            </div>

            <div className="space-y-2">
              <h4 className="text-[14px] font-semibold tracking-tight text-foreground">
                {t("settingsPage.fileTranscription.route.label")}
              </h4>
              <div className="file-route-summary-card flex items-center gap-3 rounded-xl border border-border/40 bg-muted/10 px-4 py-3">
                <RouteIcon size={16} className="shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 truncate text-[14px] text-muted-foreground">
                  {routeTitle} · {activeProviderLabel} · {activeModelLabel}
                </p>
                {onOpenTranscriptionSettings ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onOpenTranscriptionSettings}
                    className="h-7 shrink-0 px-2 text-[13px]"
                  >
                    <Settings2 size={12} className="mr-1" />
                    {t("settingsPage.fileTranscription.route.switchButton")}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </SectionCard>

        <SectionCard title={t("settingsPage.fileTranscription.progressTitle")}>
          <div className="space-y-3">
            {isIdleState ? (
              <div className="file-progress-empty-card rounded-2xl border border-border/50 bg-surface-2/60 px-4 py-5">
                <div className="flex items-start gap-3">
                  <div className="glass-chip glass-chip--soft flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-primary">
                    <FileAudio className="h-5 w-5" />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-sm font-semibold text-foreground">
                      {t("settingsPage.fileTranscription.emptyStateTitle")}
                    </p>
                    <p className="text-[13px] leading-5 text-muted-foreground">
                      {t("settingsPage.fileTranscription.stages.idle")}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px] sm:items-start">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                      {t("settingsPage.fileTranscription.currentFile")}
                    </p>
                    <p
                      className={cn(
                        "mt-1 text-[14px] font-semibold leading-relaxed text-foreground break-all",
                        isTranscribing && "animate-pulse"
                      )}
                    >
                      {activeFileName || t("controlPanel.history.selectedFileFallback")}
                    </p>
                  </div>
                  <div className="text-left sm:text-right">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                      {t("settingsPage.fileTranscription.progressLabel")}
                    </p>
                    <div className="premium-stat-card mt-1 inline-flex min-w-[104px] items-center justify-center px-3 py-3 sm:min-w-[120px]">
                      <div className="text-[22px] font-semibold tabular-nums text-foreground">
                        {Math.round(progress)}%
                      </div>
                    </div>
                  </div>
                </div>

                <Progress
                  value={progress}
                  className={cn(
                    "h-2.5 overflow-hidden bg-muted/40 [&>div]:bg-primary",
                    isTranscribing && "[&>div]:animate-pulse"
                  )}
                />
              </>
            )}

            {!isIdleState && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                {stage !== "idle" && (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-3 py-1.5 text-[12px] font-medium uppercase tracking-[0.12em] shimmer-on-mount",
                      stageToneClass
                    )}
                  >
                    {t(`settingsPage.fileTranscription.stages.short.${stage}`)}
                  </span>
                )}
                {stage === "complete" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={copyCompletedTranscription}
                      disabled={!lastCompletedText}
                      className="h-8 px-3 text-[13px]"
                    >
                      {hasCopiedCompletion ? (
                        <Check size={13} className="mr-1.5" />
                      ) : (
                        <Clipboard size={13} className="mr-1.5" />
                      )}
                      {hasCopiedCompletion
                        ? t("controlPanel.history.copiedTitle")
                        : t("common.copy")}
                    </Button>
                    {onOpenTranscriptionHistory ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onOpenTranscriptionHistory?.()}
                        className="h-8 px-3 text-[13px]"
                      >
                        <FolderOpen size={13} className="mr-1.5" />
                        {t("settingsPage.fileTranscription.historyButton")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}

            {!isIdleState ? (
              <div className="file-progress-note rounded-xl border border-border/40 bg-muted/10 px-3 py-3">
                <div className="flex items-start gap-2.5">
                  <div className="glass-chip glass-chip--soft mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-primary">
                    <Sparkles className="h-4 w-4" />
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted-foreground/80">
                    {t(`settingsPage.fileTranscription.stages.${stage}`)}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </SectionCard>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept={SUPPORTED_MEDIA_ACCEPT}
        onChange={handleFileInputChange}
      />
    </div>
  );
}
