import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { FolderOpen, Copy, Check } from "lucide-react";
import { useToast } from "./ui/Toast";
import { Toggle } from "./ui/toggle";

export default function DeveloperSection() {
  const { t } = useTranslation();
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isToggling, setIsToggling] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const { toast } = useToast();

  const loadDebugState = useCallback(async () => {
    try {
      setIsLoading(true);
      const state = await window.electronAPI.getDebugState();
      setDebugEnabled(state.enabled);
      setLogPath(state.logPath);
    } catch (error) {
      console.error("Failed to load debug state:", error);
      toast({
        title: t("developerSection.toasts.loadFailed.title"),
        description: t("developerSection.toasts.loadFailed.description"),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void loadDebugState();
  }, [loadDebugState]);

  const handleToggleDebug = async () => {
    if (isToggling) return;

    try {
      setIsToggling(true);
      const newState = !debugEnabled;
      const result = await window.electronAPI.setDebugLogging(newState);

      if (!result.success) {
        throw new Error(result.error || "Failed to update debug logging");
      }

      setDebugEnabled(newState);
      await loadDebugState();

      toast({
        title: newState
          ? t("developerSection.toasts.debugEnabled.title")
          : t("developerSection.toasts.debugDisabled.title"),
        description: newState
          ? t("developerSection.toasts.debugEnabled.description")
          : t("developerSection.toasts.debugDisabled.description"),
        variant: "success",
      });
    } catch (error) {
      toast({
        title: t("developerSection.toasts.updateFailed.title"),
        description: t("developerSection.toasts.updateFailed.description"),
        variant: "destructive",
      });
    } finally {
      setIsToggling(false);
    }
  };

  const handleOpenLogsFolder = async () => {
    try {
      const result = await window.electronAPI.openLogsFolder();
      if (!result.success) {
        throw new Error(result.error || "Failed to open folder");
      }
    } catch (error) {
      toast({
        title: t("developerSection.toasts.openLogsFailed.title"),
        description: t("developerSection.toasts.openLogsFailed.description"),
        variant: "destructive",
      });
    }
  };

  const handleCopyPath = async () => {
    if (!logPath) return;

    try {
      await navigator.clipboard.writeText(logPath);
      setCopiedPath(true);
      toast({
        title: t("developerSection.toasts.copied.title"),
        description: t("developerSection.toasts.copied.description"),
        variant: "success",
        duration: 2000,
      });
      setTimeout(() => setCopiedPath(false), 2000);
    } catch (error) {
      toast({
        title: t("developerSection.toasts.copyFailed.title"),
        description: t("developerSection.toasts.copyFailed.description"),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border/60 bg-card divide-y divide-border/40 dark:border-border-subtle dark:bg-surface-2 dark:divide-border-subtle">
        <div className="px-5 py-4">
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-medium text-foreground">
                  {t("developerSection.debugMode.label")}
                </p>
                <div
                  className={`h-1.5 w-1.5 rounded-full transition-colors ${
                    debugEnabled ? "bg-success" : "bg-muted-foreground/30"
                  }`}
                />
              </div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                {t("developerSection.debugMode.description")}
              </p>
              <div className="mt-3 rounded-lg border border-border/40 bg-muted/10 px-3 py-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
                  {t("developerSection.whatGetsLogged.title")}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2">
                  {[
                    t("developerSection.whatGetsLogged.items.audioProcessing"),
                    t("developerSection.whatGetsLogged.items.apiRequests"),
                    t("developerSection.whatGetsLogged.items.ffmpegOperations"),
                    t("developerSection.whatGetsLogged.items.systemDiagnostics"),
                    t("developerSection.whatGetsLogged.items.transcriptionPipeline"),
                    t("developerSection.whatGetsLogged.items.errorDetails"),
                  ].map((item) => (
                    <div key={item} className="flex items-center gap-2">
                      <div className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/30" />
                      <span className="text-[12px] text-muted-foreground">{item}</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
                {t("developerSection.localOnlyNotice")}
              </p>
            </div>
            <div className="shrink-0">
              <Toggle
                checked={debugEnabled}
                onChange={handleToggleDebug}
                disabled={isLoading || isToggling}
              />
            </div>
          </div>
        </div>

        {debugEnabled && logPath && (
          <div className="px-5 py-4">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {t("developerSection.currentLogFile")}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded-lg border border-border/30 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground dark:bg-surface-raised/30">
                {logPath}
              </code>
              <Button
                onClick={handleCopyPath}
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
              >
                {copiedPath ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>
        )}

        {debugEnabled && (
          <div className="px-5 py-4">
            <Button onClick={handleOpenLogsFolder} variant="outline" size="sm" className="w-full">
              <FolderOpen className="mr-2 h-3.5 w-3.5" />
              {t("developerSection.openLogsFolder")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
