// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { Mic } from "lucide-react";
import PermissionCard from "./PermissionCard";
import { Toggle } from "./toggle";
import ModelCardList from "./ModelCardList";
import { ToastProvider } from "./Toast";
import { useToast } from "./toastContext";
import ApiKeyInput from "./ApiKeyInput";
import WindowControls from "../WindowControls";
import { ActivationModeSelector } from "./ActivationModeSelector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function ToastHarness() {
  const { toast } = useToast();

  return (
    <>
      <button
        type="button"
        data-toast-kind="success"
        onClick={() => toast({ title: "Saved", variant: "success", duration: 0 })}
      >
        Success
      </button>
      <button
        type="button"
        data-toast-kind="error"
        onClick={() => toast({ title: "Failed", variant: "destructive", duration: 0 })}
      >
        Error
      </button>
    </>
  );
}

describe("accessible settings controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("exposes toggle name, switch role, state, and next value", async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(<Toggle checked={false} onChange={onChange} ariaLabel="Usage analytics" />);
    });

    const toggle = container.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-label")).toBe("Usage analytics");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.type).toBe("button");

    await act(async () => {
      toggle.click();
    });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("announces the selected activation mode", async () => {
    await act(async () => {
      root.render(<ActivationModeSelector value="tap" onChange={vi.fn()} variant="compact" />);
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });

  it("shows a readable granted state and names the settings-only action", async () => {
    const onRequest = vi.fn();
    const onOpenSettings = vi.fn();

    await act(async () => {
      root.render(
        <PermissionCard
          icon={Mic}
          title="Microphone"
          description="Required for dictation"
          granted={true}
          onRequest={onRequest}
          onOpenSettings={onOpenSettings}
        />
      );
    });
    expect(container.textContent).toContain("common.complete");

    await act(async () => {
      root.render(
        <PermissionCard
          icon={Mic}
          title="Microphone"
          description="Required for dictation"
          granted={false}
          onRequest={onRequest}
          onOpenSettings={onOpenSettings}
        />
      );
    });
    expect(container.querySelector('button[aria-label="common.openSystemSettings"]')).toBeTruthy();
  });

  it("lets keyboard users select a model and exposes the hidden delete action", async () => {
    const onModelSelect = vi.fn();
    const onDelete = vi.fn();

    await act(async () => {
      root.render(
        <ModelCardList
          models={[{ value: "local-model", label: "Local Model", isDownloaded: true }]}
          selectedModel=""
          onModelSelect={onModelSelect}
          onDownload={vi.fn()}
          onDelete={onDelete}
        />
      );
    });

    const modelCard = container.querySelector(
      '[role="button"][aria-label="Local Model"]'
    ) as HTMLDivElement;
    expect(modelCard.tabIndex).toBe(0);

    await act(async () => {
      modelCard.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onModelSelect).toHaveBeenCalledWith("local-model");

    const deleteButton = container.querySelector(
      'button[aria-label="common.delete: Local Model"]'
    ) as HTMLButtonElement;
    expect(deleteButton.className).toContain("group-focus-within:opacity-100");

    await act(async () => {
      deleteButton.click();
    });
    expect(onDelete).toHaveBeenCalledWith("local-model");
  });

  it("announces regular and destructive toast updates with the right urgency", async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <ToastHarness />
        </ToastProvider>
      );
    });

    await act(async () => {
      (container.querySelector('[data-toast-kind="success"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");

    await act(async () => {
      (container.querySelector('[data-toast-kind="error"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[role="alert"]')?.getAttribute("aria-live")).toBe("assertive");
  });

  it("associates API key labels and help text with the protected input", async () => {
    await act(async () => {
      root.render(
        <ApiKeyInput
          apiKey="secret"
          setApiKey={vi.fn()}
          provider="openai"
          label="OpenAI API Key"
          helpText="Stored on this device"
        />
      );
    });

    const input = container.querySelector('input[name="openaiApiKey"]') as HTMLInputElement;
    const label = container.querySelector("label") as HTMLLabelElement;
    const helpText = container.querySelector("p") as HTMLParagraphElement;

    expect(label.htmlFor).toBe(input.id);
    expect(input.getAttribute("aria-describedby")).toBe(helpText.id);
    expect(input.autocomplete).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(container.querySelector(".text-success")).toBeNull();
  });

  it("alerts the user when a window action fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        windowIsMaximized: vi.fn().mockResolvedValue(false),
        windowMinimize: vi.fn().mockRejectedValue(new Error("IPC unavailable")),
        windowMaximize: vi.fn().mockResolvedValue(undefined),
        windowClose: vi.fn().mockResolvedValue(undefined),
      },
    });

    try {
      await act(async () => {
        root.render(
          <ToastProvider>
            <WindowControls />
          </ToastProvider>
        );
      });

      await act(async () => {
        (
          container.querySelector(
            'button[aria-label="windowControls.minimize"]'
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
      });

      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("windowControls.actionFailedTitle");
    } finally {
      consoleError.mockRestore();
      Reflect.deleteProperty(window, "electronAPI");
    }
  });
});
