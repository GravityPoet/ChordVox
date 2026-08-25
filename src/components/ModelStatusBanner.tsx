import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { useToast } from "./ui/toastContext";
import { AlertTriangle, Check, Loader2, RefreshCw, Settings2 } from "lucide-react";
import type {
  ParakeetDownloadProgressData,
  ParaformerDownloadProgressData,
  SherpaStreamingDownloadProgressData,
} from "../types/electron";
import {
  ONBOARDING_MODEL_PREP_EVENT,
  getOnboardingStarterModel,
  getOnboardingStarterModelId,
  isOnboardingDownloadEventForPrepState,
  markOnboardingPreparedModelReady,
  readOnboardingModelPrepState,
  writeOnboardingModelPrepState,
  type OnboardingModelPrepState,
} from "../utils/onboardingModelPrep";

type OnboardingDownloadProgressData =
  | SherpaStreamingDownloadProgressData
  | ParakeetDownloadProgressData
  | ParaformerDownloadProgressData;

interface ModelStatusBannerProps {
  onOpenTranscriptionSettings: () => void;
}

export default function ModelStatusBanner({ onOpenTranscriptionSettings }: ModelStatusBannerProps) {
  const { i18n, t } = useTranslation();
  const { toast } = useToast();
  const [prepState, setPrepState] = useState<OnboardingModelPrepState>(() =>
    readOnboardingModelPrepState()
  );
  const [isRetrying, setIsRetrying] = useState(false);
  const [visibilityClock, setVisibilityClock] = useState(() => Date.now());
  const previousStatusRef = useRef(prepState.status);

  useEffect(() => {
    let cancelled = false;

    const reconcilePrepState = async () => {
      const persistedState = readOnboardingModelPrepState();

      if (
        persistedState.status === "idle" ||
        persistedState.status === "ready" ||
        persistedState.status === "error"
      ) {
        return;
      }

      if (!persistedState.modelId) {
        if (!cancelled) {
          setPrepState(writeOnboardingModelPrepState({ status: "idle", error: null }));
        }
        return;
      }

      try {
        const modelResult =
          persistedState.provider === "paraformer"
            ? await window.electronAPI?.checkParaformerModelStatus?.(persistedState.modelId)
            : persistedState.provider === "parakeet"
              ? await window.electronAPI?.checkParakeetModelStatus?.(persistedState.modelId)
              : await window.electronAPI?.sherpaStreamingCheckModel?.(
                  persistedState.modelId,
                  persistedState.modelsDir || undefined
                );
        const statusResult =
          persistedState.provider === "streaming"
            ? await window.electronAPI?.sherpaStreamingStatus?.()
            : null;

        if (cancelled) {
          return;
        }

        const modelReadyResult = modelResult as
          | { ready?: boolean; downloaded?: boolean }
          | undefined;
        const isReady =
          persistedState.provider === "streaming"
            ? Boolean(modelReadyResult?.ready)
            : Boolean(modelReadyResult?.downloaded);

        if (isReady) {
          markOnboardingPreparedModelReady(persistedState.provider, persistedState.modelId);
          setPrepState(
            writeOnboardingModelPrepState({
              status: "ready",
              provider: persistedState.provider,
              modelId: persistedState.modelId,
              modelsDir: persistedState.modelsDir,
              percentage: 100,
              error: null,
            })
          );
          return;
        }

        if (statusResult?.currentDownloadModelId === persistedState.modelId) {
          setPrepState(persistedState);
          return;
        }

        setPrepState(
          writeOnboardingModelPrepState({
            status: "error",
            modelId: persistedState.modelId,
            percentage: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            error: t("modelStatusBanner.errorDescription"),
          })
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.warn("Failed to reconcile onboarding model prep state:", error);
        setPrepState(
          writeOnboardingModelPrepState({
            status: "error",
            modelId: persistedState.modelId,
            percentage: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            error: t("modelStatusBanner.errorDescription"),
          })
        );
      }
    };

    void reconcilePrepState();

    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    const handlePrepStateChange = (event: Event) => {
      const detail = (event as CustomEvent<OnboardingModelPrepState>).detail;
      if (detail) {
        setPrepState(detail);
        return;
      }

      setPrepState(readOnboardingModelPrepState());
    };

    window.addEventListener(ONBOARDING_MODEL_PREP_EVENT, handlePrepStateChange as EventListener);
    return () => {
      window.removeEventListener(
        ONBOARDING_MODEL_PREP_EVENT,
        handlePrepStateChange as EventListener
      );
    };
  }, []);

  useEffect(() => {
    const handleDownloadProgress = (_event: unknown, data: OnboardingDownloadProgressData) => {
      if (!data) return;

      const trackedState = readOnboardingModelPrepState();
      if (!isOnboardingDownloadEventForPrepState(data, trackedState)) {
        return;
      }

      if (
        data.type === "source-connect" ||
        data.type === "source-switch" ||
        data.type === "verifying"
      ) {
        setPrepState(
          writeOnboardingModelPrepState({
            status: data.type === "verifying" ? "installing" : "downloading",
            message:
              data.type === "verifying"
                ? t("common.verifyingDownload")
                : data.type === "source-switch"
                  ? t("common.switchingDownloadNode")
                  : t("common.connectingDownloadNode"),
            error: null,
          })
        );
        return;
      }

      if (data.type === "progress") {
        const nextPercentage = Math.max(trackedState.percentage || 0, data.percentage || 0);
        const nextDownloadedBytes = Math.max(
          trackedState.downloadedBytes || 0,
          data.downloaded_bytes || 0
        );
        const nextTotalBytes = Math.max(trackedState.totalBytes || 0, data.total_bytes || 0);

        setPrepState(
          writeOnboardingModelPrepState({
            status: "downloading",
            percentage: nextPercentage,
            downloadedBytes: nextDownloadedBytes,
            totalBytes: nextTotalBytes,
            message: null,
            error: null,
          })
        );
        return;
      }

      if (data.type === "installing") {
        setPrepState(
          writeOnboardingModelPrepState({
            status: "installing",
            percentage: 100,
            message: null,
            error: null,
          })
        );
        return;
      }

      if (data.type === "complete") {
        markOnboardingPreparedModelReady(trackedState.provider, data.model);
        setPrepState(
          writeOnboardingModelPrepState({
            status: "ready",
            provider: trackedState.provider,
            modelId: data.model,
            modelsDir: trackedState.modelsDir,
            percentage: 100,
            message: null,
            error: null,
          })
        );
        setIsRetrying(false);
        return;
      }

      if (data.type === "error") {
        setPrepState(
          writeOnboardingModelPrepState({
            status: "error",
            error: data.error || "Failed to prepare local transcription model.",
          })
        );
        setIsRetrying(false);
      }
    };

    const disposeStreaming =
      window.electronAPI?.onSherpaStreamingDownloadProgress?.(handleDownloadProgress);
    const disposeParakeet =
      window.electronAPI?.onParakeetDownloadProgress?.(handleDownloadProgress);
    const disposeParaformer =
      window.electronAPI?.onParaformerDownloadProgress?.(handleDownloadProgress);

    return () => {
      disposeStreaming?.();
      disposeParakeet?.();
      disposeParaformer?.();
    };
  }, [t]);

  useEffect(() => {
    if (previousStatusRef.current !== "ready" && prepState.status === "ready") {
      toast({
        title: t("modelStatusBanner.readyTitle"),
        description: t("modelStatusBanner.readyToastDescription"),
        variant: "success",
      });
    }

    previousStatusRef.current = prepState.status;
  }, [i18n.language, prepState.status, t, toast]);

  const handleRetry = useCallback(async () => {
    const starterModel = getOnboardingStarterModel(i18n.language);
    const provider = prepState.provider || starterModel.provider;
    const modelId =
      prepState.modelId || starterModel.modelId || getOnboardingStarterModelId(i18n.language);
    const canDownload =
      provider === "paraformer"
        ? Boolean(window.electronAPI?.downloadParaformerModel)
        : provider === "parakeet"
          ? Boolean(window.electronAPI?.downloadParakeetModel)
          : Boolean(window.electronAPI?.sherpaStreamingDownloadModel);

    if (!canDownload) {
      setPrepState(
        writeOnboardingModelPrepState({
          status: "error",
          provider,
          modelId,
          modelsDir: prepState.modelsDir,
          error: t("modelStatusBanner.unsupportedEnvironment"),
        })
      );
      return;
    }

    setIsRetrying(true);
    setPrepState(
      writeOnboardingModelPrepState({
        status: "downloading",
        provider,
        modelId,
        modelsDir: prepState.modelsDir,
        percentage: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        message: null,
        error: null,
      })
    );

    try {
      const result =
        provider === "paraformer"
          ? await window.electronAPI?.downloadParaformerModel?.(modelId, {
              uiLanguage: i18n.resolvedLanguage || i18n.language,
              modelsDir: prepState.modelsDir || undefined,
            })
          : provider === "parakeet"
            ? await window.electronAPI?.downloadParakeetModel?.(modelId, {
                uiLanguage: i18n.resolvedLanguage || i18n.language,
                modelsDir: prepState.modelsDir || undefined,
              })
            : await window.electronAPI?.sherpaStreamingDownloadModel?.(
                modelId,
                prepState.modelsDir || undefined,
                {
                  uiLanguage: i18n.resolvedLanguage || i18n.language,
                }
              );
      if (!result?.success) {
        setPrepState(
          writeOnboardingModelPrepState({
            status: "error",
            provider,
            modelId,
            modelsDir: prepState.modelsDir,
            error: result?.error || t("modelStatusBanner.retryFailed"),
          })
        );
        return;
      }

      markOnboardingPreparedModelReady(provider, modelId);
      setPrepState(
        writeOnboardingModelPrepState({
          status: "ready",
          provider,
          modelId,
          modelsDir: prepState.modelsDir,
          percentage: 100,
          message: null,
          error: null,
        })
      );
    } catch (error) {
      setPrepState(
        writeOnboardingModelPrepState({
          status: "error",
          provider,
          modelId,
          modelsDir: prepState.modelsDir,
          error: error instanceof Error ? error.message : t("modelStatusBanner.retryFailed"),
        })
      );
    } finally {
      setIsRetrying(false);
    }
  }, [
    i18n.language,
    i18n.resolvedLanguage,
    prepState.modelId,
    prepState.modelsDir,
    prepState.provider,
    t,
  ]);

  useEffect(() => {
    if (prepState.status !== "ready") return;
    const remainingMs = prepState.updatedAt + 5 * 60 * 1000 - Date.now();
    if (remainingMs <= 0) {
      setVisibilityClock(Date.now());
      return;
    }

    setVisibilityClock(Date.now());
    const timer = window.setTimeout(() => setVisibilityClock(Date.now()), remainingMs + 50);
    return () => window.clearTimeout(timer);
  }, [prepState.status, prepState.updatedAt]);

  const isReadyBannerVisible =
    prepState.status === "ready" && visibilityClock - prepState.updatedAt < 5 * 60 * 1000;
  if (prepState.status === "idle" || (prepState.status === "ready" && !isReadyBannerVisible)) {
    return null;
  }

  const isBusy =
    isRetrying || prepState.status === "checking" || prepState.status === "downloading";
  const headline =
    prepState.status === "ready"
      ? t("modelStatusBanner.readyTitle")
      : prepState.status === "error"
        ? t("modelStatusBanner.errorTitle")
        : t("modelStatusBanner.loadingTitle");
  const description =
    prepState.status === "ready"
      ? t("modelStatusBanner.readyDescription")
      : prepState.status === "error"
        ? prepState.error || t("modelStatusBanner.errorDescription")
        : prepState.message
          ? prepState.message
          : t("modelStatusBanner.loadingDescription", {
              model: prepState.modelId || getOnboardingStarterModelId(i18n.language),
              percentage: Math.round(prepState.percentage || 0),
            });
  const downloadPercentage = Math.min(Math.max(Math.round(prepState.percentage || 0), 0), 100);
  const visibleDownloadPercentage =
    downloadPercentage > 0 && downloadPercentage < 2 ? 2 : downloadPercentage;

  return (
    <section className="glass-panel glass-panel--soft rounded-[24px] px-4 py-3 backdrop-blur-xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {prepState.status === "error" ? (
              <AlertTriangle className="h-4 w-4 text-warning" />
            ) : prepState.status === "ready" ? (
              <Check className="h-4 w-4 text-success" />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            )}
            <span>{headline}</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
          {prepState.status === "downloading" && (
            <div
              className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={headline}
              aria-valuenow={downloadPercentage}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${visibleDownloadPercentage}%` }}
              />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {prepState.status === "error" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRetry}
              disabled={isRetrying}
              className="gap-1.5"
            >
              {isRetrying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              <span>{t("modelStatusBanner.retry")}</span>
            </Button>
          )}
          <Button
            type="button"
            variant={prepState.status === "ready" ? "outline" : "secondary"}
            size="sm"
            onClick={onOpenTranscriptionSettings}
            className="gap-1.5"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span>{t("modelStatusBanner.settings")}</span>
          </Button>
        </div>
      </div>
    </section>
  );
}
