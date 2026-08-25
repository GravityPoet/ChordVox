import { describe, expect, it } from "vitest";
import { resolveDictationPromptMode } from "./prompts";

describe("dictation prompt mode", () => {
  it("uses fast cleanup for ordinary dictation", () => {
    expect(resolveDictationPromptMode("明天下午四点开会。", "ChordVox", false)).toBe(
      "fast-cleanup"
    );
  });

  it("keeps direct agent requests on the balanced prompt", () => {
    expect(resolveDictationPromptMode("ChordVox，请把这句话翻译成英文。", "ChordVox", false)).toBe(
      "default"
    );
  });

  it("keeps advanced workflows on the balanced prompt", () => {
    expect(resolveDictationPromptMode("整理这段内容。", "ChordVox", true)).toBe("default");
  });
});
