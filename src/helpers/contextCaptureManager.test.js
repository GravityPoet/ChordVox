import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ContextCaptureManager = require("./contextCaptureManager");

describe("ContextCaptureManager sensitive app configuration", () => {
  let manager;

  beforeEach(() => {
    manager = new ContextCaptureManager();
    manager.readContextSettingsFile = vi.fn(() => ({}));
    manager.writeContextSettingsFile = vi.fn();
  });

  it("preserves an explicitly cleared selected-app list", () => {
    const result = manager.saveSensitiveApps({
      processNames: ["Notes"],
      bundleIds: ["com.apple.Notes"],
      selectedApps: [],
    });

    expect(result).toEqual({ success: true });
    expect(manager.getSensitiveApps()).toEqual({
      processNames: ["Notes"],
      bundleIds: ["com.apple.Notes"],
      selectedApps: [],
    });
  });

  it("reconstructs display metadata only for legacy configs without selectedApps", () => {
    manager.saveSensitiveApps({
      processNames: ["Notes"],
      bundleIds: ["com.apple.Notes"],
    });

    expect(manager.getSensitiveApps().selectedApps).toEqual(
      expect.arrayContaining([expect.objectContaining({ appName: "Notes" })])
    );
  });
});
