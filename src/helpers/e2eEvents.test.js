import { describe, expect, it } from "vitest";
import { createE2eEventRecorder, getE2eStubTranscriptionText, isE2eMode } from "./e2eEvents";

describe("e2eEvents", () => {
  it("enables E2E mode only for unpackaged test runs", () => {
    expect(isE2eMode({ isPackaged: false }, { CHORDVOX_E2E: "1" })).toBe(true);
    expect(isE2eMode({ isPackaged: true }, { CHORDVOX_E2E: "1" })).toBe(false);
    expect(isE2eMode({ isPackaged: false }, { CHORDVOX_E2E: "0" })).toBe(false);
  });

  it("records events only when explicitly enabled", () => {
    const enabledTarget = {};
    createE2eEventRecorder(true, enabledTarget)("paste-text", { text: "hello" });
    expect(enabledTarget.__CHORDVOX_E2E_EVENTS).toMatchObject([
      {
        type: "paste-text",
        payload: { text: "hello" },
      },
    ]);

    const disabledTarget = {};
    createE2eEventRecorder(false, disabledTarget)("paste-text", { text: "hello" });
    expect(disabledTarget.__CHORDVOX_E2E_EVENTS).toBeUndefined();
  });

  it("uses an explicit transcription fixture when provided", () => {
    expect(getE2eStubTranscriptionText({ CHORDVOX_E2E_TRANSCRIPTION_TEXT: "fixture" })).toBe(
      "fixture"
    );
    expect(getE2eStubTranscriptionText({})).toBe("ChordVox E2E stub transcription.");
  });
});
