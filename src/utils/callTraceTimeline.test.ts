import { describe, expect, it } from "vitest";
import type { CallTraceEvent } from "../types/electron";
import { buildPhaseTimeline, getTraceSessionDisplayTimestamp } from "./callTraceTimeline";

type TracePhase = NonNullable<CallTraceEvent["meta"]>["phase"];
type TraceStatus = NonNullable<CallTraceEvent["meta"]>["status"];

function traceEvent(
  id: string,
  timestamp: string,
  phase: TracePhase,
  status: TraceStatus
): CallTraceEvent {
  return {
    id,
    timestamp,
    level: "info",
    message: "CALL_TRACE",
    scope: "call-trace",
    source: "renderer",
    meta: { runId: "run-1", phase, status },
  };
}

describe("call trace timeline", () => {
  it("uses the run start time as the record display time", () => {
    expect(
      getTraceSessionDisplayTimestamp({
        startedAt: "2026-07-17T11:50:03.100Z",
        updatedAt: "2026-07-17T11:50:13.200Z",
      })
    ).toBe("2026-07-17T11:50:03.100Z");
  });

  it("builds real phase ranges instead of assigning the final second to every phase", () => {
    const events = [
      traceEvent("session-start", "2026-07-17T11:50:03.100Z", "session", "start"),
      traceEvent("recording-start", "2026-07-17T11:50:03.110Z", "recording", "start"),
      traceEvent("recording-success", "2026-07-17T11:50:03.500Z", "recording", "success"),
      traceEvent("transcription-start", "2026-07-17T11:50:03.510Z", "transcription", "start"),
      traceEvent("reasoning-start", "2026-07-17T11:50:05.810Z", "reasoning", "start"),
      traceEvent("reasoning-success", "2026-07-17T11:50:13.110Z", "reasoning", "success"),
      // The current pipeline reports transcription success only after the nested
      // reasoning call returns. The timeline must not treat this as STT completion.
      traceEvent("transcription-success", "2026-07-17T11:50:13.120Z", "transcription", "success"),
      traceEvent("paste-start", "2026-07-17T11:50:13.130Z", "paste", "start"),
      traceEvent("paste-success", "2026-07-17T11:50:13.160Z", "paste", "success"),
      traceEvent("session-success", "2026-07-17T11:50:13.170Z", "session", "success"),
    ];

    const timeline = buildPhaseTimeline(events, null);
    const byPhase = new Map(
      timeline.map((item) => [String(item.event.meta?.phase || "session"), item])
    );

    expect(byPhase.get("transcription")).toMatchObject({
      startedAt: "2026-07-17T11:50:03.510Z",
      completedAt: "2026-07-17T11:50:05.810Z",
    });
    expect(byPhase.get("reasoning")).toMatchObject({
      startedAt: "2026-07-17T11:50:05.810Z",
      completedAt: "2026-07-17T11:50:13.110Z",
    });
    expect(byPhase.get("paste")).toMatchObject({
      startedAt: "2026-07-17T11:50:13.130Z",
      completedAt: "2026-07-17T11:50:13.160Z",
    });
    expect(byPhase.get("session")).toMatchObject({
      startedAt: "2026-07-17T11:50:03.100Z",
      completedAt: "2026-07-17T11:50:13.170Z",
    });
  });

  it("keeps an instantaneous skipped phase as a single timestamp", () => {
    const skippedAt = "2026-07-17T11:50:05.810Z";
    const [item] = buildPhaseTimeline(
      [traceEvent("reasoning-skipped", skippedAt, "reasoning", "skipped")],
      null
    );

    expect(item).toMatchObject({ startedAt: skippedAt, completedAt: skippedAt });
  });
});
