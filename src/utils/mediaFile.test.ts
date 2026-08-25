import { describe, expect, it } from "vitest";
import { isSupportedMediaFile } from "./mediaFile";

describe("isSupportedMediaFile", () => {
  it("accepts audio and video MIME types", () => {
    expect(isSupportedMediaFile({ name: "recording.bin", type: "audio/wav" })).toBe(true);
    expect(isSupportedMediaFile({ name: "meeting.bin", type: "video/mp4" })).toBe(true);
  });

  it("uses the extension when drag-and-drop does not provide a MIME type", () => {
    expect(isSupportedMediaFile({ name: "meeting.M4A", type: "" })).toBe(true);
    expect(isSupportedMediaFile({ name: "screen-recording.mkv", type: "" })).toBe(true);
  });

  it("rejects unrelated files", () => {
    expect(isSupportedMediaFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
    expect(isSupportedMediaFile({ name: "archive.zip", type: "" })).toBe(false);
  });
});
