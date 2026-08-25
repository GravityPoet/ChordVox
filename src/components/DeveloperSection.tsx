import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { FolderOpen, Copy, Check } from "lucide-react";
import { useToast } from "./ui/toastContext";
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

  const loggedItems = [
    t("developerSection.whatGetsLogged.items.apiRequests"),
    t("developerSection.whatGetsLogged.items.systemDiagnostics"),
    t("developerSection.whatGetsLogged.items.transcriptionPipeline"),
    t("developerSection.whatGetsLogged.items.errorDetails"),
  ];

  return (
    <div className="space-y-4">
      <div className="premium-panel premium-panel--subtle divide-y divide-[color:var(--ui-glass-divider)] rounded-xl">
        <div className="px-5 py-3.5">
          <div className="flex items-start justify-between gap-3">
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
              <div className="mt-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
                  {t("developerSection.whatGetsLogged.title")}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {loggedItems.map((item) => (
                    <div
                      key={item}
                      className="glass-chip glass-chip--muted inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground"
                    >
                      <div className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/35" />
                      <span className="truncate">{item}</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
                {t("developerSection.localOnlyNotice")}
              </p>
            </div>
            <div className="shrink-0 pt-0">
              <Toggle
                checked={debugEnabled}
                onChange={handleToggleDebug}
                ariaLabel={t("developerSection.debugMode.label")}
                disabled={isLoading || isToggling}
              />
            </div>
          </div>
        </div>

        {debugEnabled && (
          <div className="px-5 py-3.5">
            <div
              className={`flex flex-wrap items-center gap-2 ${logPath ? "justify-between" : "justify-end"}`}
            >
              {logPath ? (
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  {t("developerSection.currentLogFile")}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button onClick={handleOpenLogsFolder} variant="outline" size="sm">
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t("developerSection.openLogsFolder")}
                </Button>
                <Button
                  onClick={handleCopyPath}
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0"
                  aria-label={`${t("common.copy")}: ${t("developerSection.currentLogFile")}`}
                  title={`${t("common.copy")}: ${t("developerSection.currentLogFile")}`}
                  disabled={!logPath}
                >
                  {copiedPath ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </Button>
              </div>
            </div>
            {logPath ? (
              <code className="glass-panel glass-panel--soft mt-1.5 block overflow-x-auto rounded-lg px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-nowrap">
                {logPath}
              </code>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
