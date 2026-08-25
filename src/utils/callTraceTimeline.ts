import type { CallTraceEvent, CallTraceSession } from "../types/electron";

const TRACE_PHASE_ORDER = ["recording", "transcription", "reasoning", "paste", "session"] as const;
const TERMINAL_TRACE_STATUSES = new Set(["success", "error", "cancelled", "skipped", "fallback"]);

export interface CallTraceTimelineItem {
  event: CallTraceEvent;
  startedAt: string;
  completedAt: string | null;
}

function getValidTimestamp(value: unknown): string | null {
  const timestamp = typeof value === "string" ? value : "";
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function getEventTimestamp(event: CallTraceEvent): string {
  return getValidTimestamp(event.meta?.occurredAt) || event.timestamp;
}

function getEventTimestampMs(event: CallTraceEvent): number {
  const timestamp = Date.parse(getEventTimestamp(event));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getDisplayEvent(event: CallTraceEvent, session: CallTraceSession | null): CallTraceEvent {
  const phase = String(event.meta?.phase || "session");
  const status = String(event.meta?.status || "unknown");

  if (session?.isStale && status === "start" && (phase === "session" || phase === "recording")) {
    return {
      ...event,
      meta: {
        ...(event.meta || {}),
        status: "cancelled",
        reason:
          typeof event.meta?.reason === "string" && event.meta.reason.trim()
            ? event.meta.reason
            : "stale_unfinished_trace",
      },
    };
  }

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

export function getTraceSessionDisplayTimestamp(
  session: Pick<CallTraceSession, "startedAt" | "updatedAt">
): string | null {
  return session.startedAt || session.updatedAt;
}

export function buildPhaseTimeline(
  events: CallTraceEvent[],
  session: CallTraceSession | null
): CallTraceTimelineItem[] {
  const phaseBuckets = new Map<string, CallTraceEvent[]>();
  const displayEvents = events.map((event) => getDisplayEvent(event, session));

  for (const event of displayEvents) {
    const phase = String(event.meta?.phase || "session");
    const bucket = phaseBuckets.get(phase) || [];
    bucket.push(event);
    phaseBuckets.set(phase, bucket);
  }

  const reasoningEvents = (phaseBuckets.get("reasoning") || [])
    .slice()
    .sort((a, b) => getEventTimestampMs(a) - getEventTimestampMs(b));

  return TRACE_PHASE_ORDER.map((phase) => {
    const phaseEvents = phaseBuckets.get(phase);
    if (!phaseEvents?.length) return null;

    const sortedEvents = phaseEvents
      .slice()
      .sort((a, b) => getEventTimestampMs(a) - getEventTimestampMs(b));
    const startEvent =
      sortedEvents.find((event) => String(event.meta?.status || "unknown") === "start") ||
      sortedEvents[0];
    const terminalEvent = sortedEvents
      .slice()
      .reverse()
      .find((event) => TERMINAL_TRACE_STATUSES.has(String(event.meta?.status || "unknown")));
    const event = terminalEvent || sortedEvents[sortedEvents.length - 1];
    const startedAt = getEventTimestamp(startEvent);
    let completedAt = terminalEvent ? getEventTimestamp(terminalEvent) : null;

    // Batch transcription helpers include the optional AI pass before returning,
    // so their legacy "transcription success" event is emitted after reasoning.
    // The first reasoning event is the real boundary where speech-to-text ended.
    if (phase === "transcription" && event.meta?.status === "success") {
      const startedAtMs = Date.parse(startedAt);
      const completedAtMs = completedAt ? Date.parse(completedAt) : Number.POSITIVE_INFINITY;
      const reasoningBoundary = reasoningEvents.find((reasoningEvent) => {
        const boundaryMs = getEventTimestampMs(reasoningEvent);
        return boundaryMs >= startedAtMs && boundaryMs <= completedAtMs;
      });
      if (reasoningBoundary) {
        completedAt = getEventTimestamp(reasoningBoundary);
      }
    }

    return { event, startedAt, completedAt };
  }).filter(Boolean) as CallTraceTimelineItem[];
}
