// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { ContextSettingsSection } from "./ContextSettingsSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        "settingsPage.context.sensitiveAppsChoose": "Choose apps",
        "settingsPage.context.sensitiveAppsSelected": "Added apps",
        "settingsPage.context.sensitiveAppsAdvanced": "Advanced",
        "settingsPage.context.sensitiveAppsSaved": "Saved",
        "settingsPage.context.sensitiveAppsSaveFailed": "Could not save",
        "settingsPage.context.sensitiveAppsHint": "Choose apps automatically",
        "common.delete": "Delete",
      };
      return labels[key] || key;
    },
  }),
}));

describe("ContextSettingsSection sensitive app picker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setSensitiveApps: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setSensitiveApps = vi.fn().mockResolvedValue({ success: true });

    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getPlatform: () => "darwin",
        getContextSettings: vi.fn().mockResolvedValue({
          enabled: false,
          textEnabled: false,
          visionEnabled: false,
          sensitiveApps: {
            processNames: ["1Password"],
            bundleIds: ["com.agilebits.onepassword"],
            selectedApps: [{ appName: "1Password", bundleId: "com.agilebits.onepassword" }],
          },
        }),
        checkContextPermissions: vi.fn().mockResolvedValue({
          accessibility: false,
          screenRecording: false,
          platform: "darwin",
        }),
        pickSensitiveApps: vi.fn().mockResolvedValue({
          success: true,
          apps: [{ appName: "Notes", bundleId: "com.apple.Notes" }],
        }),
        setSensitiveApps,
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("adds a chosen macOS app and saves its name and bundle ID automatically", async () => {
    await act(async () => {
      root.render(
        <ContextSettingsSection
          contextEnabled={false}
          setContextEnabled={vi.fn()}
          reasoningModel=""
          reasoningProvider="openai"
          openaiApiKey=""
          anthropicApiKey=""
          geminiApiKey=""
          openrouterApiKey=""
          customReasoningApiKey=""
        />
      );
      await Promise.resolve();
    });

    const chooseButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Choose apps")
    );
    expect(chooseButton).toBeTruthy();

    await act(async () => {
      chooseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setSensitiveApps).toHaveBeenCalledWith(
      expect.objectContaining({
        processNames: ["1Password", "Notes"],
        bundleIds: ["com.agilebits.onepassword", "com.apple.Notes"],
        selectedApps: expect.arrayContaining([{ appName: "Notes", bundleId: "com.apple.Notes" }]),
      })
    );
    expect(container.textContent).toContain("Notes");
  });

  it("leaves the saving state and shows an error if the native picker rejects", async () => {
    vi.mocked(window.electronAPI!.pickSensitiveApps!).mockRejectedValueOnce(
      new Error("picker unavailable")
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      root.render(
        <ContextSettingsSection
          contextEnabled={false}
          setContextEnabled={vi.fn()}
          reasoningModel=""
          reasoningProvider="openai"
          openaiApiKey=""
          anthropicApiKey=""
          geminiApiKey=""
          openrouterApiKey=""
          customReasoningApiKey=""
        />
      );
      await Promise.resolve();
    });

    const chooseButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Choose apps")
    );
    await act(async () => {
      chooseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Could not save");
    expect(chooseButton?.hasAttribute("disabled")).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to choose sensitive apps:",
      expect.any(Error)
    );
    consoleError.mockRestore();
  });
});
