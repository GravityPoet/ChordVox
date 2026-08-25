// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { HotkeyWorkflow, SecondaryHotkeyProfile } from "../../hooks/useSettings";
import { HotkeysSection, type HotkeysSectionProps } from "./HotkeysSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options: Record<string, unknown> = {}) => {
      const labels: Record<string, string> = {
        "settingsPage.general.hotkey.title": "Main dictation hotkey",
        "settingsPage.general.hotkey.description": "Start and stop normal dictation",
        "settingsPage.general.hotkey.secondary.workflowsTitle": "Shortcut workflows",
        "settingsPage.general.hotkey.secondary.workflowsDescription": "Create several actions",
        "settingsPage.general.hotkey.secondary.requiresProTitle": "Workflows require Pro",
        "settingsPage.general.hotkey.secondary.requiresProDescription": "Unlock many workflows",
        "settingsPage.general.hotkey.secondary.actions.dictate.title": "Dictate",
        "settingsPage.general.hotkey.secondary.actions.dictate.description": "Speech to text",
        "settingsPage.general.hotkey.secondary.actions.translate.title": "Translate",
        "settingsPage.general.hotkey.secondary.actions.translate.description":
          "Speak and translate",
        "settingsPage.general.hotkey.secondary.actions.polish.title": "Polish",
        "settingsPage.general.hotkey.secondary.actions.polish.description": "Ready to send",
        "settingsPage.general.hotkey.secondary.actions.chat.title": "Ask AI",
        "settingsPage.general.hotkey.secondary.actions.chat.description": "Speak a question",
        "settingsPage.general.hotkey.secondary.addWorkflow": "Add workflow",
        "settingsPage.general.hotkey.secondary.emptyTitle": "Add your first workflow",
        "settingsPage.general.hotkey.secondary.emptyDescription": "Pick a task and shortcut",
        "settingsPage.general.hotkey.secondary.newWorkflow": "New workflow",
        "settingsPage.general.hotkey.secondary.editWorkflow": "Edit workflow",
        "settingsPage.general.hotkey.secondary.editorDescription": "Choose what this shortcut does",
        "settingsPage.general.hotkey.secondary.cancelEdit": "Cancel",
        "settingsPage.general.hotkey.secondary.chooseAction": "1 Choose a task",
        "settingsPage.general.hotkey.secondary.workflowName": "Name",
        "settingsPage.general.hotkey.secondary.targetLanguage": "Target language",
        "settingsPage.general.hotkey.secondary.shortcut": "2 Choose a shortcut",
        "settingsPage.general.hotkey.secondary.modelsForWorkflow": "3 Choose models",
        "settingsPage.general.hotkey.secondary.modelsDescription": "Each workflow keeps its models",
        "settingsPage.general.hotkey.secondary.useCurrentModels": "Use current models",
        "settingsPage.general.hotkey.secondary.transcriptionModel": "Transcription model",
        "settingsPage.general.hotkey.secondary.reasoningModel": "AI model",
        "settingsPage.general.hotkey.secondary.chooseTranscriptionModel": "Choose transcription",
        "settingsPage.general.hotkey.secondary.chooseReasoningModel": "Choose AI model",
        "settingsPage.general.hotkey.secondary.saveWorkflow": "Save workflow",
        "settingsPage.general.hotkey.secondary.deleteWorkflow": "Delete workflow",
        "settingsPage.general.hotkey.secondary.aiModelRequired": "Choose an AI model first",
        "settingsPage.general.hotkey.secondary.duplicateHotkey": "Shortcut already used",
        "settingsPage.general.hotkey.secondary.profileSavedTranscriptionSummary": `Transcription: ${options.provider || "Local"} / ${options.model || "Model"}`,
        "settingsPage.general.hotkey.secondary.profileSavedReasoningSummary": `AI: ${options.provider || "OpenAI"} / ${options.model || "Model"}`,
        "settingsPage.general.hotkey.secondary.profileSavedReasoningDisabled": "AI off",
        "settingsPage.general.hotkey.secondary.profileSavedReasoningDisabledWithModel": "AI off",
        "settingsPage.account.checkout.upgradeToPro": "Upgrade",
        "settingsPage.general.hotkey.activationMode": "Activation mode",
      };
      return labels[key] || key;
    },
  }),
}));

vi.mock("../ui/HotkeyInput", () => ({
  HotkeyInput: ({ captureScope, value }: { captureScope: string; value: string }) => (
    <div data-testid={`hotkey-${captureScope}`}>{value || "empty"}</div>
  ),
}));

vi.mock("../ui/ActivationModeSelector", () => ({
  ActivationModeSelector: () => <div data-testid="activation-mode" />,
}));

vi.mock("../../utils/platform", () => ({ getPlatform: () => "darwin" }));
vi.mock("../../utils/hotkeys", () => ({ formatHotkeyLabel: (value: string) => value }));

const currentProfile: SecondaryHotkeyProfile = {
  useLocalWhisper: true,
  useLocalStreaming: true,
  localStreamingModelId: "nemotron-streaming-en-0.6b",
  localTranscriptionProvider: "paraformer",
  whisperModel: "whisper",
  parakeetModel: "parakeet",
  paraformerModel: "paraformer-large-zh",
  graniteModel: "granite",
  cohereModel: "cohere",
  graniteRuntimeUrl: "",
  graniteRuntimeApiKey: "",
  cohereRuntimeUrl: "",
  cohereRuntimeApiKey: "",
  allowOpenAIFallback: false,
  allowLocalFallback: false,
  fallbackWhisperModel: "whisper",
  preferredLanguage: "auto",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "gpt-4o-mini-transcribe",
  cloudTranscriptionBaseUrl: "",
  useReasoningModel: true,
  reasoningModel: "gpt-4o-mini",
  reasoningProvider: "openai",
  cloudReasoningMode: "byok",
};

const createProps = (overrides: Partial<HotkeysSectionProps> = {}): HotkeysSectionProps => ({
  dictationKey: "GLOBE",
  onPrimaryHotkeyChange: vi.fn().mockResolvedValue(true),
  isPrimaryHotkeyRegistering: false,
  validatePrimaryHotkey: () => null,
  workflows: [],
  currentProfile,
  onSaveWorkflows: vi.fn().mockResolvedValue(true),
  isSavingWorkflows: false,
  validateWorkflowHotkey: () => null,
  isWorkflowFeatureLocked: false,
  trialOfferAvailable: false,
  onUnlockWorkflows: vi.fn().mockResolvedValue(true),
  onOpenTranscriptionSettings: vi.fn(),
  onOpenAiModelsSettings: vi.fn(),
  isUsingGnomeHotkeys: true,
  activationMode: "tap",
  setActivationMode: vi.fn(),
  showConfirmDialog: vi.fn(),
  ...overrides,
});

describe("HotkeysSection workflow onboarding", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows the four concrete Pro outcomes instead of a vague Profile 2", async () => {
    await act(async () =>
      root.render(<HotkeysSection {...createProps({ isWorkflowFeatureLocked: true })} />)
    );

    expect(container.textContent).toContain("Workflows require Pro");
    expect(container.textContent).toContain("Dictate");
    expect(container.textContent).toContain("Translate");
    expect(container.textContent).toContain("Polish");
    expect(container.textContent).toContain("Ask AI");
    expect(container.textContent).not.toContain("Profile 2");
  });

  it("starts with one obvious add action and then asks the user to choose a task", async () => {
    await act(async () => root.render(<HotkeysSection {...createProps()} />));
    expect(container.textContent).toContain("Add your first workflow");

    const addButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add workflow")
    );
    await act(async () => addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.textContent).toContain("1 Choose a task");
    expect(container.textContent).toContain("2 Choose a shortcut");
    expect(container.textContent).toContain("3 Choose models");
  });

  it("keeps direct dictation free of AI after switching between workflow actions", async () => {
    const onSaveWorkflows = vi.fn().mockResolvedValue(true);
    await act(async () => root.render(<HotkeysSection {...createProps({ onSaveWorkflows })} />));

    const addButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add workflow")
    );
    await act(async () => addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const translateButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Translate")
    );
    const dictateButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Dictate")
    );
    await act(async () =>
      translateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await act(async () => dictateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save workflow")
    );
    await act(async () => saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const saved = onSaveWorkflows.mock.calls[0]?.[0] as HotkeyWorkflow[];
    expect(saved[0]?.action).toBe("dictate");
    expect(saved[0]?.profile.useReasoningModel).toBe(false);
    expect(saved[0]?.profile.useLocalStreaming).toBe(true);
    expect(saved[0]?.profile.localStreamingModelId).toBe("nemotron-streaming-en-0.6b");
  });

  it("renders several independently named workflows with their own hotkeys", async () => {
    const workflows: HotkeyWorkflow[] = [
      {
        id: "workflow-translate",
        name: "Translate to English",
        hotkey: "Command+Shift+7",
        action: "translate",
        targetLanguage: "en",
        enabled: true,
        profile: currentProfile,
      },
      {
        id: "workflow-chat",
        name: "Ask AI",
        hotkey: "Command+Shift+8",
        action: "chat",
        targetLanguage: "en",
        enabled: true,
        profile: currentProfile,
      },
    ];
    await act(async () => root.render(<HotkeysSection {...createProps({ workflows })} />));

    expect(container.textContent).toContain("Translate to English");
    expect(container.textContent).toContain("Command+Shift+7");
    expect(container.textContent).toContain("Ask AI");
    expect(container.textContent).toContain("Command+Shift+8");
  });

  it("confirms before deleting a saved workflow", async () => {
    const workflow: HotkeyWorkflow = {
      id: "workflow-translate",
      name: "Translate to English",
      hotkey: "Command+Shift+7",
      action: "translate",
      targetLanguage: "en",
      enabled: true,
      profile: currentProfile,
    };
    const onSaveWorkflows = vi.fn().mockResolvedValue(true);
    const showConfirmDialog = vi.fn();
    await act(async () =>
      root.render(
        <HotkeysSection
          {...createProps({ workflows: [workflow], onSaveWorkflows, showConfirmDialog })}
        />
      )
    );

    const deleteButton = container.querySelector(
      'button[aria-label="Delete workflow"]'
    ) as HTMLButtonElement;
    await act(async () => deleteButton.click());

    expect(onSaveWorkflows).not.toHaveBeenCalled();
    expect(showConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete workflow",
        description: "Translate to English · Command+Shift+7",
        variant: "destructive",
        onConfirm: expect.any(Function),
      })
    );

    await act(async () => {
      showConfirmDialog.mock.calls[0][0].onConfirm();
      await Promise.resolve();
    });
    expect(onSaveWorkflows).toHaveBeenCalledWith([]);
  });
});
