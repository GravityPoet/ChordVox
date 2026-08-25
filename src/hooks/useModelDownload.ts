import { useState, useCallback, useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useDialogs } from "./useDialogs";
import { useToast } from "../components/ui/toastContext";
import type { WhisperDownloadProgressData } from "../types/electron";
import { addChordVoxModelsClearedListener } from "../utils/chordvoxCloud";
import "../types/electron";

const PROGRESS_THROTTLE_MS = 100;

export interface DownloadProgress {
  percentage: number;
  downloadedBytes: number;
  totalBytes: number;
  speed?: number;
  eta?: number;
  statusMessage?: string;
}

export type ModelType = "whisper" | "llm" | "parakeet" | "paraformer" | "granite";

interface UseModelDownloadOptions {
  modelType: ModelType;
  onDownloadComplete?: () => void;
  onModelsCleared?: () => void;
}

interface LLMDownloadProgressData {
  modelId: string;
  progress: number;
  downloadedSize: number;
  totalSize: number;
}

export function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function withAction(t: TFunction, message: string, actionKey: string): string {
  const action = t(actionKey, { defaultValue: "" });
  return action ? `${message}\n\n${action}` : message;
}

function getDownloadErrorMessage(t: TFunction, error: string, code?: string): string {
  if (code === "EXTRACTION_FAILED" || error.includes("installation failed"))
    return withAction(
      t,
      t("hooks.modelDownload.errors.extractionFailed"),
      "hooks.modelDownload.errors.actions.extractionFailed"
    );
  if (
    code === "DOWNLOAD_SOURCES_EXHAUSTED" ||
    code === "ERR_FILE_CHECKSUM_MISMATCH" ||
    code === "ERR_FILE_SIZE_MISMATCH" ||
    code === "ERR_DOWNLOAD_INCOMPLETE"
  )
    return withAction(
      t,
      t("hooks.modelDownload.errors.downloadNodesUnavailable"),
      "hooks.modelDownload.errors.actions.downloadNodesUnavailable"
    );
  if (code === "ETIMEDOUT" || error.includes("timeout") || error.includes("stalled"))
    return withAction(
      t,
      t("hooks.modelDownload.errors.timeout"),
      "hooks.modelDownload.errors.actions.timeout"
    );
  if (code === "ENOTFOUND" || error.includes("ENOTFOUND"))
    return withAction(
      t,
      t("hooks.modelDownload.errors.notFound"),
      "hooks.modelDownload.errors.actions.notFound"
    );
  if (error.includes("disk space"))
    return withAction(
      t,
      t("hooks.modelDownload.errors.diskSpace"),
      "hooks.modelDownload.errors.actions.diskSpace"
    );
  if (error.includes("corrupted") || error.includes("incomplete") || error.includes("too small"))
    return withAction(
      t,
      t("hooks.modelDownload.errors.corrupted"),
      "hooks.modelDownload.errors.actions.corrupted"
    );
  if (error.includes("HTTP 429") || error.includes("rate limit"))
    return withAction(
      t,
      t("hooks.modelDownload.errors.rateLimited"),
      "hooks.modelDownload.errors.actions.rateLimited"
    );
  if (error.includes("HTTP 4") || error.includes("HTTP 5"))
    return withAction(
      t,
      t("hooks.modelDownload.errors.server", { error }),
      "hooks.modelDownload.errors.actions.server"
    );
  return withAction(
    t,
    t("hooks.modelDownload.errors.generic", { error }),
    "hooks.modelDownload.errors.actions.generic"
  );
}

function getDownloadStatusMessage(t: TFunction, type: string): string {
  if (type === "source-connect") return t("common.connectingDownloadNode");
  if (type === "source-switch") return t("common.switchingDownloadNode");
  if (type === "verifying") return t("common.verifyingDownload");
  if (type === "repairing") return t("common.repairingDownload");
  return t("common.downloading");
}

export function useModelDownload({
  modelType,
  onDownloadComplete,
  onModelsCleared,
}: UseModelDownloadOptions) {
  const { t, i18n } = useTranslation();
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    percentage: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  });
  const [isCancelling, setIsCancelling] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const isCancellingRef = useRef(false);
  const lastProgressUpdateRef = useRef(0);

  const { showAlertDialog } = useDialogs();
  const { toast } = useToast();
  const showAlertDialogRef = useRef(showAlertDialog);
  const onDownloadCompleteRef = useRef(onDownloadComplete);
  const onModelsClearedRef = useRef(onModelsCleared);

  useEffect(() => {
    showAlertDialogRef.current = showAlertDialog;
  }, [showAlertDialog]);

  useEffect(() => {
    onDownloadCompleteRef.current = onDownloadComplete;
  }, [onDownloadComplete]);

  useEffect(() => {
    onModelsClearedRef.current = onModelsCleared;
  }, [onModelsCleared]);

  useEffect(() => {
    const handleModelsCleared = () => onModelsClearedRef.current?.();
    return addChordVoxModelsClearedListener(window, handleModelsCleared);
  }, []);

  const handleWhisperProgress = useCallback(
    (_event: unknown, data: WhisperDownloadProgressData) => {
      if (
        data.type === "source-connect" ||
        data.type === "source-switch" ||
        data.type === "verifying" ||
        data.type === "repairing"
      ) {
        setIsInstalling(data.type === "verifying" || data.type === "repairing");
        setDownloadProgress((prev) => ({
          percentage: Math.max(prev.percentage || 0, data.percentage ?? prev.percentage),
          downloadedBytes: Math.max(
            prev.downloadedBytes || 0,
            data.downloaded_bytes ?? prev.downloadedBytes
          ),
          totalBytes: Math.max(prev.totalBytes || 0, data.total_bytes ?? prev.totalBytes),
          statusMessage: getDownloadStatusMessage(t, data.type),
        }));
      } else if (data.type === "progress") {
        const now = Date.now();
        if (now - lastProgressUpdateRef.current < PROGRESS_THROTTLE_MS) return;
        lastProgressUpdateRef.current = now;
        setIsInstalling(false);
        setDownloadProgress((prev) => ({
          percentage: Math.max(prev.percentage || 0, data.percentage || 0),
          downloadedBytes: Math.max(prev.downloadedBytes || 0, data.downloaded_bytes || 0),
          totalBytes: Math.max(prev.totalBytes || 0, data.total_bytes || 0),
          statusMessage: t("common.downloading"),
        }));
      } else if (data.type === "installing") {
        setIsInstalling(true);
        setDownloadProgress((prev) => ({
          ...prev,
          percentage: data.percentage ?? prev.percentage,
          statusMessage: t("common.installing"),
        }));
      } else if (data.type === "complete") {
        if (isCancellingRef.current) return;
        setIsInstalling(false);
        // Don't clear downloadingModel/downloadProgress here — let downloadModel's
        // finally block handle it after the model list has been refreshed.
        // This prevents a flash where the model appears "not downloaded".
      } else if (data.type === "error") {
        if (isCancellingRef.current) return;
        const msg = getDownloadErrorMessage(
          t,
          data.error || t("hooks.modelDownload.errors.unknown"),
          data.code
        );
        const title =
          data.code === "EXTRACTION_FAILED"
            ? t("hooks.modelDownload.installationFailed.title")
            : t("hooks.modelDownload.downloadFailed.title");
        setDownloadError(msg);
        showAlertDialogRef.current({ title, description: msg });
        setIsInstalling(false);
        setDownloadingModel(null);
        setDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
      }
    },
    [t]
  );

  const handleLLMProgress = useCallback((_event: unknown, data: LLMDownloadProgressData) => {
    if (isCancellingRef.current) return;

    const now = Date.now();
    const isComplete = data.progress >= 100;
    if (!isComplete && now - lastProgressUpdateRef.current < PROGRESS_THROTTLE_MS) {
      return;
    }
    lastProgressUpdateRef.current = now;

    setDownloadProgress((previous) => ({
      percentage: Math.max(previous.percentage || 0, data.progress || 0),
      downloadedBytes: Math.max(previous.downloadedBytes || 0, data.downloadedSize || 0),
      totalBytes: Math.max(previous.totalBytes || 0, data.totalSize || 0),
    }));
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;

    if (modelType === "whisper") {
      dispose = window.electronAPI?.onWhisperDownloadProgress(handleWhisperProgress);
    } else if (modelType === "parakeet") {
      dispose = window.electronAPI?.onParakeetDownloadProgress(handleWhisperProgress);
    } else if (modelType === "paraformer") {
      dispose = window.electronAPI?.onParaformerDownloadProgress(handleWhisperProgress);
    } else if (modelType === "granite") {
      dispose = window.electronAPI?.onGraniteDownloadProgress(handleWhisperProgress);
    } else {
      dispose = window.electronAPI?.onModelDownloadProgress(handleLLMProgress);
    }

    return () => {
      dispose?.();
    };
  }, [handleWhisperProgress, handleLLMProgress, modelType]);

  const downloadModel = useCallback(
    async (modelId: string, onSelectAfterDownload?: (id: string) => void) => {
      if (downloadingModel) {
        toast({
          title: t("hooks.modelDownload.downloadInProgress.title"),
          description: t("hooks.modelDownload.downloadInProgress.description"),
        });
        return;
      }

      try {
        setDownloadingModel(modelId);
        setDownloadError(null);
        setDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
        lastProgressUpdateRef.current = 0; // Reset throttle timer

        let success = false;
        const downloadOptions = {
          uiLanguage:
            i18n.resolvedLanguage ||
            i18n.language ||
            window.localStorage.getItem("uiLanguage") ||
            "en",
        };

        if (modelType === "whisper") {
          const result = await window.electronAPI?.downloadWhisperModel(modelId, downloadOptions);
          if (!result?.success && !result?.error?.includes("interrupted by user")) {
            const msg = getDownloadErrorMessage(
              t,
              result?.error || t("hooks.modelDownload.errors.unknown"),
              result?.code
            );
            setDownloadError(msg);
            showAlertDialog({
              title: t("hooks.modelDownload.downloadFailed.title"),
              description: msg,
            });
          } else {
            success = result?.success ?? false;
          }
        } else if (modelType === "parakeet") {
          const result = await window.electronAPI?.downloadParakeetModel(modelId, downloadOptions);
          if (!result?.success && !result?.error?.includes("interrupted by user")) {
            const msg = getDownloadErrorMessage(
              t,
              result?.error || t("hooks.modelDownload.errors.unknown"),
              result?.code
            );
            const title =
              result?.code === "EXTRACTION_FAILED"
                ? t("hooks.modelDownload.installationFailed.title")
                : t("hooks.modelDownload.downloadFailed.title");
            setDownloadError(msg);
            showAlertDialog({ title, description: msg });
          } else {
            success = result?.success ?? false;
          }
        } else if (modelType === "paraformer") {
          const result = await window.electronAPI?.downloadParaformerModel(
            modelId,
            downloadOptions
          );
          if (!result?.success && !result?.error?.includes("interrupted by user")) {
            const msg = getDownloadErrorMessage(
              t,
              result?.error || t("hooks.modelDownload.errors.unknown"),
              result?.code
            );
            const title =
              result?.code === "EXTRACTION_FAILED"
                ? t("hooks.modelDownload.installationFailed.title")
                : t("hooks.modelDownload.downloadFailed.title");
            setDownloadError(msg);
            showAlertDialog({ title, description: msg });
          } else {
            success = result?.success ?? false;
          }
        } else if (modelType === "granite") {
          const result = await window.electronAPI?.downloadGraniteModel(modelId, downloadOptions);
          if (!result?.success && !result?.error?.includes("interrupted by user")) {
            const msg = getDownloadErrorMessage(
              t,
              result?.error || t("hooks.modelDownload.errors.unknown"),
              result?.code
            );
            const title =
              result?.code === "RUNTIME_INSTALL_FAILED" ||
              result?.code === "RUNTIME_INSTALL_INCOMPLETE"
                ? t("hooks.modelDownload.installationFailed.title")
                : t("hooks.modelDownload.downloadFailed.title");
            setDownloadError(msg);
            showAlertDialog({ title, description: msg });
          } else {
            success = result?.success ?? false;
          }
        } else {
          const result = (await window.electronAPI?.modelDownload?.(modelId)) as unknown as
            | { success: boolean; error?: string; code?: string }
            | undefined;
          if (result && !result.success && result.error) {
            const msg = getDownloadErrorMessage(t, result.error, result.code);
            setDownloadError(msg);
            showAlertDialog({
              title: t("hooks.modelDownload.downloadFailed.title"),
              description: msg,
            });
          } else {
            success = result?.success ?? false;
          }
        }

        if (success) {
          onSelectAfterDownload?.(modelId);
        }

        // Await the refresh so the model list is updated before we clear
        // the downloading state in `finally`. This prevents a flash where
        // the model briefly appears "not downloaded".
        if (success) {
          try {
            await onDownloadCompleteRef.current?.();
          } catch {
            // Non-fatal — the model is on disk regardless
          }
        }
      } catch (error: unknown) {
        if (isCancellingRef.current) return;

        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          !errorMessage.includes("interrupted by user") &&
          !errorMessage.includes("cancelled by user") &&
          !errorMessage.includes("DOWNLOAD_CANCELLED")
        ) {
          const msg = getDownloadErrorMessage(t, errorMessage);
          setDownloadError(msg);
          showAlertDialog({
            title: t("hooks.modelDownload.downloadFailed.title"),
            description: msg,
          });
        }
      } finally {
        setIsInstalling(false);
        setIsCancelling(false);
        isCancellingRef.current = false;
        setDownloadingModel(null);
        setDownloadProgress({ percentage: 0, downloadedBytes: 0, totalBytes: 0 });
      }
    },
    [downloadingModel, i18n.language, i18n.resolvedLanguage, modelType, showAlertDialog, toast, t]
  );

  const deleteModel = useCallback(
    async (modelId: string, onComplete?: () => unknown | Promise<unknown>) => {
      try {
        let result: { success: boolean; freed_mb?: number; error?: string } | undefined;
        if (modelType === "whisper") {
          result = await window.electronAPI?.deleteWhisperModel(modelId);
        } else if (modelType === "parakeet") {
          result = await window.electronAPI?.deleteParakeetModel(modelId);
        } else if (modelType === "paraformer") {
          result = await window.electronAPI?.deleteParaformerModel(modelId);
        } else if (modelType === "granite") {
          result = await window.electronAPI?.deleteGraniteModel(modelId);
        } else {
          result = await window.electronAPI?.modelDelete?.(modelId);
        }

        // A stale card can outlive a model that was removed outside the app.
        // "Model not found" already satisfies the user's delete intent, so
        // continue into the normal refresh path instead of freezing the old UI state.
        const modelAlreadyAbsent = result?.error?.trim().toLowerCase() === "model not found";
        if (!result?.success && !modelAlreadyAbsent) {
          throw new Error(result?.error || t("hooks.modelDownload.errors.unknown"));
        }

        toast({
          title: t("hooks.modelDownload.modelDeleted.title"),
          description:
            typeof result.freed_mb === "number"
              ? t("hooks.modelDownload.modelDeleted.descriptionWithSpace", {
                  sizeMb: result.freed_mb,
                })
              : t("hooks.modelDownload.modelDeleted.description"),
        });
        try {
          await onComplete?.();
        } catch (refreshError) {
          console.warn("Model deleted but model-list refresh failed:", refreshError);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showAlertDialog({
          title: t("hooks.modelDownload.deleteFailed.title"),
          description: t("hooks.modelDownload.deleteFailed.description", { error: errorMessage }),
        });
      }
    },
    [modelType, toast, showAlertDialog, t]
  );

  const cancelDownload = useCallback(async () => {
    if (!downloadingModel || isCancelling) return;

    setIsCancelling(true);
    isCancellingRef.current = true;
    let cancellationAccepted = false;
    try {
      let result: { success: boolean; error?: string } | undefined;
      if (modelType === "whisper") {
        result = await window.electronAPI?.cancelWhisperDownload();
      } else if (modelType === "parakeet") {
        result = await window.electronAPI?.cancelParakeetDownload();
      } else if (modelType === "paraformer") {
        result = await window.electronAPI?.cancelParaformerDownload();
      } else if (modelType === "granite") {
        result = await window.electronAPI?.cancelGraniteDownload();
      } else {
        result = await window.electronAPI?.modelCancelDownload?.(downloadingModel);
      }
      if (!result?.success) {
        throw new Error(result?.error || t("hooks.modelDownload.errors.unknown"));
      }
      cancellationAccepted = true;
      toast({
        title: t("hooks.modelDownload.downloadCancelled.title"),
        description: t("hooks.modelDownload.downloadCancelled.description"),
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      isCancellingRef.current = false;
      showAlertDialog({
        title: t("hooks.modelDownload.cancelFailed.title"),
        description: t("hooks.modelDownload.cancelFailed.description", { error: errorMessage }),
      });
    } finally {
      if (!cancellationAccepted) {
        setIsCancelling(false);
      }
    }
  }, [downloadingModel, isCancelling, modelType, showAlertDialog, toast, t]);

  const isDownloading = downloadingModel !== null;
  const isDownloadingModel = useCallback(
    (modelId: string) => downloadingModel === modelId,
    [downloadingModel]
  );

  return {
    downloadingModel,
    downloadProgress,
    downloadError,
    isDownloading,
    isDownloadingModel,
    isInstalling,
    isCancelling,
    downloadModel,
    deleteModel,
    cancelDownload,
    formatETA,
  };
}
