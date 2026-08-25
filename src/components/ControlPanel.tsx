import React, { Suspense, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { LiquidGlassFilters } from "./ui/LiquidGlassFilters";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Trash2,
  Settings,
  FileText,
  ChevronLeft,
  Mic,
  Download,
  Upload,
  FolderOpen,
  RefreshCw,
  Loader2,
  Search,
  X,
  Star,
} from "lucide-react";
import { cn } from "./lib/utils";
import type {
  TranscriptionExportFormat,
  TranscriptionItem as TranscriptionItemType,
} from "../types/electron";
import type { SettingsSectionType } from "./SettingsModal";
import TitleBar from "./TitleBar";
import SupportDropdown from "./ui/SupportDropdown";
import TranscriptionItem from "./ui/TranscriptionItem";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { useDialogs } from "../hooks/useDialogs";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/toastContext";
import { useUpdater } from "../hooks/useUpdater";
import { useSettings } from "../hooks/useSettings";
import ReasoningService from "../services/ReasoningService";
import type { LicenseStatusResult } from "../types/electron";
import AudioManager from "../helpers/audioManager";
import {
  useTranscriptions,
  useTranscriptionHistoryMeta,
  initializeTranscriptions,
  loadMoreTranscriptions,
  removeTranscription as removeFromStore,
  clearTranscriptions as clearStoreTranscriptions,
} from "../stores/transcriptionStore";
import { formatHotkeyLabel } from "../utils/hotkeys";
import { buildLocalizedUpdateDescription } from "../utils/updateReleaseNotes";
import { useWindowActivity } from "../hooks/useWindowActivity";
import {
  getMediaDurationSeconds,
  isSupportedMediaFile,
  SUPPORTED_MEDIA_ACCEPT,
} from "../utils/mediaFile";

const SettingsModal = React.lazy(() => import("./SettingsModal"));

type ProAccessResult = {
  allowed: boolean;
  declinedTrial: boolean;
  status: LicenseStatusResult | null;
};

interface ControlPanelProps {
  forceShowHome?: boolean;
  onForceShowHomeHandled?: () => void;
}

interface FileAudioStateChange {
  isProcessing?: boolean;
}

interface FileAudioProgress {
  progress?: number;
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

// Keep a hard upper bound on mounted history rows. Users can reveal more in
// predictable batches without making a long-lived control-panel window mount
// an unbounded number of interactive React subtrees.
const HISTORY_RENDER_BATCH_SIZE = 200;

function getErrorMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return null;
  }

  return typeof error.message === "string" ? error.message : null;
}

export default function ControlPanel({
  forceShowHome = false,
  onForceShowHomeHandled,
}: ControlPanelProps = {}) {
  useWindowActivity();
  const { i18n, t } = useTranslation();
  const history = useTranscriptions();
  const historyMeta = useTranscriptionHistoryMeta();
  const { hotkey } = useHotkey();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(true);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionType | undefined>(
    "account"
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileAudioManagerRef = useRef<AudioManager | null>(null);
  const activeFileNameRef = useRef("");
  const [isFileTranscribing, setIsFileTranscribing] = useState(false);
  const [activeFileName, setActiveFileName] = useState("");
  const [fileTranscriptionProgress, setFileTranscriptionProgress] = useState(0);
  const [hideHistoryDuringHomeHandoff, setHideHistoryDuringHomeHandoff] = useState(forceShowHome);
  const [historySearch, setHistorySearch] = useState("");
  const [historyTimeFilter, setHistoryTimeFilter] = useState<"all" | "today" | "week" | "month">(
    "all"
  );
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<number>>(() => new Set());
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const updateInstallPromptShownRef = useRef<string | null>(null);
  const hasActiveHistoryFilters =
    historySearch.trim().length > 0 || historyTimeFilter !== "all" || showFavoritesOnly;
  const [filteredDbHistory, setFilteredDbHistory] = useState<TranscriptionItemType[]>([]);
  const [filteredHistoryHasMore, setFilteredHistoryHasMore] = useState(false);
  const [filteredHistoryCursor, setFilteredHistoryCursor] = useState<string | null>(null);
  const [filteredHistoryTotal, setFilteredHistoryTotal] = useState<number | null>(null);
  const [isFilteringHistory, setIsFilteringHistory] = useState(false);
  const [historyFilterError, setHistoryFilterError] = useState<string | null>(null);
  const [historyRenderLimit, setHistoryRenderLimit] = useState(HISTORY_RENDER_BATCH_SIZE);
  const historyFilterSeqRef = useRef(0);

  const historyFilterOptions = useMemo(() => {
    const horizonMs =
      historyTimeFilter === "today"
        ? 24 * 60 * 60 * 1000
        : historyTimeFilter === "week"
          ? 7 * 24 * 60 * 60 * 1000
          : historyTimeFilter === "month"
            ? 30 * 24 * 60 * 60 * 1000
            : null;
    return {
      query: historySearch.trim(),
      favoriteOnly: showFavoritesOnly,
      since: horizonMs === null ? null : new Date(Date.now() - horizonMs).toISOString(),
    };
  }, [historySearch, historyTimeFilter, showFavoritesOnly]);

  const fetchFilteredHistory = useCallback(
    async (
      options: typeof historyFilterOptions,
      { cursor = null, append = false }: { cursor?: string | null; append?: boolean } = {}
    ) => {
      const seq = ++historyFilterSeqRef.current;
      setIsFilteringHistory(true);
      setHistoryFilterError(null);
      try {
        const result = await window.electronAPI.queryTranscriptionHistory({
          requestKey: "control-panel-history",
          ...options,
          limit: 50,
          cursor,
        });
        if (seq !== historyFilterSeqRef.current || result?.cancelled) {
          return;
        }
        if (result?.error) {
          throw new Error(result.error);
        }
        setFilteredDbHistory((current) =>
          append ? [...current, ...(result?.items || [])] : result?.items || []
        );
        setFilteredHistoryHasMore(result?.hasMore === true);
        setFilteredHistoryCursor(result?.nextCursor || null);
        setFilteredHistoryTotal(typeof result?.totalCount === "number" ? result.totalCount : null);
      } catch (error) {
        if (seq === historyFilterSeqRef.current) {
          if (!append) {
            setFilteredDbHistory([]);
          }
          setFilteredHistoryHasMore(false);
          setFilteredHistoryCursor(null);
          setHistoryFilterError(
            error instanceof Error
              ? error.message
              : t("controlPanel.history.couldNotLoadDescription")
          );
        }
      } finally {
        if (seq === historyFilterSeqRef.current) {
          setIsFilteringHistory(false);
        }
      }
    },
    [t]
  );

  const runFilteredHistoryQuery = useDebouncedCallback((options: typeof historyFilterOptions) => {
    void fetchFilteredHistory(options);
  }, 250);

  useEffect(() => {
    setHistoryRenderLimit(HISTORY_RENDER_BATCH_SIZE);
  }, [historyFilterOptions]);

  useEffect(() => {
    if (!hasActiveHistoryFilters) {
      runFilteredHistoryQuery.cancel();
      historyFilterSeqRef.current += 1;
      setFilteredDbHistory([]);
      setFilteredHistoryHasMore(false);
      setFilteredHistoryCursor(null);
      setFilteredHistoryTotal(null);
      setIsFilteringHistory(false);
      setHistoryFilterError(null);
      return;
    }
    runFilteredHistoryQuery(historyFilterOptions);
  }, [hasActiveHistoryFilters, historyFilterOptions, runFilteredHistoryQuery]);

  const filteredHistory = hasActiveHistoryFilters ? filteredDbHistory : history;
  const renderedHistory = useMemo(
    () => filteredHistory.slice(0, historyRenderLimit),
    [filteredHistory, historyRenderLimit]
  );
  const hasUnrenderedHistory = renderedHistory.length < filteredHistory.length;
  const historySelectionScope = useMemo(() => {
    const merged = new Map<number, TranscriptionItemType>();
    history.forEach((item) => merged.set(item.id, item));
    filteredDbHistory.forEach((item) => merged.set(item.id, item));
    return Array.from(merged.values());
  }, [filteredDbHistory, history]);

  const selectedHistoryItems = useMemo(() => {
    if (selectedHistoryIds.size === 0) return [];
    return historySelectionScope.filter((item) => selectedHistoryIds.has(item.id));
  }, [historySelectionScope, selectedHistoryIds]);

  const selectedHistoryCount = selectedHistoryItems.length;
  const filteredHistoryIds = useMemo(
    () => renderedHistory.map((item) => item.id),
    [renderedHistory]
  );
  const selectedVisibleCount = useMemo(
    () => filteredHistoryIds.filter((id) => selectedHistoryIds.has(id)).length,
    [filteredHistoryIds, selectedHistoryIds]
  );
  const allVisibleHistorySelected =
    filteredHistoryIds.length > 0 && selectedVisibleCount === filteredHistoryIds.length;
  const visibleHistoryHasMore =
    hasUnrenderedHistory ||
    (hasActiveHistoryFilters ? filteredHistoryHasMore : historyMeta.hasMore);
  const isLoadingMoreHistory = hasActiveHistoryFilters
    ? isFilteringHistory && filteredHistory.length > 0
    : historyMeta.isLoadingMore;
  const visibleHistoryCountLabel = hasActiveHistoryFilters
    ? filteredHistoryHasMore
      ? `${filteredHistory.length}+`
      : String(filteredHistoryTotal ?? filteredHistory.length)
    : String(historyMeta.totalCount);

  const loadMoreVisibleHistory = useCallback(async () => {
    if (hasUnrenderedHistory) {
      setHistoryRenderLimit((current) => current + HISTORY_RENDER_BATCH_SIZE);
      return;
    }

    if (hasActiveHistoryFilters) {
      await fetchFilteredHistory(historyFilterOptions, {
        cursor: filteredHistoryCursor,
        append: true,
      });
      return;
    }
    await loadMoreTranscriptions();
  }, [
    fetchFilteredHistory,
    filteredHistoryCursor,
    hasActiveHistoryFilters,
    hasUnrenderedHistory,
    historyFilterOptions,
  ]);

  const { reasoningModel, reasoningProvider } = useSettings();

  const {
    status: updateStatus,
    info: updateInfo,
    downloadProgress,
    isDownloading,
    isInstalling,
    downloadUpdate,
    installUpdate,
    error: updateError,
  } = useUpdater();

  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  useEffect(() => {
    const dispose = window.electronAPI?.onOpenSettingsSection?.((payload) => {
      const section = payload?.section;
      if (typeof section === "string") {
        setSettingsSection(section as SettingsSectionType);
      }
      setShowSettings(true);
    });

    return () => {
      dispose?.();
    };
  }, []);

  useEffect(() => {
    const dispose = window.electronAPI?.onOpenTranscriptionHistory?.(() => {
      setShowSettings(false);
      setSettingsSection(undefined);
      setHideHistoryDuringHomeHandoff(false);
    });

    return () => {
      dispose?.();
    };
  }, []);

  // Native Liquid Glass: set data attribute on document for CSS branching
  useEffect(() => {
    // Check capability on mount
    window.electronAPI?.getNativeGlassCapability?.()?.then?.((cap: { method?: string }) => {
      if (
        cap?.method === "liquid-glass" ||
        cap?.method === "vibrancy" ||
        cap?.method === "acrylic"
      ) {
        document.documentElement.setAttribute("data-native-glass", cap.method);
      }
    });

    // Also listen for push from main process
    const dispose = window.electronAPI?.onNativeGlassCapability?.(
      (payload: { method?: string }) => {
        if (
          payload?.method === "liquid-glass" ||
          payload?.method === "vibrancy" ||
          payload?.method === "acrylic"
        ) {
          document.documentElement.setAttribute("data-native-glass", payload.method);
        } else {
          document.documentElement.removeAttribute("data-native-glass");
        }
      }
    );

    return () => {
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (!forceShowHome) {
      return;
    }

    setHideHistoryDuringHomeHandoff(true);
    setSettingsSection("account");
    setShowSettings(true);

    const handoffTimer = window.setTimeout(() => {
      onForceShowHomeHandled?.();
      setHideHistoryDuringHomeHandoff(false);
    }, 220);

    return () => {
      window.clearTimeout(handoffTimer);
    };
  }, [forceShowHome, onForceShowHomeHandled]);

  useEffect(() => {
    const audioManager = new AudioManager();
    fileAudioManagerRef.current = audioManager;

    audioManager.setCallbacks({
      onStateChange: ({ isProcessing }: FileAudioStateChange) => {
        const nextProcessing = Boolean(isProcessing);
        setIsFileTranscribing(nextProcessing);
        if (!nextProcessing) {
          activeFileNameRef.current = "";
          setActiveFileName("");
          setFileTranscriptionProgress(0);
        }
      },
      onProgress: ({ progress }: FileAudioProgress) => {
        setFileTranscriptionProgress(Math.max(0, Math.min(100, Math.round(progress || 0))));
      },
      onPartialTranscript: () => {},
      onAudioLevel: () => {},
      onError: (error: FileAudioError) => {
        activeFileNameRef.current = "";
        setActiveFileName("");
        setIsFileTranscribing(false);
        setFileTranscriptionProgress(0);
        const isLicenseRequired = error?.code === "LICENSE_REQUIRED";
        const isNoAudio = error?.code === "NO_AUDIO_DETECTED";
        if (isLicenseRequired) {
          setSettingsSection("account");
          setShowSettings(true);
          toast({
            title: t("controlPanel.history.fileTranscriptionRequiresProTitle"),
            description: t("controlPanel.history.fileTranscriptionRequiresProDescription"),
            variant: "destructive",
          });
          return;
        }

        toast({
          title: isNoAudio
            ? t("audio.errors.noAudio.title")
            : t("controlPanel.history.couldNotTranscribeFileTitle"),
          description:
            (isNoAudio && t("audio.errors.noAudio.description")) ||
            error?.description ||
            error?.message ||
            t("controlPanel.history.couldNotTranscribeFileDescription"),
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
        const saveFailed = saveHistory && saveResult?.success !== true;
        const fileName =
          activeFileNameRef.current || t("controlPanel.history.selectedFileFallback");
        const title = saveFailed
          ? t("controlPanel.history.couldNotSaveFileTitle")
          : t("controlPanel.history.transcribedFileTitle");
        const description = saveFailed
          ? t("controlPanel.history.couldNotSaveFileDescription")
          : t("controlPanel.history.transcribedFileDescription", {
              name: fileName,
            });
        const savedTranscriptionId =
          saveResult && typeof saveResult === "object"
            ? (saveResult as { id?: number; transcription?: { id?: number } }).id ||
              (saveResult as { id?: number; transcription?: { id?: number } }).transcription?.id ||
              null
            : null;

        if (saveFailed) {
          toast({ title, description, variant: "destructive" });
        }

        if (
          saveFailed ||
          !saveHistory ||
          localStorage.getItem("fileTranscriptionCompletionAlertEnabled") !== "false"
        ) {
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
  }, [toast, t]);

  useEffect(() => {
    if (!updateStatus.updateDownloaded || isDownloading) {
      if (!updateStatus.updateDownloaded) {
        updateInstallPromptShownRef.current = null;
      }
      return;
    }

    if (confirmDialog.open) {
      return;
    }

    const promptKey = updateInfo?.version || "downloaded";
    if (updateInstallPromptShownRef.current === promptKey) {
      return;
    }

    updateInstallPromptShownRef.current = promptKey;
    const updateDescription = buildLocalizedUpdateDescription({
      t,
      language: i18n.resolvedLanguage || i18n.language,
      version: updateInfo?.version,
      releaseNotes: updateInfo?.releaseNotes,
    });
    showConfirmDialog({
      title: t("controlPanel.update.readyTitle"),
      description: updateDescription || t("controlPanel.update.readyDescription"),
      confirmText: t("settingsPage.general.updates.installAndRestart"),
      cancelText: t("common.cancel"),
      onConfirm: async () => {
        try {
          await installUpdate();
        } catch {
          toast({
            title: t("controlPanel.update.couldNotInstallTitle"),
            description: t("controlPanel.update.couldNotInstallDescription"),
            variant: "destructive",
          });
        }
      },
    });
  }, [
    updateStatus.updateDownloaded,
    updateInfo?.version,
    updateInfo?.releaseNotes,
    isDownloading,
    confirmDialog.open,
    i18n.language,
    i18n.resolvedLanguage,
    installUpdate,
    showConfirmDialog,
    toast,
    t,
  ]);

  useEffect(() => {
    if (updateError) {
      toast({
        title: t("controlPanel.update.problemTitle"),
        description: t("controlPanel.update.problemDescription"),
        variant: "destructive",
      });
    }
  }, [updateError, toast, t]);

  const loadTranscriptions = useCallback(async () => {
    try {
      setIsLoading(true);
      await initializeTranscriptions();
    } catch (error) {
      showAlertDialog({
        title: t("controlPanel.history.couldNotLoadTitle"),
        description: t("controlPanel.history.couldNotLoadDescription"),
      });
    } finally {
      setIsLoading(false);
    }
  }, [showAlertDialog, t]);

  useEffect(() => {
    void loadTranscriptions();
  }, [loadTranscriptions]);

  useEffect(() => {
    setSelectedHistoryIds((current) => {
      if (current.size === 0) return current;

      const liveIds = new Set(historySelectionScope.map((item) => item.id));
      const next = new Set<number>();
      current.forEach((id) => {
        if (liveIds.has(id)) {
          next.add(id);
        }
      });

      return next.size === current.size ? current : next;
    });
  }, [historySelectionScope]);

  const setHistoryItemSelected = useCallback((id: number, selected: boolean) => {
    setSelectedHistoryIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleVisibleHistorySelection = useCallback(() => {
    setSelectedHistoryIds((current) => {
      const next = new Set(current);
      if (allVisibleHistorySelected) {
        filteredHistoryIds.forEach((id) => next.delete(id));
      } else {
        filteredHistoryIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, [allVisibleHistorySelected, filteredHistoryIds]);

  const clearHistorySelection = useCallback(() => {
    setSelectedHistoryIds(new Set());
  }, []);

  const handleRePolish = useCallback(
    async (item: TranscriptionItemType) => {
      const agentName = localStorage.getItem("agentName") || "";
      try {
        const processedText = await ReasoningService.processText(
          item.text,
          reasoningModel,
          agentName,
          {
            providerOverride: reasoningProvider,
          }
        );

        if (processedText) {
          const saveHistory = localStorage.getItem("transcriptionHistoryEnabled") !== "false";
          let successDescription =
            processedText.slice(0, 60) + (processedText.length > 60 ? "..." : "");

          if (saveHistory) {
            // Re-polish creates a derived record, not a new dictation: it must
            // not inflate the stored word-unit stats or duration totals.
            const saveResult = await window.electronAPI.saveTranscription(processedText, {
              unitCount: 0,
              recordingDurationMs: 0,
              excludeFromStats: true,
            });
            if (!saveResult?.success) {
              throw new Error(t("controlPanel.history.rePolishSaveFailed"));
            }
          } else {
            const copyResult = await window.electronAPI.writeClipboard(processedText);
            if (!copyResult?.success) {
              throw new Error(t("controlPanel.history.couldNotCopyDescription"));
            }
            successDescription = t("controlPanel.history.copiedDescription");
          }

          toast({
            title: t("controlPanel.history.rePolishSuccess"),
            description: successDescription,
            variant: "success",
          });
        }
      } catch (err) {
        console.error("Re-polish failed:", err);
        toast({
          title: t("controlPanel.history.rePolishFailed"),
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
    },
    [reasoningModel, reasoningProvider, toast, t]
  );

  const handleFavoriteChange = useCallback(
    async (item: TranscriptionItemType, favorite: boolean) => {
      try {
        const result = await window.electronAPI?.setTranscriptionFavorite?.(item.id, favorite);
        if (!result?.success) {
          throw new Error(t("controlPanel.history.favoriteUpdateFailedDescription"));
        }
        setFilteredDbHistory((current) =>
          showFavoritesOnly && !favorite
            ? current.filter((entry) => entry.id !== item.id)
            : current.map((entry) =>
                entry.id === item.id ? { ...entry, favorite: favorite ? 1 : 0 } : entry
              )
        );
        if (showFavoritesOnly && !favorite) {
          setFilteredHistoryTotal((current) =>
            current === null ? current : Math.max(0, current - 1)
          );
          setHistoryItemSelected(item.id, false);
        }
        return true;
      } catch (error) {
        toast({
          title: t("controlPanel.history.favoriteUpdateFailedTitle"),
          description:
            error instanceof Error
              ? error.message
              : t("controlPanel.history.favoriteUpdateFailedDescription"),
          variant: "destructive",
        });
        return false;
      }
    },
    [setHistoryItemSelected, showFavoritesOnly, t, toast]
  );

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("controlPanel.history.copiedTitle"),
          description: t("controlPanel.history.copiedDescription"),
          variant: "success",
          duration: 2000,
        });
      } catch (err) {
        toast({
          title: t("controlPanel.history.couldNotCopyTitle"),
          description: t("controlPanel.history.couldNotCopyDescription"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const openExportFolder = useCallback(
    async (filePath?: string | null) => {
      if (!filePath || !window.electronAPI?.showItemInFolder) {
        return;
      }

      const result = await window.electronAPI.showItemInFolder(filePath);
      if (!result?.success) {
        toast({
          title: t("controlPanel.history.openExportFolderFailedTitle"),
          description: result?.error || t("controlPanel.history.openExportFolderFailedDescription"),
          variant: "destructive",
        });
      }
    },
    [t, toast]
  );

  const exportHistory = useCallback(
    async (format: TranscriptionExportFormat) => {
      const expectedCount =
        selectedHistoryCount > 0
          ? selectedHistoryCount
          : hasActiveHistoryFilters
            ? (filteredHistoryTotal ?? filteredHistory.length)
            : historyMeta.totalCount;
      if (expectedCount === 0) {
        toast({
          title: t("controlPanel.history.exportEmptyTitle"),
          description: t("controlPanel.history.exportEmptyDescription"),
          variant: "default",
        });
        return;
      }

      const exportFn = window.electronAPI?.exportTranscriptionHistory;
      if (!exportFn) {
        toast({
          title: t("controlPanel.history.exportFailedTitle"),
          description: t("controlPanel.history.exportFailedDescription"),
          variant: "destructive",
        });
        return;
      }

      try {
        const result = await exportFn(
          selectedHistoryCount > 0
            ? { format, scope: "items", items: selectedHistoryItems }
            : hasActiveHistoryFilters
              ? { format, scope: "query", query: historyFilterOptions }
              : { format, scope: "all" }
        );
        if (!result?.success) {
          toast({
            title: t("controlPanel.history.exportFailedTitle"),
            description: result?.error || t("controlPanel.history.exportFailedDescription"),
            variant: "destructive",
          });
          return;
        }
        if (result.cancelled) {
          return;
        }
        toast({
          title: t("controlPanel.history.exportedTitle"),
          description: t("controlPanel.history.exportedDescription", {
            count: result.count ?? expectedCount,
            path: result.filePath ?? "",
          }),
          action: result.filePath ? (
            <button
              type="button"
              onClick={() => {
                void openExportFolder(result.filePath);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-white/12 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/90 transition-colors hover:bg-white/16 hover:text-white"
            >
              <FolderOpen className="size-3" />
              {t("controlPanel.history.openExportFolder")}
            </button>
          ) : undefined,
          variant: "success",
          duration: 7000,
        });
      } catch (error) {
        toast({
          title: t("controlPanel.history.exportFailedTitle"),
          description:
            error instanceof Error
              ? error.message
              : t("controlPanel.history.exportFailedDescription"),
          variant: "destructive",
        });
      }
    },
    [
      filteredHistory,
      filteredHistoryTotal,
      hasActiveHistoryFilters,
      historyFilterOptions,
      historyMeta.totalCount,
      selectedHistoryCount,
      selectedHistoryItems,
      openExportFolder,
      toast,
      t,
    ]
  );

  const clearHistory = useCallback(async () => {
    showConfirmDialog({
      title: t("controlPanel.history.clearTitle"),
      description: t("controlPanel.history.clearDescription"),
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.clearTranscriptions();
          clearStoreTranscriptions();
          historyFilterSeqRef.current += 1;
          setFilteredDbHistory([]);
          setFilteredHistoryHasMore(false);
          setFilteredHistoryTotal(0);
          setHistoryFilterError(null);
          setIsFilteringHistory(false);
          clearHistorySelection();
          toast({
            title: t("controlPanel.history.clearedTitle"),
            description: t("controlPanel.history.clearedDescription", {
              count: result.cleared,
            }),
            variant: "success",
            duration: 3000,
          });
        } catch (error) {
          toast({
            title: t("controlPanel.history.couldNotClearTitle"),
            description: t("controlPanel.history.couldNotClearDescription"),
            variant: "destructive",
          });
        }
      },
      variant: "destructive",
    });
  }, [clearHistorySelection, showConfirmDialog, toast, t]);

  const checkProAccess = useCallback(async (): Promise<ProAccessResult> => {
    if (!window.electronAPI) {
      return { allowed: true, declinedTrial: false, status: null };
    }

    let currentStatus: LicenseStatusResult | null = null;

    if (window.electronAPI.licenseGetStatus) {
      try {
        currentStatus = await window.electronAPI.licenseGetStatus({ allowKeychain: false });
      } catch (_error) {
        currentStatus = null;
      }
    }

    if (currentStatus?.isActive) {
      return { allowed: true, declinedTrial: false, status: currentStatus };
    }

    try {
      const status = window.electronAPI.licenseEnsureProAccess
        ? await window.electronAPI.licenseEnsureProAccess()
        : currentStatus;
      return {
        allowed: Boolean(status?.isActive),
        declinedTrial: false,
        status: status || currentStatus,
      };
    } catch (_error) {
      return { allowed: false, declinedTrial: false, status: currentStatus };
    }
  }, []);

  const showFileTranscriptionRequiresPro = useCallback(() => {
    showConfirmDialog({
      title: t("controlPanel.history.fileTranscriptionRequiresProTitle"),
      description: t("controlPanel.history.fileTranscriptionRequiresProDescription"),
      confirmText: t("settingsModal.sections.account.label"),
      cancelText: t("common.cancel"),
      onConfirm: () => {
        setSettingsSection("account");
        setShowSettings(true);
      },
    });
  }, [showConfirmDialog, t]);

  const requestFileTranscription = useCallback(async () => {
    if (isFileTranscribing) {
      return;
    }

    const { allowed, declinedTrial } = await checkProAccess();
    if (!allowed) {
      if (declinedTrial) {
        return;
      }
      showFileTranscriptionRequiresPro();
      return;
    }

    fileInputRef.current?.click();
  }, [checkProAccess, isFileTranscribing, showFileTranscriptionRequiresPro]);

  const cancelFileTranscription = useCallback(() => {
    const cancelled = fileAudioManagerRef.current?.cancelProcessing?.();
    if (!cancelled) {
      return;
    }

    activeFileNameRef.current = "";
    setActiveFileName("");
    setIsFileTranscribing(false);
    setFileTranscriptionProgress(0);
    toast({
      title: t("controlPanel.history.fileTranscriptionCancelledTitle"),
      description: t("controlPanel.history.fileTranscriptionCancelledDescription"),
      variant: "default",
    });
  }, [t, toast]);

  const handleFileInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) {
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
      setIsFileTranscribing(true);

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
        setIsFileTranscribing(false);
        setFileTranscriptionProgress(0);
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

  const deleteTranscription = useCallback(
    async (id: number) => {
      showConfirmDialog({
        title: t("controlPanel.history.deleteTitle"),
        description: t("controlPanel.history.deleteDescription"),
        onConfirm: async () => {
          try {
            const result = await window.electronAPI.deleteTranscription(id);
            if (result.success) {
              removeFromStore(id);
              setFilteredDbHistory((current) => current.filter((item) => item.id !== id));
              setFilteredHistoryTotal((current) =>
                current === null ? current : Math.max(0, current - 1)
              );
              setHistoryItemSelected(id, false);
            } else {
              showAlertDialog({
                title: t("controlPanel.history.couldNotDeleteTitle"),
                description: t("controlPanel.history.couldNotDeleteDescription"),
              });
            }
          } catch (error) {
            showAlertDialog({
              title: t("controlPanel.history.couldNotDeleteTitle"),
              description: t("controlPanel.history.couldNotDeleteDescriptionGeneric"),
            });
          }
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, showAlertDialog, setHistoryItemSelected, t]
  );

  const handleUpdateClick = async () => {
    if (updateStatus.updateDownloaded) {
      showConfirmDialog({
        title: t("controlPanel.update.installTitle"),
        description: t("controlPanel.update.installDescription"),
        onConfirm: async () => {
          try {
            await installUpdate();
          } catch (error) {
            toast({
              title: t("controlPanel.update.couldNotInstallTitle"),
              description: t("controlPanel.update.couldNotInstallDescription"),
              variant: "destructive",
            });
          }
        },
      });
    } else if (updateStatus.updateAvailable && !isDownloading) {
      try {
        await downloadUpdate();
      } catch (error) {
        toast({
          title: t("controlPanel.update.couldNotDownloadTitle"),
          description: t("controlPanel.update.couldNotDownloadDescription"),
          variant: "destructive",
        });
      }
    }
  };

  const handleOpenHistoryFromPrivacy = useCallback(() => {
    setShowSettings(false);
    setSettingsSection(undefined);
  }, []);

  const handleBackToHome = useCallback(() => {
    setSettingsSection(undefined);
    setShowSettings(true);
  }, []);

  const getUpdateButtonContent = () => {
    if (isInstalling) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{t("controlPanel.update.installing")}</span>
        </>
      );
    }
    if (isDownloading) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{Math.round(downloadProgress)}%</span>
        </>
      );
    }
    if (updateStatus.updateDownloaded) {
      return (
        <>
          <RefreshCw size={14} />
          <span>{t("controlPanel.update.installButton")}</span>
        </>
      );
    }
    if (updateStatus.updateAvailable) {
      return (
        <>
          <Download size={14} />
          <span>{t("controlPanel.update.availableButton")}</span>
        </>
      );
    }
    return null;
  };

  const hotkeyLabel = formatHotkeyLabel(hotkey);
  return (
    <div className="app-glass-shell min-h-screen">
      <LiquidGlassFilters />
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
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
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <TitleBar
        dragOnly={showSettings}
        actions={
          <>
            {!updateStatus.isDevelopment &&
              (updateStatus.updateAvailable ||
                updateStatus.updateDownloaded ||
                isDownloading ||
                isInstalling) && (
                <Button
                  variant={updateStatus.updateDownloaded ? "default" : "outline"}
                  size="sm"
                  onClick={handleUpdateClick}
                  disabled={isInstalling || isDownloading}
                  className="gap-1.5 text-xs"
                >
                  {getUpdateButtonContent()}
                </Button>
              )}
            <SupportDropdown />
            <Button
              variant="ghost"
              size="icon"
              onClick={handleBackToHome}
              className="text-foreground/70 hover:text-foreground hover:bg-foreground/10"
              title={t("controlPanel.history.backToHome")}
              aria-label={t("controlPanel.history.backToHome")}
            >
              <Settings size={16} />
            </Button>
          </>
        }
      />

      {showSettings && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-background" />}>
          <SettingsModal
            open={showSettings}
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
            onOpenTranscriptionHistory={handleOpenHistoryFromPrivacy}
          />
        </Suspense>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={SUPPORTED_MEDIA_ACCEPT}
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Fully unmount the history paint tree behind the translucent settings sheet.
          display:none/visibility:hidden can leave a stale native-glass compositor frame. */}
      {!showSettings && (
        <div data-testid="transcription-history-root" className="px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
          <div className="mx-auto max-w-5xl">
            <div
              className={`transition-opacity duration-150 ${
                hideHistoryDuringHomeHandoff ? "pointer-events-none opacity-0" : "opacity-100"
              }`}
              aria-hidden={hideHistoryDuringHomeHandoff}
            >
              <section className="premium-panel premium-panel--subtle overflow-hidden">
                <div className="glass-panel glass-panel--chrome border-x-0 border-t-0 rounded-none px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <FileText size={17} className="shrink-0 text-primary" />
                      <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-foreground">
                        {t("controlPanel.history.title")}
                      </h2>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        ({visibleHistoryCountLabel})
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <Button
                        onClick={requestFileTranscription}
                        variant="outline"
                        size="sm"
                        disabled={isFileTranscribing}
                        className="h-8 gap-1.5 px-2.5 text-[11px]"
                        title={activeFileName || t("controlPanel.history.transcribeFile")}
                      >
                        {isFileTranscribing ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Upload size={12} />
                        )}
                        <span>
                          {isFileTranscribing
                            ? t("controlPanel.history.transcribeFileProgress", {
                                progress: Math.max(1, Math.round(fileTranscriptionProgress)),
                              })
                            : t("controlPanel.history.transcribeFile")}
                        </span>
                        {!isFileTranscribing ? (
                          <span className="glass-chip glass-chip--accent rounded-full px-1.5 py-0.5 text-[9px] font-medium text-primary">
                            {t("settingsPage.account.badges.pro")}
                          </span>
                        ) : null}
                      </Button>
                      {isFileTranscribing ? (
                        <Button
                          type="button"
                          onClick={cancelFileTranscription}
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          title={t("controlPanel.history.cancelFileTranscription")}
                          aria-label={t("controlPanel.history.cancelFileTranscription")}
                        >
                          <X size={13} />
                        </Button>
                      ) : null}
                      <span className="glass-chip glass-chip--muted rounded-full px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
                        {hotkeyLabel}
                      </span>
                      {historyMeta.totalCount > 0 ? (
                        <>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-[11px] text-muted-foreground hover:bg-primary/10 hover:text-primary"
                                aria-label={
                                  selectedHistoryCount > 0
                                    ? t("controlPanel.history.exportSelectedTooltip", {
                                        count: selectedHistoryCount,
                                      })
                                    : t("controlPanel.history.exportTooltip")
                                }
                              >
                                <Download size={12} className="mr-1" />
                                {selectedHistoryCount > 0
                                  ? t("controlPanel.history.exportSelected")
                                  : t("controlPanel.history.export")}
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-[180px]">
                              {(["txt", "md", "csv", "json"] as TranscriptionExportFormat[]).map(
                                (format) => (
                                  <DropdownMenuItem
                                    key={format}
                                    onSelect={() => {
                                      void exportHistory(format);
                                    }}
                                  >
                                    {t(`controlPanel.history.exportFormat.${format}`)}
                                  </DropdownMenuItem>
                                )
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <Button
                            onClick={clearHistory}
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 size={12} className="mr-1" />
                            {t("controlPanel.history.clear")}
                          </Button>
                        </>
                      ) : null}
                      <Button
                        onClick={handleBackToHome}
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        title={t("controlPanel.history.backToHomeHint")}
                        aria-label={t("controlPanel.history.backToHome")}
                      >
                        <ChevronLeft size={12} />
                        {t("controlPanel.history.backToHome")}
                      </Button>
                    </div>
                  </div>
                  {isFileTranscribing ? (
                    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/30 dark:bg-white/10">
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-200"
                        style={{
                          width: `${Math.max(0, Math.min(100, fileTranscriptionProgress))}%`,
                        }}
                      />
                    </div>
                  ) : null}
                </div>

                {historyMeta.totalCount > 0 ? (
                  <div className="border-b border-border/40 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative min-w-[180px] flex-1">
                        <Search
                          size={12}
                          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/70"
                        />
                        <input
                          type="search"
                          value={historySearch}
                          onChange={(e) => setHistorySearch(e.target.value)}
                          placeholder={t("controlPanel.history.searchPlaceholder")}
                          aria-label={t("controlPanel.history.searchAriaLabel")}
                          className="h-8 w-full rounded-md border border-border/50 bg-background/60 pl-7 pr-2 text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      </div>
                      <select
                        value={historyTimeFilter}
                        onChange={(e) =>
                          setHistoryTimeFilter(e.target.value as "all" | "today" | "week" | "month")
                        }
                        aria-label={t("controlPanel.history.timeFilter.label")}
                        className="h-8 rounded-md border border-border/50 bg-background/60 px-2 text-[12px] text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                      >
                        <option value="all">{t("controlPanel.history.timeFilter.all")}</option>
                        <option value="today">{t("controlPanel.history.timeFilter.today")}</option>
                        <option value="week">{t("controlPanel.history.timeFilter.week")}</option>
                        <option value="month">{t("controlPanel.history.timeFilter.month")}</option>
                      </select>
                      <Button
                        type="button"
                        variant={showFavoritesOnly ? "tinted" : "outline"}
                        size="sm"
                        onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                        className={cn(
                          "h-8 px-2 text-[11px]",
                          showFavoritesOnly &&
                            "text-yellow-500 hover:text-yellow-600 hover:bg-yellow-500/10"
                        )}
                      >
                        <Star
                          size={12}
                          fill={showFavoritesOnly ? "currentColor" : "none"}
                          className="mr-1"
                        />
                        {showFavoritesOnly
                          ? t("controlPanel.history.starredOnly")
                          : t("controlPanel.history.allStarred")}
                      </Button>
                      {filteredHistory.length > 0 ? (
                        <Button
                          type="button"
                          variant={allVisibleHistorySelected ? "tinted" : "outline"}
                          size="sm"
                          onClick={toggleVisibleHistorySelection}
                          className="h-8 px-2 text-[11px]"
                        >
                          {allVisibleHistorySelected
                            ? t("controlPanel.history.deselectAllVisible")
                            : t("controlPanel.history.selectAllVisible")}
                        </Button>
                      ) : null}
                      {selectedHistoryCount > 0 ? (
                        <div className="flex items-center gap-2">
                          <span className="glass-chip glass-chip--accent rounded-full px-2.5 py-1 text-[10px] font-medium text-primary">
                            {t("controlPanel.history.selectedCount", {
                              count: selectedHistoryCount,
                            })}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={clearHistorySelection}
                            className="h-8 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            <X size={12} className="mr-1" />
                            {t("controlPanel.history.clearSelection")}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {isLoading || (isFilteringHistory && filteredHistory.length === 0) ? (
                  <div className="flex items-center justify-center gap-2 py-12">
                    <Loader2 size={14} className="animate-spin text-primary" />
                    <span className="text-sm text-muted-foreground">
                      {t("controlPanel.loading")}
                    </span>
                  </div>
                ) : historyMeta.totalCount === 0 ? (
                  <div className="flex min-h-[360px] flex-col items-center justify-center px-6 py-16 text-center">
                    <div className="glass-panel glass-panel--accent mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
                      <Mic size={20} className="text-primary" />
                    </div>
                    <p className="mb-2 text-[18px] font-semibold text-foreground/90">
                      {t("controlPanel.history.empty")}
                    </p>
                    <div className="glass-chip glass-chip--muted flex flex-wrap items-center justify-center gap-2 rounded-full px-3 py-1.5 text-[11px] text-muted-foreground">
                      <span>{t("controlPanel.history.press")}</span>
                      <kbd className="glass-panel glass-panel--soft inline-flex h-6 items-center rounded-md px-2 text-[11px] font-mono font-semibold text-foreground/80">
                        {hotkeyLabel}
                      </kbd>
                      <span>{t("controlPanel.history.toStart")}</span>
                    </div>
                  </div>
                ) : historyFilterError ? (
                  <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                    <p className="text-[13px] font-medium text-destructive">
                      {t("controlPanel.history.couldNotLoadTitle")}
                    </p>
                    <p className="max-w-md text-[12px] text-muted-foreground">
                      {historyFilterError}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void fetchFilteredHistory(historyFilterOptions)}
                    >
                      <RefreshCw size={12} className="mr-1" />
                      {t("controlPanel.history.retry")}
                    </Button>
                  </div>
                ) : filteredHistory.length === 0 ? (
                  <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 px-6 py-16 text-center animate-in fade-in duration-200">
                    <div className="glass-chip glass-chip--muted flex h-12 w-12 items-center justify-center rounded-full">
                      <Search size={18} className="text-muted-foreground/60" />
                    </div>
                    <p className="text-[13px] font-medium text-foreground/80">
                      {t("controlPanel.history.noResults")}
                    </p>
                    {hasActiveHistoryFilters && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setHistorySearch("");
                          setHistoryTimeFilter("all");
                          setShowFavoritesOnly(false);
                        }}
                        className="text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <X size={12} className="mr-1" />
                        {t("controlPanel.history.clearFilters")}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="max-h-[calc(100vh-176px)] overflow-y-auto divide-y divide-border/50">
                    {renderedHistory.map((item, index) => (
                      <TranscriptionItem
                        key={item.id}
                        item={item}
                        index={index}
                        total={filteredHistory.length}
                        isSelected={selectedHistoryIds.has(item.id)}
                        onCopy={copyToClipboard}
                        onDelete={deleteTranscription}
                        onSelectChange={setHistoryItemSelected}
                        onPolish={handleRePolish}
                        onFavoriteChange={handleFavoriteChange}
                        data-stagger={Math.min(index + 1, 8)}
                      />
                    ))}
                    {visibleHistoryHasMore ? (
                      <div className="flex justify-center px-4 py-4">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isLoadingMoreHistory}
                          onClick={() => void loadMoreVisibleHistory()}
                          className="min-w-32 gap-1.5"
                        >
                          {isLoadingMoreHistory ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : null}
                          {t("controlPanel.history.loadMore")}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
