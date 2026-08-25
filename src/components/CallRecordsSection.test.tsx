import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getFriendlyModelDisplayValue,
  getTraceSessionListTitle,
} from "../utils/callRecordsDisplay";

describe("CallRecordsSection customer-facing summaries", () => {
  it("shows a friendly transcription model name", () => {
    expect(getFriendlyModelDisplayValue("paraformer", "paraformer-large-zh", "transcription")).toBe(
      "Paraformer-Large"
    );
  });

  it("uses a readable time title instead of the internal run ID", () => {
    const title = getTraceSessionListTitle("听写记录", "2026-07-12T01:09:59.000Z");

    expect(title).toContain("听写记录 ·");
    expect(title).not.toContain("mrgmdsp3-boj1tx");
    const source = readFileSync(new URL("./CallRecordsSection.tsx", import.meta.url), "utf8");
    expect(source).not.toContain(">{selectedSession.runId}<");
  });
});
