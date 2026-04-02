import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";
import { useToast } from "./ui/Toast";
import type { CallTraceEvent, CallTraceSession } from "../types/electron";
import {
  CHORDVOX_CLOUD_MODEL,
  CHORDVOX_CLOUD_PROVIDER,
  isChordVoxCloudProvider,
  isChordVoxCloudValue,
} from "../utils/chordvoxCloud";

const TRACE_PHASE_ORDER = [
  "recording",
  "transcription",
  "reasoning",
  "paste",
  "session",
] as const;
const TERMINAL_TRACE_STATUSES = new Set(["success", "error", "cancelled", "skipped"]);

function getModelDisplayValue(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "—";
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

function formatDuration(ms: number | null | undefined): string {
  if (!Number.isFinite(Number(ms))) return "—";
  const numeric = Number(ms);
  if (numeric < 1000) return `${Math.round(numeric)} ms`;
  const seconds = numeric / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
  const statuses = [
    session.sessionStatus,
    session.transcriptionStatus,
    session.reasoningStatus,
    session.pasteStatus,
  ];

  if (statuses.includes("error")) return "error";
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.includes("success")) return "success";
  if (statuses.includes("start")) return "start";
  if (statuses.includes("skipped")) return "skipped";
  return "unknown";
}

function getEventTimestampMs(event: CallTraceEvent): number {
  const timestamp = event?.timestamp ? Date.parse(event.timestamp) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getDisplayEvent(event: CallTraceEvent, session: CallTraceSession | null): CallTraceEvent {
  const phase = String(event.meta?.phase || "session");
  const status = String(event.meta?.status || "unknown");

  if (
    phase === "reasoning" &&
    status === "start" &&
    session?.sessionStatus === "success" &&
    !String(session.reasoningModel || "").trim()
  ) {
    return {
      ...event,
      meta: {
        ...(event.meta || {}),
        status: "skipped",
        reason:
          typeof event.meta?.reason === "string" && event.meta.reason.trim()
            ? event.meta.reason
            : "No reasoning model selected",
      },
    };
  }

  return event;
}

function buildPhaseTimeline(
  events: CallTraceEvent[],
  session: CallTraceSession | null
): CallTraceEvent[] {
  const phaseBuckets = new Map<string, CallTraceEvent[]>();

  for (const rawEvent of events) {
    const event = getDisplayEvent(rawEvent, session);
    const phase = String(event.meta?.phase || "session");
    const bucket = phaseBuckets.get(phase) || [];
    bucket.push(event);
    phaseBuckets.set(phase, bucket);
  }

  return TRACE_PHASE_ORDER.map((phase) => {
    const phaseEvents = phaseBuckets.get(phase);
    if (!phaseEvents?.length) return null;

    const sortedEvents = phaseEvents
      .slice()
      .sort((a, b) => getEventTimestampMs(b) - getEventTimestampMs(a));

    const terminalEvent = sortedEvents.find((event) =>
      TERMINAL_TRACE_STATUSES.has(String(event.meta?.status || "unknown"))
    );

    return terminalEvent || sortedEvents[0];
  }).filter(Boolean) as CallTraceEvent[];
}

export default function CallRecordsSection() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [isClearingTrace, setIsClearingTrace] = useState(false);
  const [traceSessions, setTraceSessions] = useState<CallTraceSession[]>([]);
  const [traceEvents, setTraceEvents] = useState<CallTraceEvent[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    void loadTraceSessions();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadTraceSessions(true);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedRunId]);

  const loadTraceEvents = async (runId: string, silent = false) => {
    try {
      if (!silent) setIsLoadingTrace(true);
      const result = await window.electronAPI.getCallTraceEvents(runId, 120);
      if (result.success) {
        setTraceEvents(result.events || []);
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
  };

  const loadTraceSessions = async (silent = false) => {
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

  const buildProviderModel = (provider: string | null, model: string | null) => {
    const normalizedProvider = String(provider || "").trim();
    const normalizedModelRaw = String(model || "").trim();
    const providerLabel = isChordVoxCloudProvider(normalizedProvider)
      ? "ChordVox Cloud"
      : normalizedProvider;
    const modelLabel = isChordVoxCloudValue(normalizedModelRaw)
      ? "ChordVox Cloud"
      : getModelDisplayValue(model);
    if (!providerLabel && modelLabel === "—") return "—";
    if (!providerLabel) return modelLabel;
    if (modelLabel === "—" || modelLabel === providerLabel) return providerLabel;
    if (
      normalizedProvider === CHORDVOX_CLOUD_PROVIDER ||
      normalizedModelRaw === CHORDVOX_CLOUD_MODEL
    ) {
      return "ChordVox Cloud";
    }
    return `${providerLabel} / ${modelLabel}`;
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
        `${t("developerSection.trace.models.transcription")}: ${buildProviderModel(
          meta.transcriptionProvider || null,
          meta.transcriptionModel || null
        )}`
      );
    }
    if (meta.reasoningProvider || meta.reasoningModel) {
      details.push(
        `${t("developerSection.trace.models.reasoning")}: ${buildProviderModel(
          meta.reasoningProvider || null,
          meta.reasoningModel || null
        )}`
      );
    }
    if (hasTranscriptionMs) {
      details.push(
        `${t("developerSection.trace.summary.transcriptionDuration")}: ${formatDuration(
          transcriptionMs
        )}`
      );
    }
    if (hasReasoningMs) {
      details.push(
        `${t("developerSection.trace.summary.reasoningDuration")}: ${formatDuration(
          reasoningMs
        )}`
      );
    }
    if (hasTranscriptionMs || hasReasoningMs) {
      details.push(
        `${t("developerSection.trace.summary.totalDuration")}: ${formatDuration(
          (transcriptionMs ?? 0) + (reasoningMs ?? 0)
        )}`
      );
    }
    if (typeof meta.reason === "string" && meta.reason.trim()) {
      details.push(meta.reason.trim());
    }

    return details;
  };

  const selectedSession = selectedRunId
    ? traceSessions.find((session) => session.runId === selectedRunId) || null
    : null;
  const phaseTimelineEvents = useMemo(
    () => buildPhaseTimeline(traceEvents, selectedSession),
    [traceEvents, selectedSession]
  );
  const phaseStatusByPhase = useMemo(() => {
    const phaseMap = new Map<string, string>();
    for (const event of phaseTimelineEvents) {
      phaseMap.set(
        String(event.meta?.phase || "session"),
        String(event.meta?.status || "unknown")
      );
    }
    return phaseMap;
  }, [phaseTimelineEvents]);
  const displayedTranscriptionStatus =
    phaseStatusByPhase.get("transcription") || selectedSession?.transcriptionStatus || "unknown";
  const displayedReasoningStatus =
    phaseStatusByPhase.get("reasoning") || selectedSession?.reasoningStatus || "unknown";
  const displayedPasteStatus =
    phaseStatusByPhase.get("paste") || selectedSession?.pasteStatus || "unknown";
  const displayedSessionStatus =
    phaseStatusByPhase.get("session") || selectedSession?.sessionStatus || "unknown";

  const overviewItems = selectedSession
    ? [
        {
          label: t("developerSection.trace.models.transcription"),
          value: buildProviderModel(
            selectedSession.transcriptionProvider,
            selectedSession.transcriptionModel
          ),
        },
        {
          label: t("developerSection.trace.models.reasoning"),
          value: buildProviderModel(selectedSession.reasoningProvider, selectedSession.reasoningModel),
        },
        {
          label: t("developerSection.trace.summary.recordingDuration"),
          value: formatDuration(selectedSession.recordingDurationMs),
        },
        {
          label: t("developerSection.trace.summary.transcriptionDuration"),
          value: formatDuration(selectedSession.transcriptionProcessingDurationMs),
        },
        {
          label: t("developerSection.trace.summary.reasoningDuration"),
          value:
            displayedReasoningStatus === "skipped"
              ? t("developerSection.trace.status.skipped")
              : formatDuration(selectedSession.reasoningProcessingDurationMs),
        },
        {
          label: t("developerSection.trace.summary.totalDuration"),
          value: formatDuration(getProcessingDurationMs(selectedSession)),
        },
        {
          label: t("developerSection.trace.summary.failedAt"),
          value: selectedSession.error ? getFailurePhase(selectedSession) : "—",
        },
      ]
    : [];

  return (
    <div className="space-y-6">
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

      <div className="rounded-xl border border-border/60 dark:border-border-subtle bg-card dark:bg-surface-2 overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="border-b md:border-b-0 md:border-r border-border/40 dark:border-border-subtle">
            <div className="px-5 py-3 border-b border-border/30 dark:border-border-subtle/80">
              <p className="text-[12px] font-medium text-foreground">
                {t("developerSection.trace.sessionLabel")}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t("developerSection.trace.showingLatest", { count: 30 })}
              </p>
            </div>
            <div className="max-h-[520px] overflow-y-auto">
              {traceSessions.length === 0 ? (
                <div className="px-5 py-6 text-[12px] text-muted-foreground">
                  {t("developerSection.trace.emptySessions")}
                </div>
              ) : (
                traceSessions.map((session) => {
                  const selected = selectedRunId === session.runId;
                  const processingSummary = formatDuration(getProcessingDurationMs(session));
                  const updatedAt = formatDateTime(session.updatedAt);
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
                            {t("developerSection.trace.runId")}{" "}
                            <span className="font-mono">{session.runId}</span>
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">{updatedAt}</p>
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

          <div>
            <div className="px-5 py-3 border-b border-border/30 dark:border-border-subtle/80">
              <p className="text-[12px] font-medium text-foreground">
                {t("developerSection.trace.summary.overviewTitle")}
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
            <div className="max-h-[520px] overflow-y-auto">
              {!selectedSession ? (
                <div className="px-5 py-6 text-[12px] text-muted-foreground">
                  {t("developerSection.trace.emptyEvents")}
                </div>
              ) : (
                <div className="space-y-5 px-5 py-4">
                  <div className="flex flex-wrap gap-1.5">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(displayedTranscriptionStatus)}`}
                    >
                      {getPhaseLabel("transcription")}: {getStatusLabel(displayedTranscriptionStatus)}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(displayedReasoningStatus)}`}
                    >
                      {getPhaseLabel("reasoning")}: {getStatusLabel(displayedReasoningStatus)}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(displayedPasteStatus)}`}
                    >
                      {getPhaseLabel("paste")}: {getStatusLabel(displayedPasteStatus)}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${getStatusChip(displayedSessionStatus)}`}
                    >
                      {getPhaseLabel("session")}: {getStatusLabel(displayedSessionStatus)}
                    </span>
                  </div>

                  {selectedSession.error && (
                    <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-destructive">
                            {t("developerSection.trace.errorPrefix")}
                          </p>
                          <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed break-words">
                            {selectedSession.error}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {overviewItems.map((item) => (
                      <div
                        key={item.label}
                        className="rounded-lg border border-border/40 bg-muted/10 px-4 py-3"
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

                  <div>
                    <p className="text-[12px] font-medium text-foreground">
                      {t("developerSection.trace.summary.timelineTitle")}
                    </p>
                    <div className="mt-3 rounded-xl border border-border/40 overflow-hidden">
                      {traceEvents.length === 0 ? (
                        <div className="px-5 py-6 text-[12px] text-muted-foreground">
                          {t("developerSection.trace.emptyEvents")}
                        </div>
                      ) : (
                        phaseTimelineEvents.map((event) => {
                            const phase = event.meta?.phase || "session";
                            const status = event.meta?.status || "unknown";
                            const details = buildEventDetails(event);
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
