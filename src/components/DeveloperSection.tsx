import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { FolderOpen, Copy, Check, RefreshCw, Trash2 } from "lucide-react";
import { useToast } from "./ui/Toast";
import { Toggle } from "./ui/toggle";
import type { CallTraceEvent, CallTraceSession } from "../types/electron";

export default function DeveloperSection() {
  const { t } = useTranslation();
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isToggling, setIsToggling] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [isClearingTrace, setIsClearingTrace] = useState(false);
  const [traceSessions, setTraceSessions] = useState<CallTraceSession[]>([]);
  const [traceEvents, setTraceEvents] = useState<CallTraceEvent[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    loadDebugState();
    loadTraceSessions();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      loadTraceSessions(true);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedRunId]);

  const loadDebugState = async () => {
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
  };

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

  const loadTraceEvents = async (runId: string, silent = false) => {
    try {
      if (!silent) {
        setIsLoadingTrace(true);
      }
      const result = await window.electronAPI.getCallTraceEvents(runId, 120);
      if (result.success) {
        setTraceEvents(result.events || []);
      }
    } catch (error) {
      if (!silent) {
        toast({
          title: t("developerSection.trace.toasts.loadFailed.title"),
          description: t("developerSection.trace.toasts.loadFailed.description"),
          variant: "destructive",
        });
      }
    } finally {
      if (!silent) {
        setIsLoadingTrace(false);
      }
    }
  };

  const loadTraceSessions = async (silent = false) => {
    try {
      if (!silent) {
        setIsLoadingTrace(true);
      }
      const result = await window.electronAPI.getCallTraceSessions(30);
      if (!result.success) {
        throw new Error(result.error || "Failed to load call trace sessions");
      }

      const sessions = result.sessions || [];
      setTraceSessions(sessions);

      const activeRunId =
        selectedRunId && sessions.find((session) => session.runId === selectedRunId)
          ? selectedRunId
          : sessions[0]?.runId || null;

      setSelectedRunId(activeRunId);
      if (activeRunId) {
        await loadTraceEvents(activeRunId, true);
      } else {
        setTraceEvents([]);
      }
    } catch (error) {
      if (!silent) {
        toast({
          title: t("developerSection.trace.toasts.loadFailed.title"),
          description: t("developerSection.trace.toasts.loadFailed.description"),
          variant: "destructive",
        });
      }
    } finally {
      if (!silent) {
        setIsLoadingTrace(false);
      }
    }
  };

  const handleSelectSession = async (runId: string) => {
    setSelectedRunId(runId);
    await loadTraceEvents(runId);
  };

  const handleClearTrace = async () => {
    try {
      setIsClearingTrace(true);
      const result = await window.electronAPI.clearCallTraces();
      if (!result.success) {
        throw new Error(result.error || "Failed to clear call traces");
      }
      setTraceSessions([]);
      setTraceEvents([]);
      setSelectedRunId(null);
      toast({
        title: t("developerSection.trace.toasts.cleared.title"),
        description: t("developerSection.trace.toasts.cleared.description"),
        variant: "success",
      });
    } catch (error) {
      toast({
        title: t("developerSection.trace.toasts.clearFailed.title"),
        description: t("developerSection.trace.toasts.clearFailed.description"),
        variant: "destructive",
      });
    } finally {
      setIsClearingTrace(false);
    }
  };

  const getStatusChip = (status?: string) => {
    if (status === "success") return "bg-success/15 text-success border-success/30";
    if (status === "error") return "bg-destructive/10 text-destructive border-destructive/30";
    if (status === "start") return "bg-primary/10 text-primary border-primary/30";
    if (status === "cancelled") return "bg-warning/15 text-warning border-warning/30";
    if (status === "skipped") return "bg-muted text-muted-foreground border-border/40";
    return "bg-muted text-muted-foreground border-border/40";
  };

  const getStatusLabel = (status?: string) => {
    const normalized = status || "unknown";
    return t(`developerSection.trace.status.${normalized}`);
  };

  const getPhaseLabel = (phase?: string) => {
    const normalized = phase || "session";
    return t(`developerSection.trace.phases.${normalized}`);
  };

  const formatDateTime = (value: string | null) => {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  };

  const selectedSession = selectedRunId
    ? traceSessions.find((session) => session.runId === selectedRunId) || null
    : null;

  return (
    <div className="space-y-8">
      <div className="mb-5">
        <h3 className="text-[15px] font-semibold text-foreground tracking-tight">
          {t("developerSection.title")}
        </h3>
        <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
          {t("developerSection.description")}
        </p>
        <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
          {t("developerSection.localOnlyNotice")}
        </p>
      </div>

      {/* Debug Toggle */}
      <div className="rounded-xl border border-border/60 dark:border-border-subtle bg-card dark:bg-surface-2 divide-y divide-border/40 dark:divide-border-subtle">
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
              <p className="text-[12px] text-muted-foreground mt-0.5 leading-relaxed">
                {debugEnabled
                  ? t("developerSection.debugMode.enabledDescription")
                  : t("developerSection.debugMode.disabledDescription")}
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

        {/* Log Path — only when active */}
        {debugEnabled && logPath && (
          <div className="px-5 py-4">
            <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-2">
              {t("developerSection.currentLogFile")}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[11px] text-muted-foreground font-mono break-all leading-relaxed bg-muted/30 dark:bg-surface-raised/30 px-3 py-2 rounded-lg border border-border/30">
                {logPath}
              </code>
              <Button
                onClick={handleCopyPath}
                variant="ghost"
                size="sm"
                className="shrink-0 h-8 w-8 p-0"
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

        {/* Actions */}
        {debugEnabled && (
          <div className="px-5 py-4">
            <Button onClick={handleOpenLogsFolder} variant="outline" size="sm" className="w-full">
              <FolderOpen className="mr-2 h-3.5 w-3.5" />
              {t("developerSection.openLogsFolder")}
            </Button>
          </div>
        )}
      </div>

      {/* What gets logged */}
      <div>
        <div className="mb-5">
          <h3 className="text-[15px] font-semibold text-foreground tracking-tight">
            {t("developerSection.whatGetsLogged.title")}
          </h3>
        </div>
        <div className="rounded-xl border border-border/60 dark:border-border-subtle bg-card dark:bg-surface-2">
          <div className="px-5 py-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {[
                t("developerSection.whatGetsLogged.items.audioProcessing"),
                t("developerSection.whatGetsLogged.items.apiRequests"),
                t("developerSection.whatGetsLogged.items.ffmpegOperations"),
                t("developerSection.whatGetsLogged.items.systemDiagnostics"),
                t("developerSection.whatGetsLogged.items.transcriptionPipeline"),
                t("developerSection.whatGetsLogged.items.errorDetails"),
              ].map((item) => (
                <div key={item} className="flex items-center gap-2">
                  <div className="h-1 w-1 rounded-full bg-muted-foreground/30 shrink-0" />
                  <span className="text-[12px] text-muted-foreground">{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Call trace diagnostics */}
      <div>
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold text-foreground tracking-tight">
              {t("developerSection.trace.title")}
            </h3>
            <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
              {t("developerSection.trace.description")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => loadTraceSessions()}
              variant="outline"
              size="sm"
              disabled={isLoadingTrace}
              className="h-8"
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t("developerSection.trace.refresh")}
            </Button>
            <Button
              onClick={handleClearTrace}
              variant="destructive"
              size="sm"
              disabled={isClearingTrace}
              className="h-8"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t("developerSection.trace.clear")}
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-border/60 dark:border-border-subtle bg-card dark:bg-surface-2">
          <div className="grid grid-cols-1 lg:grid-cols-2">
            <div className="border-b lg:border-b-0 lg:border-r border-border/40 dark:border-border-subtle">
              <div className="px-5 py-3 border-b border-border/30 dark:border-border-subtle/80">
                <p className="text-[12px] font-medium text-foreground">
                  {t("developerSection.trace.sessionLabel")}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {t("developerSection.trace.showingLatest", { count: 30 })}
                </p>
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                {traceSessions.length === 0 ? (
                  <div className="px-5 py-6 text-[12px] text-muted-foreground">
                    {t("developerSection.trace.emptySessions")}
                  </div>
                ) : (
                  traceSessions.map((session) => {
                    const selected = selectedRunId === session.runId;
                    return (
                      <button
                        key={session.runId}
                        onClick={() => handleSelectSession(session.runId)}
                        className={`w-full text-left px-5 py-3 border-b last:border-b-0 border-border/20 transition-colors ${
                          selected ? "bg-primary/5" : "hover:bg-muted/20"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[12px] font-medium text-foreground truncate">
                              {t("developerSection.trace.runId")}{" "}
                              <span className="font-mono">{session.runId}</span>
                            </p>
                            <p className="text-[11px] text-muted-foreground mt-1 truncate">
                              {t("developerSection.trace.startedAt")}:{" "}
                              {formatDateTime(session.startedAt)}
                            </p>
                            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                              {t("developerSection.trace.updatedAt")}:{" "}
                              {formatDateTime(session.updatedAt)}
                            </p>
                            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                              {t("developerSection.trace.models.transcription")}:{" "}
                              {session.transcriptionProvider || "--"} /{" "}
                              {session.transcriptionModel || "--"}
                            </p>
                            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                              {t("developerSection.trace.models.reasoning")}:{" "}
                              {session.reasoningProvider || "--"} / {session.reasoningModel || "--"}
                            </p>
                            {session.error && (
                              <p className="text-[11px] text-destructive mt-1 leading-relaxed">
                                {t("developerSection.trace.errorPrefix")}: {session.error}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(session.transcriptionStatus)}`}
                          >
                            {getPhaseLabel("transcription")}:{" "}
                            {getStatusLabel(session.transcriptionStatus)}
                          </span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(session.reasoningStatus)}`}
                          >
                            {getPhaseLabel("reasoning")}: {getStatusLabel(session.reasoningStatus)}
                          </span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(session.pasteStatus)}`}
                          >
                            {getPhaseLabel("paste")}: {getStatusLabel(session.pasteStatus)}
                          </span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(session.sessionStatus)}`}
                          >
                            {getPhaseLabel("session")}: {getStatusLabel(session.sessionStatus)}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div>
              <div className="px-5 py-3 border-b border-border/30 dark:border-border-subtle/80">
                <p className="text-[12px] font-medium text-foreground">
                  {t("developerSection.trace.eventLabel")}
                </p>
                {selectedSession ? (
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                    {t("developerSection.trace.runId")}{" "}
                    <span className="font-mono">{selectedSession.runId}</span>
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {t("developerSection.trace.emptyEvents")}
                  </p>
                )}
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                {traceEvents.length === 0 ? (
                  <div className="px-5 py-6 text-[12px] text-muted-foreground">
                    {t("developerSection.trace.emptyEvents")}
                  </div>
                ) : (
                  traceEvents
                    .slice()
                    .reverse()
                    .map((event) => {
                      const phase = event.meta?.phase || "session";
                      const status = event.meta?.status || "unknown";
                      const errorMessage =
                        typeof event.meta?.error === "string" ? event.meta.error : null;
                      return (
                        <div
                          key={event.id}
                          className="px-5 py-3 border-b last:border-b-0 border-border/20"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[12px] font-medium text-foreground">
                              {getPhaseLabel(phase)}
                            </p>
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(status)}`}
                            >
                              {getStatusLabel(status)}
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {formatDateTime(event.timestamp)}
                          </p>
                          {errorMessage && (
                            <p className="text-[11px] text-destructive mt-1 leading-relaxed">
                              {t("developerSection.trace.errorPrefix")}: {errorMessage}
                            </p>
                          )}
                          {!errorMessage && event.meta && (
                            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed break-all">
                              {JSON.stringify(event.meta)}
                            </p>
                          )}
                        </div>
                      );
                    })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Performance note — conditional */}
      {debugEnabled && (
        <div className="rounded-xl border border-warning/20 bg-warning/5 dark:bg-warning/10">
          <div className="px-5 py-4">
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              <span className="font-medium text-warning">
                {t("developerSection.performanceNote.label")}
              </span>{" "}
              {t("developerSection.performanceNote.description")}
            </p>
          </div>
        </div>
      )}

      {/* Sharing instructions — conditional */}
      {debugEnabled && (
        <div>
          <div className="mb-5">
            <h3 className="text-[15px] font-semibold text-foreground tracking-tight">
              {t("developerSection.sharing.title")}
            </h3>
          </div>
          <div className="rounded-xl border border-border/60 dark:border-border-subtle bg-card dark:bg-surface-2">
            <div className="px-5 py-4">
              <div className="space-y-2">
                {[
                  t("developerSection.sharing.steps.0"),
                  t("developerSection.sharing.steps.1"),
                  t("developerSection.sharing.steps.2"),
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="shrink-0 text-[11px] font-mono text-muted-foreground/40 mt-0.5 w-4 text-right">
                      {i + 1}
                    </span>
                    <p className="text-[12px] text-muted-foreground leading-relaxed">{step}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground/40 mt-4 pt-3 border-t border-border/20">
                {t("developerSection.sharing.footer")}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
