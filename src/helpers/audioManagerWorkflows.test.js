// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

let AudioManager;

const storage = new (class {
  constructor() {
    this.data = new Map();
  }
  getItem(key) {
    return this.data.get(key) ?? null;
  }
  setItem(key, value) {
    this.data.set(key, String(value));
  }
  removeItem(key) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
})();

const profile = {
  useLocalWhisper: true,
  useLocalStreaming: true,
  localStreamingModelId: "nemotron-streaming-en-0.6b",
  localTranscriptionProvider: "paraformer",
  paraformerModel: "paraformer-large-zh",
  useReasoningModel: false,
  reasoningProvider: "openai",
  reasoningModel: "gpt-4o-mini",
  cloudReasoningMode: "byok",
};

describe("AudioManager shortcut workflows", () => {
  beforeAll(async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    AudioManager = (await import("./audioManager")).default;
  });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("useReasoningModel", "false");
    localStorage.setItem("reasoningModel", "global-model");
  });

  it("uses the selected workflow profile and forces AI for translation", () => {
    localStorage.setItem(
      "hotkeyWorkflowsV1",
      JSON.stringify([
        {
          id: "workflow-translate",
          hotkey: "Command+Shift+7",
          action: "translate",
          targetLanguage: "ja",
          enabled: true,
          profile,
        },
      ])
    );
    const manager = new AudioManager();

    manager.setActiveHotkeyProfile("workflow-translate");

    expect(manager.getStringSetting("reasoningModel", "")).toBe("gpt-4o-mini");
    expect(manager.getBooleanSetting("useReasoningModel", false)).toBe(true);
    expect(manager.shouldUseLocalStreaming()).toBe(true);
    expect(manager.getLocalStreamingModelId()).toBe("nemotron-streaming-en-0.6b");
    expect(manager.getWorkflowSystemPrompt()).toContain("Japanese");
    expect(manager.getWorkflowSystemPrompt()).toContain("Output only the translated text");
  });

  it("gives polish and chat distinct output behavior", () => {
    localStorage.setItem(
      "hotkeyWorkflowsV1",
      JSON.stringify([
        {
          id: "workflow-polish",
          hotkey: "Command+Shift+8",
          action: "polish",
          enabled: true,
          profile,
        },
        {
          id: "workflow-chat",
          hotkey: "Command+Shift+9",
          action: "chat",
          enabled: true,
          profile,
        },
      ])
    );
    const manager = new AudioManager();

    manager.setActiveHotkeyProfile("workflow-polish");
    expect(manager.getWorkflowSystemPrompt()).toContain("ready-to-send writing");

    manager.setActiveHotkeyProfile("workflow-chat");
    expect(manager.getWorkflowSystemPrompt()).toContain("Answer it directly");
    const chatPrompt = manager.getReasoningPrompt("", "summarize this", "default", {
      contextAppName: "Notes",
      contextText: "Screen reference",
    });
    expect(chatPrompt).toContain("Optional current-app context");
    expect(chatPrompt).not.toContain("Only rewrite the text the user just spoke");
  });

  it("keeps normal dictation on the primary profile", () => {
    localStorage.setItem("useLocalStreaming", "false");
    localStorage.setItem("localStreamingModelId", "zipformer-ctc-zh-large-fp16");
    const manager = new AudioManager();

    manager.setActiveHotkeyProfile("not-a-real-workflow");

    expect(manager.activeHotkeyProfileId).toBe("primary");
    expect(manager.getWorkflowSystemPrompt()).toBeNull();
    expect(manager.getBooleanSetting("useReasoningModel", false)).toBe(false);
    expect(manager.shouldUseLocalStreaming()).toBe(false);
    expect(manager.getLocalStreamingModelId()).toBe("zipformer-ctc-zh-large-fp16");
  });
});
