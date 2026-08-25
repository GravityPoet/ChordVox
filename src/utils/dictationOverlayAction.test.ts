import { describe, expect, it } from "vitest";

import { getDictationOverlayPrimaryAction } from "./dictationOverlayAction";

const idleState = {
  isRecording: false,
  isStreaming: false,
  isStarting: false,
  isProcessing: false,
  isPastePending: false,
};

describe("getDictationOverlayPrimaryAction", () => {
  it.each([
    ["recording", { isRecording: true }],
    ["streaming", { isStreaming: true }],
    ["streaming while final state catches up", { isStreaming: true, isProcessing: true }],
  ])("stops %s through the recording stop path", (_label, state) => {
    expect(getDictationOverlayPrimaryAction({ ...idleState, ...state })).toBe("stop-recording");
  });

  it("cancels startup instead of sending a stop to an inactive recorder", () => {
    expect(getDictationOverlayPrimaryAction({ ...idleState, isStarting: true })).toBe(
      "cancel-start"
    );
  });

  it("stops an active recorder when the starting flag is clearing asynchronously", () => {
    expect(
      getDictationOverlayPrimaryAction({
        ...idleState,
        isStarting: true,
        isRecording: true,
      })
    ).toBe("stop-recording");
  });

  it("cancels a pending paste through its dedicated path", () => {
    expect(getDictationOverlayPrimaryAction({ ...idleState, isPastePending: true })).toBe(
      "cancel-paste"
    );
  });

  it("uses processing cancellation only after recording has stopped", () => {
    expect(getDictationOverlayPrimaryAction({ ...idleState, isProcessing: true })).toBe(
      "cancel-processing"
    );
  });

  it("toggles listening while idle", () => {
    expect(getDictationOverlayPrimaryAction(idleState)).toBe("toggle-listening");
  });
});
