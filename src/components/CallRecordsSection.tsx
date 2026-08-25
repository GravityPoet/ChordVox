import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";
import { useToast } from "./ui/toastContext";
import type { CallTraceEvent, CallTraceSession } from "../types/electron";
import type { ConfirmDialogState } from "../hooks/useDialogs";
import { PRO_REASONING_PREVIEW_DAILY_LIMIT } from "../utils/reasoningPreviewQuota";
import {
  getProviderModelDisplayValue,
  getTraceSessionListTitle,
} from "../utils/callRecordsDisplay";
import { buildPhaseTimeline, getTraceSessionDisplayTimestamp } from "../utils/callTraceTimeline";

type TraceTranslator = ReturnType<typeof useTranslation>["t"];

function formatDuration(ms: number | null | undefined, t: TraceTranslator): string {
  if (!Number.isFinite(Number(ms))) return "—";
  const seconds = Math.max(0, Number(ms)) / 1000;
  const value =
    seconds === 0
      ? "0"
      : seconds < 0.1
        ? "< 0.1"
        : (Math.round(seconds * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return t("developerSection.trace.summary.durationSecondsValue", { value });
}

function formatTraceDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTraceTimeRange(startedAt: string, completedAt: string | null): string {
  const startDate = new Date(startedAt);
  const endDate = completedAt ? new Date(completedAt) : null;
  const startText = formatTraceDateTime(startedAt);

  if (
    Number.isNaN(startDate.getTime()) ||
    !endDate ||
    Number.isNaN(endDate.getTime()) ||
    Math.floor(endDate.getTime() / 1000) <= Math.floor(startDate.getTime() / 1000)
  ) {
    return startText;
  }

  const sameLocalDate =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate();
  const endText = sameLocalDate
    ? endDate.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : formatTraceDateTime(completedAt);

  return `${startText} → ${endText}`;
}

function getDurationValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getProcessingDurationMs(session: CallTraceSession | null): number | null {
  if (!session) return null;
  const transcriptionMs = getDurationValue(session.transcriptionProcessingDurationMs);
  const reasoningMs = getDurationValue(session.reasoningProcessingDurationMs);
  const hasTranscription = transcriptionMs !== null;
  const hasReasoning = reasoningMs !== null;
  if (!hasTranscription && !hasReasoning) return null;
  return (transcriptionMs ?? 0) + (reasoningMs ?? 0);
}

function getSessionOverallStatus(session: CallTraceSession | null): string {
  if (!session) return "unknown";
  const sessionStatus = String(session.sessionStatus || "unknown");
  const phaseStatuses = [
    session.transcriptionStatus,
    session.reasoningStatus,
    session.pasteStatus,
  ].map((status) => String(status || "unknown"));

  if (sessionStatus === "error" || phaseStatuses.includes("error")) return "error";
  if (sessionStatus === "cancelled" || phaseStatuses.includes("cancelled")) return "cancelled";
  if (sessionStatus === "success") return "success";
  if (sessionStatus === "skipped") return "skipped";
  if (sessionStatus === "start" || phaseStatuses.includes("start")) return "start";
  if (phaseStatuses.includes("fallback")) return "fallback";
  if (phaseStatuses.includes("skipped")) return "skipped";
  return "unknown";
}

function localizeTraceError(
  message: string | null | undefined,
  t: ReturnType<typeof useTranslation>["t"]
): string | null {
  const normalized = String(message || "").trim();
  if (!normalized) return null;

  if (normalized.includes("Accessibility permissions required for automatic pasting")) {
    return t("hooks.clipboard.pasteFailed.autoPasteAccessibilityRequired");
  }

  return normalized;
}

function localizeTraceReason(
  message: string | null | undefined,
  t: ReturnType<typeof useTranslation>["t"],
  meta: Record<string, unknown> = {}
): string | null {
  // Prefer the structured reason code: the skip message can be the generic
  // fallback even when the real cause is a quota/license limit, so map by code
  // first to surface the specific reason to the user.
  const reasonCode = typeof meta.reasonCode === "string" ? meta.reasonCode : null;
  if (reasonCode === "PRO_REASONING_PREVIEW_LIMIT_REACHED") {
    return t("developerSection.trace.reasons.reasoningPreviewLimit", {
      limit: Number(meta.previewLimit ?? PRO_REASONING_PREVIEW_DAILY_LIMIT),
    });
  }
  if (reasonCode === "PRO_REASONING_PREVIEW_USED") {
    return t("developerSection.trace.reasons.reasoningPreviewUsed", {
      remaining: Number(meta.previewRemaining ?? 0),
      limit: Number(meta.previewLimit ?? PRO_REASONING_PREVIEW_DAILY_LIMIT),
    });
  }
  if (reasonCode === "LICENSE_REQUIRED") {
    return t("developerSection.trace.reasons.reasoningRequiresPro");
  }

  const normalized = String(message || "").trim();
  if (!normalized) return null;

  if (normalized === "stale_unfinished_trace") {
    return t("settingsPage.callRecords.overview.cancelledNoStageData");
  }
  if (normalized === "AI refinement failed; used the original transcript.") {
    return t("developerSection.trace.reasons.aiFallback");
  }
  if (normalized === "AI refinement requires Pro; the original transcript was used.") {
    return t("developerSection.trace.reasons.reasoningRequiresPro");
  }
  if (normalized === "AI refinement Pro preview used.") {
    return t("developerSection.trace.reasons.reasoningPreviewUsed", {
      remaining: Number(meta.previewRemaining ?? 0),
      limit: Number(meta.previewLimit ?? PRO_REASONING_PREVIEW_DAILY_LIMIT),
    });
  }
  if (normalized === "AI refinement Pro preview limit reached; the original transcript was used.") {
    return t("developerSection.trace.reasons.reasoningPreviewLimit", {
      limit: Number(meta.previewLimit ?? PRO_REASONING_PREVIEW_DAILY_LIMIT),
    });
  }
  if (normalized === "No reasoning model selected") {
    return t("developerSection.trace.reasons.noReasoningModel");
  }
  if (normalized === "Reasoning disabled") {
    return t("developerSection.trace.reasons.reasoningDisabled");
  }
  if (normalized === "No text for reasoning") {
    return t("developerSection.trace.reasons.noTextForReasoning");
  }
  if (normalized.startsWith("Reasoning not enabled or unavailable")) {
    return t("developerSection.trace.reasons.reasoningUnavailable");
  }

  return normalized;
}

interface CallRecordsSectionProps {
  showConfirmDialog?: (options: Omit<ConfirmDialogState, "open">) => void;
}

export default function CallRecordsSection({ showConfirmDialog }: CallRecordsSectionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [isClearingTrace, setIsClearingTrace] = useState(false);
  const [traceSessions, setTraceSessions] = useState<CallTraceSession[]>([]);
  const [traceEvents, setTraceEvents] = useState<CallTraceEvent[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const loadTraceEvents = useCallback(
    async (runId: string, silent = false) => {
      try {
        if (!silent) setIsLoadingTrace(true);
        const result = await window.electronAPI.getCallTraceEvents(runId, 120);
        if (!result.success) {
          setTraceEvents([]);
          throw new Error(result.error || "Failed to load call trace events");
        }
        setTraceEvents(result.events || []);
      } catch (_error) {
        if (!silent) {
          toast({
            title: t("developerSection.trace.toasts.loadFailed.title"),
            description: t("developerSection.trace.toasts.loadFailed.description"),
            variant: "destructive",
          });
        }
      } finally {
        if (!silent) setIsLoadingTrace(false);
      }
    },
    [t, toast]
  );

  const loadTraceSessions = useCallback(
    async (silent = false) => {
      try {
        if (!silent) setIsLoadingTrace(true);
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
      } catch (_error) {
        if (!silent) {
          toast({
            title: t("developerSection.trace.toasts.loadFailed.title"),
            description: t("developerSection.trace.toasts.loadFailed.description"),
            variant: "destructive",
          });
        }
      } finally {
        if (!silent) setIsLoadingTrace(false);
      }
    },
    [loadTraceEvents, selectedRunId, t, toast]
  );

  useEffect(() => {
    void loadTraceSessions();
  }, [loadTraceSessions]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadTraceSessions(true);
    }, 3000);
    return () => clearInterval(timer);
  }, [loadTraceSessions]);

  const handleSelectSession = async (runId: string) => {
    setSelectedRunId(runId);
    await loadTraceEvents(runId);
  };

  const executeClearTrace = async () => {
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
    } catch (_error) {
      toast({
        title: t("developerSection.trace.toasts.clearFailed.title"),
        description: t("developerSection.trace.toasts.clearFailed.description"),
        variant: "destructive",
      });
    } finally {
      setIsClearingTrace(false);
    }
  };

  const handleClearTrace = () => {
    if (showConfirmDialog) {
      showConfirmDialog({
        title: t("developerSection.trace.toasts.confirmClear.title"),
        description: t("developerSection.trace.toasts.confirmClear.description"),
        confirmText: t("developerSection.trace.toasts.confirmClear.confirmText"),
        variant: "destructive",
        onConfirm: () => void executeClearTrace(),
      });
    } else {
      void executeClearTrace();
    }
  };

  const getStatusChip = (status?: string) => {
    if (status === "success") return "bg-success/15 text-success border-success/30";
    if (status === "error") return "bg-destructive/10 text-destructive border-destructive/30";
    if (status === "start") return "glass-chip glass-chip--accent text-primary";
    if (status === "cancelled") return "bg-warning/15 text-warning border-warning/30";
    if (status === "fallback") return "bg-warning/10 text-warning border-warning/25";
    if (status === "route") return "glass-chip glass-chip--accent text-primary";
    if (status === "skipped") return "bg-muted text-muted-foreground border-border/40";
    return "bg-muted text-muted-foreground border-border/40";
  };

  const getStatusLabel = (status?: string) => {
    const normalized = status || "unknown";
    const key = `developerSection.trace.status.${normalized}`;
    const label = t(key);
    return label === key ? t("developerSection.trace.status.unknown") : label;
  };

  const getPhaseLabel = (phase?: string | null) => {
    const normalized = phase || "session";
    return t(`developerSection.trace.phases.${normalized}`);
  };

  const getFailurePhase = (session: CallTraceSession | null) => {
    if (!session) return "—";
    if (session.failurePhase) return getPhaseLabel(session.failurePhase);
    if (session.reasoningStatus === "error") return getPhaseLabel("reasoning");
    if (session.transcriptionStatus === "error") return getPhaseLabel("transcription");
    if (session.pasteStatus === "error") return getPhaseLabel("paste");
    if (session.sessionStatus === "error") return getPhaseLabel("session");
    return "—";
  };

  const buildEventDetails = (event: CallTraceEvent) => {
    const details: string[] = [];
    const meta = event.meta;
    if (!meta) return details;
    const transcriptionMs = getDurationValue(meta.transcriptionProcessingDurationMs);
    const reasoningMs = getDurationValue(meta.reasoningProcessingDurationMs);
    const hasTranscriptionMs = transcriptionMs !== null;
    const hasReasoningMs = reasoningMs !== null;

    if (meta.transcriptionProvider || meta.transcriptionModel) {
      details.push(
        `${t("developerSection.trace.models.transcription")}: ${getProviderModelDisplayValue(
          meta.transcriptionProvider || null,
          meta.transcriptionModel || null,
          "transcription"
        )}`
      );
    }
    if (meta.reasoningProvider || meta.reasoningModel) {
      details.push(
        `${t("developerSection.trace.models.reasoning")}: ${getProviderModelDisplayValue(
          meta.reasoningProvider || null,
          meta.reasoningModel || null,
          "reasoning"
        )}`
      );
    }
    if (hasTranscriptionMs) {
      details.push(
        `${t("developerSection.trace.summary.transcriptionDuration")}: ${formatDuration(
          transcriptionMs,
          t
        )}`
      );
    }
    if (hasReasoningMs) {
      details.push(
        `${t("developerSection.trace.summary.reasoningDuration")}: ${formatDuration(reasoningMs, t)}`
      );
    }
    if (hasTranscriptionMs || hasReasoningMs) {
      details.push(
        `${t("developerSection.trace.summary.totalDuration")}: ${formatDuration(
          (transcriptionMs ?? 0) + (reasoningMs ?? 0),
          t
        )}`
      );
    }
    if (typeof meta.reason === "string" && meta.reason.trim()) {
      let localizedReason = localizeTraceReason(meta.reason, t, meta);
      if (localizedReason) {
        // Generic fallback (no structured code) hides why polish was skipped;
        // surface the underlying error so the user isn't left guessing.
        const fallbackError =
          typeof meta.fallbackError === "string" ? meta.fallbackError.trim() : "";
        if (fallbackError && !meta.reasonCode) {
          localizedReason = `${localizedReason} (${fallbackError})`;
        }
        details.push(localizedReason);
      }
    }

    return details;
  };

  const selectedSession = selectedRunId
    ? traceSessions.find((session) => session.runId === selectedRunId) || null
    : null;
  const localizedSessionError = localizeTraceError(selectedSession?.error, t);
  const phaseTimelineItems = useMemo(
    () => buildPhaseTimeline(traceEvents, selectedSession),
    [traceEvents, selectedSession]
  );
  const phaseStatusByPhase = useMemo(() => {
    const phaseMap = new Map<string, string>();
    for (const { event } of phaseTimelineItems) {
      phaseMap.set(String(event.meta?.phase || "session"), String(event.meta?.status || "unknown"));
    }
    return phaseMap;
  }, [phaseTimelineItems]);
  const displayedTranscriptionStatus =
    phaseStatusByPhase.get("transcription") || selectedSession?.transcriptionStatus || "unknown";
  const displayedReasoningStatus =
    phaseStatusByPhase.get("reasoning") || selectedSession?.reasoningStatus || "unknown";
  const displayedPasteStatus =
    phaseStatusByPhase.get("paste") || selectedSession?.pasteStatus || "unknown";
  const selectedSessionStatus = selectedSession?.sessionStatus || "unknown";
  const displayedSessionStatus =
    selectedSessionStatus !== "unknown" && selectedSessionStatus !== "start"
      ? selectedSessionStatus
      : phaseStatusByPhase.get("session") || selectedSessionStatus;
  const phaseStatusItems = [
    { phase: "transcription", status: displayedTranscriptionStatus },
    { phase: "reasoning", status: displayedReasoningStatus },
    { phase: "paste", status: displayedPasteStatus },
    { phase: "session", status: displayedSessionStatus },
  ].filter(({ status }) => status !== "unknown");

  const overviewItems = selectedSession
    ? [
        {
          label: t("developerSection.trace.models.transcription"),
          value: getProviderModelDisplayValue(
            selectedSession.transcriptionProvider,
            selectedSession.transcriptionModel,
            "transcription"
          ),
        },
        {
          label: t("developerSection.trace.models.reasoning"),
          value: getProviderModelDisplayValue(
            selectedSession.reasoningProvider,
            selectedSession.reasoningModel,
            "reasoning"
          ),
        },
        {
          label: t("developerSection.trace.summary.recordingDuration"),
          value: formatDuration(selectedSession.recordingDurationMs, t),
        },
        {
          label: t("developerSection.trace.summary.transcriptionDuration"),
          value: formatDuration(selectedSession.transcriptionProcessingDurationMs, t),
        },
        {
          label: t("developerSection.trace.summary.reasoningDuration"),
          value:
            displayedReasoningStatus === "skipped"
              ? t("developerSection.trace.status.skipped")
              : formatDuration(selectedSession.reasoningProcessingDurationMs, t),
        },
        {
          label: t("developerSection.trace.summary.totalDuration"),
          value: formatDuration(getProcessingDurationMs(selectedSession), t),
        },
        {
          label: t("developerSection.trace.summary.failedAt"),
          value: selectedSession.error ? getFailurePhase(selectedSession) : "—",
        },
      ]
    : [];

  const isCancelledNoStageData =
    selectedSession?.sessionStatus === "cancelled" &&
    !selectedSession.recordingDurationMs &&
    !selectedSession.transcriptionProcessingDurationMs &&
    !selectedSession.reasoningProcessingDurationMs &&
    !getProcessingDurationMs(selectedSession);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-semibold text-foreground tracking-tight">
            {t("settingsModal.sections.callRecords.label")}
          </h3>
          <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
            {t("settingsModal.sections.callRecords.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void loadTraceSessions()}
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
            variant="outline"
            size="sm"
            disabled={isClearingTrace}
            className="h-8 text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t("developerSection.trace.clear")}
          </Button>
        </div>
      </div>

      <div className="call-records-table-shell glass-panel glass-panel--soft overflow-hidden rounded-xl md:flex md:min-h-0 md:flex-1 md:flex-col">
        <div className="grid grid-cols-1 md:min-h-0 md:flex-1 md:grid-cols-[300px_minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="border-b border-border/40 md:flex md:min-h-0 md:flex-col md:border-b-0 md:border-r md:border-[color:var(--ui-glass-divider)]">
            <div className="border-b border-border/30 px-5 py-3 md:border-[color:var(--ui-glass-divider)]">
              <p className="text-[12px] font-medium text-foreground">
                {t("developerSection.trace.sessionLabel")}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t("developerSection.trace.showingLatest", { count: 30 })}
              </p>
            </div>
            <div className="max-h-[520px] overflow-y-auto md:min-h-0 md:flex-1 md:max-h-none">
              {traceSessions.length === 0 ? (
                <div className="px-5 py-6 text-[12px] text-muted-foreground">
                  {t("developerSection.trace.emptySessions")}
                </div>
              ) : (
                traceSessions.map((session) => {
                  const selected = selectedRunId === session.runId;
                  const processingSummary = formatDuration(getProcessingDurationMs(session), t);
                  const displayTimestamp = getTraceSessionDisplayTimestamp(session);
                  const displayedAt = formatTraceDateTime(displayTimestamp);
                  const overallStatus = getSessionOverallStatus(session);
                  return (
                    <button
                      key={session.runId}
                      onClick={() => void handleSelectSession(session.runId)}
                      className={`w-full text-left px-4 py-3.5 border-b last:border-b-0 border-border/20 transition-colors ${
                        selected
                          ? "bg-primary/6 border-l-2 border-l-primary"
                          : "hover:bg-muted/20 border-l-2 border-l-transparent"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] font-medium text-foreground truncate">
                            {getTraceSessionListTitle(
                              t("developerSection.trace.sessionLabel"),
                              displayTimestamp
                            )}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">{displayedAt}</p>
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            {t("developerSection.trace.summary.totalDuration")}: {processingSummary}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(overallStatus)}`}
                        >
                          {getStatusLabel(overallStatus)}
                        </span>
                      </div>
                      {session.error && (
                        <p className="mt-2 text-[11px] text-destructive/85 leading-relaxed line-clamp-1">
                          {t("developerSection.trace.summary.failedAt")}: {getFailurePhase(session)}
                        </p>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="md:flex md:min-h-0 md:flex-col">
            <div className="border-b border-border/30 px-5 py-3 md:border-[color:var(--ui-glass-divider)]">
              <p className="text-[12px] font-medium text-foreground">
                {t("developerSection.trace.summary.overviewTitle")}
              </p>
              {selectedSession ? (
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                  {getTraceSessionListTitle(
                    t("developerSection.trace.sessionLabel"),
                    getTraceSessionDisplayTimestamp(selectedSession)
                  )}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {t("developerSection.trace.emptyEvents")}
                </p>
              )}
            </div>
            <div className="max-h-[520px] overflow-y-auto md:min-h-0 md:flex-1 md:max-h-none">
              {!selectedSession ? (
                <div className="px-5 py-6 text-[12px] text-muted-foreground">
                  {t("developerSection.trace.emptyEvents")}
                </div>
              ) : (
                <div className="space-y-5 px-5 py-4">
                  {phaseStatusItems.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {phaseStatusItems.map(({ phase, status }) => (
                        <span
                          key={phase}
                          className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(status)}`}
                        >
                          {getPhaseLabel(phase)}: {getStatusLabel(status)}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {isCancelledNoStageData ? (
                    <p className="rounded-md border border-border/40 bg-muted/10 px-4 py-3 text-[12px] text-muted-foreground">
                      {t("settingsPage.callRecords.overview.cancelledNoStageData")}
                    </p>
                  ) : (
                    <>
                      {localizedSessionError && (
                        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
                          <div className="flex items-start gap-3">
                            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <p className="text-[12px] font-medium text-destructive">
                                {t("developerSection.trace.errorPrefix")}
                              </p>
                              <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed break-words">
                                {localizedSessionError}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {overviewItems.map((item) => (
                          <div
                            key={item.label}
                            className="call-records-overview-card rounded-lg border border-border/40 bg-muted/10 px-4 py-3"
                          >
                            <p className="text-[11px] font-medium text-muted-foreground/80 uppercase tracking-wider">
                              {item.label}
                            </p>
                            <p className="text-[12px] text-foreground mt-2 leading-relaxed break-words">
                              {item.value}
                            </p>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  <div>
                    <p className="text-[12px] font-medium text-foreground">
                      {t("developerSection.trace.summary.timelineTitle")}
                    </p>
                    <div className="call-records-timeline mt-3 rounded-xl border border-border/40 overflow-hidden">
                      {traceEvents.length === 0 ? (
                        <div className="px-5 py-6 text-[12px] text-muted-foreground">
                          {t("developerSection.trace.emptyEvents")}
                        </div>
                      ) : (
                        phaseTimelineItems.map(({ event, startedAt, completedAt }) => {
                          const phase = event.meta?.phase || "session";
                          const status = event.meta?.status || "unknown";
                          const details = buildEventDetails(event);
                          const errorMessage = localizeTraceError(
                            typeof event.meta?.error === "string" ? event.meta.error : null,
                            t
                          );
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
                                {formatTraceTimeRange(startedAt, completedAt)}
                              </p>
                              {details.map((detail) => (
                                <p
                                  key={detail}
                                  className="text-[11px] text-muted-foreground mt-1 leading-relaxed break-words"
                                >
                                  {detail}
                                </p>
                              ))}
                              {errorMessage && (
                                <p className="text-[11px] text-destructive mt-1 leading-relaxed break-words">
                                  {t("developerSection.trace.errorPrefix")}: {errorMessage}
                                </p>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
