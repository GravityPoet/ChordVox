// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExternalLinkHandler, openExternalLink } from "./externalLinks";

describe("external link helpers", () => {
  const openExternal = vi.fn();

  beforeEach(() => {
    openExternal.mockReset();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { openExternal },
    });
  });

  it("asks the main process to show a visible error and returns the real result", async () => {
    openExternal.mockResolvedValue({ success: false, error: "browser unavailable" });

    await expect(openExternalLink("https://chordvox.com/guide")).resolves.toEqual({
      success: false,
      error: "browser unavailable",
    });
    expect(openExternal).toHaveBeenCalledWith("https://chordvox.com/guide", {
      showError: true,
    });
  });

  it("waits for the result when used as a click handler", async () => {
    openExternal.mockResolvedValue({ success: true });
    const preventDefault = vi.fn();

    await createExternalLinkHandler("https://chordvox.com/guide")({
      preventDefault,
    } as unknown as React.MouseEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledOnce();
  });
});
