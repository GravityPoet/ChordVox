import { describe, expect, it } from "vitest";
import { getDictationNoticeOverlayAction } from "./dictationNoticeLifecycle";

const idleState = {
  isBusy: false,
  isCommandMenuOpen: false,
  licenseLimitDialogOpen: false,
};

describe("getDictationNoticeOverlayAction", () => {
  it("suppresses the idle capsule while a completion notice owns the window", () => {
    expect(
      getDictationNoticeOverlayAction({
        ...idleState,
        previousToastCount: 0,
        toastCount: 1,
      })
    ).toBe("suppress-capsule");
  });

  it("hides the window as soon as the final completion notice closes", () => {
    expect(
      getDictationNoticeOverlayAction({
        ...idleState,
        previousToastCount: 1,
        toastCount: 0,
      })
    ).toBe("hide-window");
  });

  it("does not hide a new active dictation when an older notice closes", () => {
    expect(
      getDictationNoticeOverlayAction({
        ...idleState,
        previousToastCount: 1,
        toastCount: 0,
        isBusy: true,
      })
    ).toBe("none");
  });
});
