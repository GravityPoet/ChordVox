import { describe, it, expect } from "vitest";
import {
  normalizeRecordingAnimationStyle,
  isRecordingAnimationStyleValue,
  RECORDING_ANIMATION_STYLE_VALUES,
  DEFAULT_RECORDING_ANIMATION_STYLE,
} from "./recordingAnimationStyle";

describe("constants", () => {
  it("locks recording animation style values and default", () => {
    expect(RECORDING_ANIMATION_STYLE_VALUES).toEqual(["flow", "stardust", "nebula"]);
    expect(DEFAULT_RECORDING_ANIMATION_STYLE).toBe("nebula");
  });
});

describe("normalizeRecordingAnimationStyle", () => {
  it("maps valid and legacy styles to current options", () => {
    expect(normalizeRecordingAnimationStyle("flow")).toBe("flow");
    expect(normalizeRecordingAnimationStyle("stardust")).toBe("stardust");
    expect(normalizeRecordingAnimationStyle("nebula")).toBe("nebula");

    expect(normalizeRecordingAnimationStyle("level")).toBe("flow");
    expect(normalizeRecordingAnimationStyle("line")).toBe("flow");
    expect(normalizeRecordingAnimationStyle("liquid")).toBe("flow");
    expect(normalizeRecordingAnimationStyle("particles")).toBe("stardust");
    expect(normalizeRecordingAnimationStyle("planet")).toBe("nebula");
  });

  it("falls back to default for invalid string values", () => {
    expect(normalizeRecordingAnimationStyle("invalid-style")).toBe(
      DEFAULT_RECORDING_ANIMATION_STYLE
    );
    expect(normalizeRecordingAnimationStyle("")).toBe(DEFAULT_RECORDING_ANIMATION_STYLE);
  });

  it("falls back to default for non-string values", () => {
    expect(normalizeRecordingAnimationStyle(null)).toBe(DEFAULT_RECORDING_ANIMATION_STYLE);
    expect(normalizeRecordingAnimationStyle(undefined)).toBe(DEFAULT_RECORDING_ANIMATION_STYLE);
    expect(normalizeRecordingAnimationStyle(123)).toBe(DEFAULT_RECORDING_ANIMATION_STYLE);
    expect(normalizeRecordingAnimationStyle({})).toBe(DEFAULT_RECORDING_ANIMATION_STYLE);
  });
});

describe("isRecordingAnimationStyleValue", () => {
  it("returns true for valid style values", () => {
    expect(isRecordingAnimationStyleValue("flow")).toBe(true);
    expect(isRecordingAnimationStyleValue("stardust")).toBe(true);
    expect(isRecordingAnimationStyleValue("nebula")).toBe(true);
  });

  it("returns false for invalid style values", () => {
    expect(isRecordingAnimationStyleValue("invalid-style")).toBe(false);
    expect(isRecordingAnimationStyleValue("level")).toBe(false);
    expect(isRecordingAnimationStyleValue("")).toBe(false);
    expect(isRecordingAnimationStyleValue(null)).toBe(false);
    expect(isRecordingAnimationStyleValue(123)).toBe(false);
  });
});
