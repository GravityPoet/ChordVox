import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  WINDOW_SIZES,
  clampVisiblePanelPosition,
  clampRestoredPanelPosition,
  clampWindowPositionToWorkArea,
  getDictationWindowSize,
  getMainWindowAnchorHeight,
  getMainWindowResizePosition,
  normalizeDictationAnimationStyle,
} = require("./windowConfig");

describe("dictation window layout", () => {
  it.each([
    ["flow", { width: 504, height: 104 }],
    ["stardust", { width: 504, height: 104 }],
    ["nebula", { width: 320, height: 180 }],
  ])("provides stable main-process bounds for %s", (style, expected) => {
    expect(getDictationWindowSize(style)).toEqual(expected);
  });

  it("uses the shared style sizes for pre-show fallbacks", () => {
    expect(WINDOW_SIZES.ACTIVE).toEqual(getDictationWindowSize("flow"));
    expect(WINDOW_SIZES.NEBULA).toEqual(getDictationWindowSize("nebula"));
    expect(normalizeDictationAnimationStyle("unknown")).toBe("nebula");
  });

  it("uses the real window height for its persisted visual anchor", () => {
    expect(getMainWindowAnchorHeight({ width: 320, height: 180 })).toBe(180);
  });

  it("keeps ordinary overlay resizes bottom-anchored", () => {
    expect(getMainWindowResizePosition({ width: 560, height: 520 }, 651, 750)).toEqual({
      anchorHeight: 520,
      position: { x: 371, y: 230 },
    });
  });

  it("keeps floating windows above the Dock work area before they are shown", () => {
    const workArea = { x: 0, y: 25, width: 1352, height: 775 };

    expect(
      clampWindowPositionToWorkArea({ x: 593, y: 698 }, { width: 320, height: 180 }, workArea)
    ).toEqual({ x: 593, y: 620 });
  });

  it("allows a visible floating window to use the full display below the Dock work area", () => {
    const displayBounds = { x: 0, y: 0, width: 1352, height: 900 };

    expect(
      clampVisiblePanelPosition(
        { x: 593, y: 720 },
        { width: 320, height: 180 },
        { x: 0, y: 25, width: 1352, height: 775 },
        displayBounds
      )
    ).toEqual({ x: 593, y: 720 });
  });

  it("keeps legacy saved positions above the Dock after the overlay fills its window", () => {
    expect(
      clampRestoredPanelPosition(
        { x: 593, y: 720 },
        { width: 320, height: 180 },
        { x: 0, y: 25, width: 1352, height: 775 },
        { x: 0, y: 0, width: 1352, height: 900 },
        0,
        "darwin"
      )
    ).toEqual({ x: 593, y: 620 });
  });

  it("preserves full-display drag positions saved by the corrected overlay layout", () => {
    expect(
      clampRestoredPanelPosition(
        { x: 593, y: 720 },
        { width: 320, height: 180 },
        { x: 0, y: 25, width: 1352, height: 775 },
        { x: 0, y: 0, width: 1352, height: 900 },
        2,
        "darwin"
      )
    ).toEqual({ x: 593, y: 720 });
  });

  it("still keeps a visible panel below the menu bar while allowing the lower edge", () => {
    expect(
      clampVisiblePanelPosition(
        { x: 593, y: -100 },
        { width: 320, height: 180 },
        { x: 0, y: 25, width: 1352, height: 775 },
        { x: 0, y: 0, width: 1352, height: 900 }
      )
    ).toEqual({ x: 593, y: 25 });
  });

  it("rounds fractional DIP positions emitted on scaled displays", () => {
    expect(
      clampVisiblePanelPosition(
        { x: 593.6, y: 719.5 },
        { width: 320, height: 180 },
        { x: 0, y: 25, width: 1352, height: 775 },
        { x: 0, y: 0, width: 1352, height: 900 }
      )
    ).toEqual({ x: 594, y: 720 });
  });

  it("keeps the overlay inside a secondary display with a negative origin", () => {
    const displayBounds = { x: -2560, y: 0, width: 2560, height: 1440 };
    const workArea = { x: -2560, y: 25, width: 2560, height: 1415 };

    expect(
      clampVisiblePanelPosition(
        { x: -2800, y: 1400 },
        { width: 320, height: 180 },
        workArea,
        displayBounds
      )
    ).toEqual({ x: -2560, y: 1260 });
    expect(
      clampVisiblePanelPosition(
        { x: 200, y: -50 },
        { width: 320, height: 180 },
        workArea,
        displayBounds
      )
    ).toEqual({ x: -320, y: 25 });
  });

  it.each([
    [
      "left Dock",
      { x: 80, y: 25, width: 3360, height: 1415 },
      { x: -40, y: 2000 },
      { x: 80, y: 1260 },
    ],
    [
      "right Dock",
      { x: 0, y: 25, width: 3360, height: 1415 },
      { x: 4000, y: 2000 },
      { x: 3040, y: 1260 },
    ],
  ])("respects the %s work-area inset", (_label, workArea, position, expected) => {
    expect(
      clampVisiblePanelPosition(position, { width: 320, height: 180 }, workArea, {
        x: 0,
        y: 0,
        width: 3440,
        height: 1440,
      })
    ).toEqual(expected);
  });
});
