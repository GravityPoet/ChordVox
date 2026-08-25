import { describe, expect, it } from "vitest";

import { getDictationWindowSize } from "./dictationWindowLayout";

describe("getDictationWindowSize", () => {
  it.each([
    ["flow", { width: 504, height: 104 }],
    ["stardust", { width: 504, height: 104 }],
    ["nebula", { width: 320, height: 180 }],
  ] as const)("keeps the %s overlay on its configured fixed bounds", (style, expected) => {
    expect(getDictationWindowSize(style)).toEqual(expected);
  });

  it("maps the legacy planet style to the nebula bounds", () => {
    expect(getDictationWindowSize("planet")).toEqual({ width: 320, height: 180 });
  });
});
