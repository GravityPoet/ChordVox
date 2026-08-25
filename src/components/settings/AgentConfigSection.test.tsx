// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { AgentConfigSection } from "./AgentConfigSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        "settingsPage.agentConfig.styleRules.pickAppsTitle": "Choose apps for writing styles",
        "settingsPage.agentConfig.styleRules.chooseApps": "Choose apps",
        "settingsPage.agentConfig.styleRules.addRule": "Add rule",
        "settingsPage.agentConfig.styleRules.changeApp": "Change app",
        "settingsPage.agentConfig.styleRules.advancedMatcher": "Advanced",
        "settingsPage.agentConfig.styleRules.pickAppsFailed": "Could not choose apps",
        "settingsPage.agentConfig.styleRules.manualAdd": "Add manually",
        "settingsPage.agentConfig.styleRules.emptyRules": "No rules",
        "settingsPage.agentConfig.styleRules.styleKeyCasual": "Casual",
        "settingsPage.agentConfig.styleRules.styleKeyProfessional": "Professional",
        "settingsPage.agentConfig.styleRules.styleKeyTechnical": "Technical",
        "settingsPage.agentConfig.styleRules.styleKeyCustom": "Custom",
        "settingsPage.agentConfig.styleRules.delete": "Delete",
      };
      return labels[key] || key;
    },
  }),
}));

describe("AgentConfigSection app picker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, String(value)),
      },
    });
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getPlatform: () => "darwin",
        pickSensitiveApps: vi.fn().mockResolvedValue({
          success: true,
          apps: [{ appName: "Notes", bundleId: "com.apple.Notes" }],
        }),
      },
    });
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const renderSection = async () => {
    await act(async () => {
      root.render(
        <AgentConfigSection
          agentName="Nova"
          agentNameInput="Nova"
          setAgentNameInput={vi.fn()}
          onSaveAgentName={vi.fn()}
          dictionaryManager={null}
        />
      );
      await Promise.resolve();
    });
  };

  it("creates a polishing rule from a native app selection without manual bundle input", async () => {
    await renderSection();
    const chooseButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Choose apps"
    );

    await act(async () => {
      chooseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.electronAPI?.pickSensitiveApps).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Notes");
    expect(JSON.parse(localStorage.getItem("appPolishStyleRules") || "[]")).toEqual([
      {
        displayName: "Notes",
        match: { bundleIdPrefix: "com.apple.Notes" },
        styleKey: "casual",
      },
    ]);
    expect(container.querySelector('input[name="styleRuleMatchValue-0"]')).toBeTruthy();
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("returns the picker button to an enabled state when the native chooser fails", async () => {
    vi.mocked(window.electronAPI!.pickSensitiveApps!).mockRejectedValueOnce(
      new Error("picker unavailable")
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderSection();
    const chooseButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Choose apps"
    );

    await act(async () => {
      chooseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(chooseButton?.hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("Could not choose apps");

    const manualButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add manually"
    );
    await act(async () => {
      manualButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('input[name="styleRuleMatchValue-0"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Could not choose apps");
  });

  it("keeps existing rules editable without offering an unavailable change-app action", async () => {
    localStorage.setItem(
      "appPolishStyleRules",
      JSON.stringify([
        {
          displayName: "Notepad",
          match: { appNameContains: "Notepad" },
          styleKey: "casual",
        },
      ])
    );
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getPlatform: () => "win32",
      },
    });

    await renderSection();

    expect(container.textContent).not.toContain("Change app");
    expect(container.textContent).toContain("Add rule");
    expect(container.querySelector('input[name="styleRuleMatchValue-0"]')).toBeTruthy();
  });
});
