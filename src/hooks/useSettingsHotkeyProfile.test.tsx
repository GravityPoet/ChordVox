// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsProvider, type SettingsValue, useSettings } from "./useSettings";
import { writeLocalStorageValue } from "./useLocalStorage";

vi.mock("../i18n", () => ({
  default: {
    language: "en",
    changeLanguage: vi.fn().mockResolvedValue(undefined),
  },
  normalizeUiLanguage: (value: unknown) =>
    String(value || "en").startsWith("zh") ? "zh-CN" : "en",
}));

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const storage = new MemoryStorage();

describe("useSettings current hotkey profile", () => {
  let container: HTMLDivElement;
  let root: Root;
  let currentSettings: SettingsValue | undefined;

  function Probe() {
    currentSettings = useSettings();
    return null;
  }

  beforeAll(() => {
    for (const target of [window, globalThis]) {
      Object.defineProperty(target, "localStorage", {
        configurable: true,
        value: storage,
      });
    }
  });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("onboardingCompleted", "true");
    localStorage.setItem("uiLanguage", "en");
    localStorage.setItem("useLocalStreaming", "false");
    localStorage.setItem("localStreamingModelId", "zipformer-ctc-zh-large-fp16");
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: undefined,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    currentSettings = undefined;
    localStorage.clear();
  });

  it("updates new workflow defaults when the streaming mode or model changes", async () => {
    await act(async () => {
      root.render(
        <SettingsProvider>
          <Probe />
        </SettingsProvider>
      );
    });

    expect(currentSettings?.currentHotkeyProfile.useLocalStreaming).toBe(false);
    expect(currentSettings?.currentHotkeyProfile.localStreamingModelId).toBe(
      "zipformer-ctc-zh-large-fp16"
    );

    await act(async () => {
      writeLocalStorageValue("useLocalStreaming", "true");
      writeLocalStorageValue("localStreamingModelId", "nemotron-streaming-en-0.6b");
    });

    expect(currentSettings?.currentHotkeyProfile.useLocalStreaming).toBe(true);
    expect(currentSettings?.currentHotkeyProfile.localStreamingModelId).toBe(
      "nemotron-streaming-en-0.6b"
    );
  });
});
