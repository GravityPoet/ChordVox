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

  it("fills the available settings viewport instead of capping desktop diagnostics at 520px", () => {
    const source = readFileSync(new URL("./CallRecordsSection.tsx", import.meta.url), "utf8");
    const sidebarSource = readFileSync(new URL("./ui/SidebarModal.tsx", import.meta.url), "utf8");

    expect(source).toContain('className="flex min-h-0 flex-1 flex-col gap-6"');
    expect(
      source.match(/max-h-\[520px\] overflow-y-auto md:min-h-0 md:flex-1 md:max-h-none/g)
    ).toHaveLength(2);
    expect(sidebarSource).toContain("section-entrance flex min-h-full flex-col");
  });
});
