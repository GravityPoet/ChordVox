import { describe, it, expect, vi, beforeEach } from "vitest";
import i18next from "i18next";
import { getTranscriptionModeCopy } from "./transcriptionModeCopy";

describe("getTranscriptionModeCopy", () => {
  const tMock = vi.fn();

  beforeEach(() => {
    tMock.mockReset();
    tMock.mockImplementation((key, options) => {
      if (options && typeof options === "object" && "defaultModelName" in options) {
        return `${key}(defaultModelName:${options.defaultModelName})`;
      }
      return key;
    });

    vi.spyOn(i18next, "getFixedT").mockReturnValue(tMock as any);
  });

  it("calls getFixedT with the specified language", () => {
    getTranscriptionModeCopy("zh-CN");
    expect(i18next.getFixedT).toHaveBeenCalledWith("zh-CN");
  });

  it("calls getFixedT with undefined if no language is specified", () => {
    getTranscriptionModeCopy();
    expect(i18next.getFixedT).toHaveBeenCalledWith(undefined);
  });

  it("returns correct i18n keys for transcription mode copy structures", () => {
    const copy = getTranscriptionModeCopy("en", "MyModel");

    expect(copy.realTime.label).toBe("transcriptionModes.realTime.label");
    expect(copy.realTime.defaultEnabledDescription).toBe(
      "transcriptionModes.realTime.defaultEnabledDescription(defaultModelName:MyModel)"
    );
    expect(copy.highAccuracy.label).toBe("transcriptionModes.highAccuracy.label");
  });

  it("uses 'Recommended' as fallback when defaultStreamingModelName is omitted", () => {
    const copy = getTranscriptionModeCopy("en");

    expect(copy.realTime.defaultEnabledDescription).toBe(
      "transcriptionModes.realTime.defaultEnabledDescription(defaultModelName:Recommended)"
    );
  });
});
