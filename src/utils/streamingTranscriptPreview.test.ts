import { describe, expect, it } from "vitest";

import { shouldShowNebulaStreamingPreview } from "./streamingTranscriptPreview";

const activeStreamingState = {
  animationStyle: "nebula" as const,
  dictationStage: "recording" as const,
  isRecording: true,
  isStreaming: true,
};

describe("shouldShowNebulaStreamingPreview", () => {
  it("shows only after the nebula enters an actual streaming recording", () => {
    expect(shouldShowNebulaStreamingPreview(activeStreamingState)).toBe(true);
  });

  it("stays hidden for high-accuracy batch recording", () => {
    expect(
      shouldShowNebulaStreamingPreview({
        ...activeStreamingState,
        isStreaming: false,
      })
    ).toBe(false);
  });

  it("hides as soon as the stop action moves streaming into transcription", () => {
    expect(
      shouldShowNebulaStreamingPreview({
        ...activeStreamingState,
        dictationStage: "transcribing",
        isRecording: false,
      })
    ).toBe(false);
  });

  it.each(["flow", "stardust"] as const)(
    "does not duplicate the existing in-capsule preview for %s",
    (animationStyle) => {
      expect(
        shouldShowNebulaStreamingPreview({
          ...activeStreamingState,
          animationStyle,
        })
      ).toBe(false);
    }
  );
});
