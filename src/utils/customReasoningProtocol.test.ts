import { describe, it, expect } from "vitest";
import {
  normalizeCustomReasoningProtocol,
  CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL,
} from "./customReasoningProtocol";

describe("constants", () => {
  it("locks the custom gemini generate content protocol constant", () => {
    expect(CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL).toBe("gemini-generate-content");
  });
});

describe("normalizeCustomReasoningProtocol", () => {
  it("preserves valid protocols", () => {
    expect(normalizeCustomReasoningProtocol("chat")).toBe("chat");
    expect(normalizeCustomReasoningProtocol("responses")).toBe("responses");
    expect(normalizeCustomReasoningProtocol("gemini-generate-content")).toBe(
      "gemini-generate-content"
    );
  });

  it("normalizes invalid protocols to auto", () => {
    expect(normalizeCustomReasoningProtocol("invalid")).toBe("auto");
    expect(normalizeCustomReasoningProtocol("auto")).toBe("auto");
    expect(normalizeCustomReasoningProtocol("")).toBe("auto");
    expect(normalizeCustomReasoningProtocol(null)).toBe("auto");
    expect(normalizeCustomReasoningProtocol(undefined)).toBe("auto");
    expect(normalizeCustomReasoningProtocol(123)).toBe("auto");
    expect(normalizeCustomReasoningProtocol({})).toBe("auto");
  });
});
