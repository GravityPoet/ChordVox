import React, { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import {
  Trash2,
  Settings,
  FileText,
  Mic,
  Download,
  Upload,
  RefreshCw,
  Loader2,
  Sparkles,
  Cloud,
  X,
  AlertTriangle,
} from "lucide-react";
import type { SettingsSectionType } from "./SettingsModal";
import TitleBar from "./TitleBar";
import SupportDropdown from "./ui/SupportDropdown";
import TranscriptionItem from "./ui/TranscriptionItem";
import UpgradePrompt from "./UpgradePrompt";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/Toast";
import { useUpdater } from "../hooks/useUpdater";
import { useSettings } from "../hooks/useSettings";
import { useAuth } from "../hooks/useAuth";
import { useUsage } from "../hooks/useUsage";
import type { LicenseStatusResult } from "../types/electron";
import AudioManager from "../helpers/audioManager";
import {
  useTranscriptions,
  initializeTranscriptions,
  removeTranscription as removeFromStore,
  clearTranscriptions as clearStoreTranscriptions,
} from "../stores/transcriptionStore";
import { formatHotkeyLabel } from "../utils/hotkeys";
import { canStartProTrial } from "../utils/proTrial";
import { CHORDVOX_CLOUD_MODE } from "../utils/chordvoxCloud";

const SettingsModal = React.lazy(() => import("./SettingsModal"));

type ProAccessResult = {
  allowed: boolean;
  declinedTrial: boolean;
  status: LicenseStatusResult | null;
};

export default function ControlPanel() {
  const { t } = useTranslation();
  const history = useTranscriptions();
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(true);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [limitData, setLimitData] = useState<{ wordsUsed: number; limit: number } | null>(null);
  const hasShownUpgradePrompt = useRef(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionType | undefined>("account");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileAudioManagerRef = useRef<any>(null);
  const activeFileNameRef = useRef("");
  const [aiCTADismissed, setAiCTADismissed] = useState(
    () => localStorage.getItem("aiCTADismissed") === "true"
  );
  const [showCloudMigrationBanner, setShowCloudMigrationBanner] = useState(false);
  const [isFileTranscribing, setIsFileTranscribing] = useState(false);
  const [activeFileName, setActiveFileName] = useState("");
  const [fileTranscriptionProgress, setFileTranscriptionProgress] = useState(0);
  const cloudMigrationProcessed = useRef(false);
  const { hotkey } = useHotkey();
  const { toast } = useToast();
  const { useReasoningModel, setUseLocalWhisper, setCloudTranscriptionMode } = useSettings();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const usage = useUsage();

  const {
    status: updateStatus,
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
    loadTranscriptions();
  }, []);

  useEffect(() => {
    const audioManager = new AudioManager();
    fileAudioManagerRef.current = audioManager;

    audioManager.setCallbacks({
      onStateChange: ({ isProcessing }) => {
        const nextProcessing = Boolean(isProcessing);
        setIsFileTranscribing(nextProcessing);
        if (!nextProcessing) {
          activeFileNameRef.current = "";
          setActiveFileName("");
          setFileTranscriptionProgress(0);
        }
      },
      onProgress: ({ progress }) => {
        setFileTranscriptionProgress(Math.max(0, Math.min(100, Math.round(progress || 0))));
      },
      onPartialTranscript: () => {},
      onAudioLevel: () => {},
      onError: (error) => {
        setFileTranscriptionProgress(0);
        const isLicenseRequired = error?.code === "LICENSE_REQUIRED";
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
          title: t("controlPanel.history.couldNotTranscribeFileTitle"),
          description:
            error?.description ||
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
  }, [toast, t]);

  useEffect(() => {
    if (updateStatus.updateDownloaded && !isDownloading) {
      toast({
        title: t("controlPanel.update.readyTitle"),
        description: t("controlPanel.update.readyDescription"),
        variant: "success",
      });
    }
  }, [updateStatus.updateDownloaded, isDownloading, toast, t]);

  useEffect(() => {
    if (updateError) {
      toast({
        title: t("controlPanel.update.problemTitle"),
        description: t("controlPanel.update.problemDescription"),
        variant: "destructive",
      });
    }
  }, [updateError, toast, t]);

  useEffect(() => {
    const dispose = window.electronAPI?.onLimitReached?.(
      (data: { wordsUsed: number; limit: number }) => {
        if (!hasShownUpgradePrompt.current) {
          hasShownUpgradePrompt.current = true;
          setLimitData(data);
          setShowUpgradePrompt(true);
        } else {
          toast({
            title: t("controlPanel.limit.weeklyTitle"),
            description: t("controlPanel.limit.weeklyDescription"),
            duration: 5000,
          });
        }
      }
    );

    return () => {
      dispose?.();
    };
  }, [toast, t]);

  useEffect(() => {
    if (!usage?.isPastDue || !usage.hasLoaded) return;
    if (sessionStorage.getItem("pastDueNotified")) return;
    sessionStorage.setItem("pastDueNotified", "true");
    toast({
      title: t("controlPanel.billing.pastDueTitle"),
      description: t("controlPanel.billing.pastDueDescription"),
      variant: "destructive",
      duration: 8000,
    });
  }, [usage?.isPastDue, usage?.hasLoaded, toast, t]);

  useEffect(() => {
    if (!authLoaded || !isSignedIn || cloudMigrationProcessed.current) return;
    const isPending = localStorage.getItem("pendingCloudMigration") === "true";
    const alreadyShown = localStorage.getItem("cloudMigrationShown") === "true";
    if (!isPending || alreadyShown) return;

    cloudMigrationProcessed.current = true;
    setUseLocalWhisper(false);
    setCloudTranscriptionMode(CHORDVOX_CLOUD_MODE);
    localStorage.removeItem("pendingCloudMigration");
    setShowCloudMigrationBanner(true);
  }, [authLoaded, isSignedIn, setUseLocalWhisper, setCloudTranscriptionMode]);

  const loadTranscriptions = async () => {
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
  };

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

  const clearHistory = useCallback(async () => {
    showConfirmDialog({
      title: t("controlPanel.history.clearTitle"),
      description: t("controlPanel.history.clearDescription"),
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.clearTranscriptions();
          clearStoreTranscriptions();
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
  }, [showConfirmDialog, toast, t]);

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

  const checkProAccess = useCallback(async (): Promise<ProAccessResult> => {
    if (!window.electronAPI) {
      return { allowed: true, declinedTrial: false, status: null };
    }

    let currentStatus: LicenseStatusResult | null = null;

    if (window.electronAPI.licenseGetStatus) {
      try {
        currentStatus = await window.electronAPI.licenseGetStatus();
      } catch (_error) {
        currentStatus = null;
      }
    }

    if (currentStatus?.isActive) {
      return { allowed: true, declinedTrial: false, status: currentStatus };
    }

    if (canStartProTrial(currentStatus)) {
      const confirmed = await promptToStartProTrial();
      if (!confirmed) {
        return { allowed: false, declinedTrial: true, status: currentStatus };
      }
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
  }, [promptToStartProTrial]);

  const showFileTranscriptionRequiresPro = useCallback(() => {
    setSettingsSection("account");
    setShowSettings(true);
    toast({
      title: t("controlPanel.history.fileTranscriptionRequiresProTitle"),
      description: t("controlPanel.history.fileTranscriptionRequiresProDescription"),
      variant: "destructive",
    });
  }, [toast, t]);

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

  const handleFileInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) {
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

      try {
        await fileAudioManagerRef.current.transcribeFile(file, {
          sourceType: "file",
          sourceFileName: file.name,
          mimeType: file.type || null,
        });
      } catch (error: any) {
        activeFileNameRef.current = "";
        setActiveFileName("");
        setIsFileTranscribing(false);
        setFileTranscriptionProgress(0);
        toast({
          title: t("controlPanel.history.couldNotTranscribeFileTitle"),
          description:
            error?.message || t("controlPanel.history.couldNotTranscribeFileDescription"),
          variant: "destructive",
        });
      }
    },
    [checkProAccess, showFileTranscriptionRequiresPro, t, toast]
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
    [showConfirmDialog, showAlertDialog, t]
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

  return (
    <div className="min-h-screen bg-background">
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

      <UpgradePrompt
        open={showUpgradePrompt}
        onOpenChange={setShowUpgradePrompt}
        wordsUsed={limitData?.wordsUsed}
        limit={limitData?.limit}
      />

      <TitleBar
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
              onClick={() => {
                setSettingsSection(undefined);
                setShowSettings(true);
              }}
              className="text-foreground/70 hover:text-foreground hover:bg-foreground/10"
            >
              <Settings size={16} />
            </Button>
          </>
        }
      />

      {showSettings && (
        <Suspense fallback={null}>
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

      <div className="p-4">
        <div className="max-w-3xl mx-auto">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,video/*,.mp3,.wav,.m4a,.mp4,.mov,.webm,.ogg,.flac,.aac,.mkv,.avi,.m4v"
            className="hidden"
            onChange={handleFileInputChange}
          />

          {usage?.isPastDue && (
            <div className="mb-3 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-3">
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-8 h-8 rounded-md bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
                  <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-amber-900 dark:text-amber-200 mb-0.5">
                    {t("controlPanel.billing.pastDueTitle")}
                  </p>
                  <p className="text-[12px] text-amber-700 dark:text-amber-300/80 mb-2">
                    {t("controlPanel.billing.bannerDescription", {
                      limit: usage.limit.toLocaleString(),
                    })}
                  </p>
                  <Button
                    variant="default"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      setSettingsSection("account");
                      setShowSettings(true);
                    }}
                  >
                    {t("controlPanel.billing.updatePayment")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between mb-3 px-1">
            <div className="flex items-center gap-2">
              <FileText size={14} className="text-primary" />
              <h2 className="text-sm font-semibold text-foreground">
                {t("controlPanel.history.title")}
              </h2>
              {history.length > 0 && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  ({history.length})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={requestFileTranscription}
                variant="outline"
                size="sm"
                disabled={isFileTranscribing}
                className="h-7 px-2 text-[11px] gap-1.5"
                title={activeFileName || undefined}
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
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {t("settingsPage.account.badges.pro")}
                </span>
              </Button>

              {history.length > 0 && (
                <Button
                  onClick={clearHistory}
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 size={12} className="mr-1" />
                  {t("controlPanel.history.clear")}
                </Button>
              )}
            </div>
          </div>

          {showCloudMigrationBanner && (
            <div className="mb-3 relative rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 p-3">
              <button
                onClick={() => {
                  setShowCloudMigrationBanner(false);
                  localStorage.setItem("cloudMigrationShown", "true");
                }}
                className="absolute top-2 right-2 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <X size={14} />
              </button>
              <div className="flex items-start gap-3 pr-6">
                <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center">
                  <Cloud size={16} className="text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-foreground mb-0.5">
                    {t("controlPanel.cloudMigration.title")}
                  </p>
                  <p className="text-[12px] text-muted-foreground mb-2">
                    {t("controlPanel.cloudMigration.description")}
                  </p>
                  <Button
                    variant="default"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      setShowCloudMigrationBanner(false);
                      localStorage.setItem("cloudMigrationShown", "true");
                      setSettingsSection("transcription");
                      setShowSettings(true);
                    }}
                  >
                    {t("controlPanel.cloudMigration.viewSettings")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!useReasoningModel && !aiCTADismissed && (
            <div className="mb-3 relative rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 p-3">
              <button
                onClick={() => {
                  localStorage.setItem("aiCTADismissed", "true");
                  setAiCTADismissed(true);
                }}
                className="absolute top-2 right-2 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <X size={14} />
              </button>
              <div className="flex items-start gap-3 pr-6">
                <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center">
                  <Sparkles size={16} className="text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-foreground mb-0.5">
                    {t("controlPanel.aiCta.title")}
                  </p>
                  <p className="text-[12px] text-muted-foreground mb-2">
                    {t("controlPanel.aiCta.description")}
                  </p>
                  <Button
                    variant="default"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      setSettingsSection("aiModels");
                      setShowSettings(true);
                    }}
                  >
                    {t("controlPanel.aiCta.enable")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/30 backdrop-blur-sm">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 size={14} className="animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">{t("controlPanel.loading")}</span>
              </div>
            ) : history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <div className="w-10 h-10 rounded-md bg-muted/50 dark:bg-white/4 flex items-center justify-center mb-3">
                  <Mic size={18} className="text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground mb-3">
                  {t("controlPanel.history.empty")}
                </p>
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <span>{t("controlPanel.history.press")}</span>
                  <kbd className="inline-flex items-center h-5 px-1.5 rounded-sm bg-surface-1 dark:bg-white/6 border border-border text-[11px] font-mono font-medium">
                    {formatHotkeyLabel(hotkey)}
                  </kbd>
                  <span>{t("controlPanel.history.toStart")}</span>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-border/50 max-h-[calc(100vh-180px)] overflow-y-auto">
                {history.map((item, index) => (
                  <TranscriptionItem
                    key={item.id}
                    item={item}
                    index={index}
                    total={history.length}
                    onCopy={copyToClipboard}
                    onDelete={deleteTranscription}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
