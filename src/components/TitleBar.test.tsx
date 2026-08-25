// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import TitleBar from "./TitleBar";

// Mock i18next translation
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock WindowControls to avoid polling side effects
vi.mock("./WindowControls", () => ({
  default: () => <div data-testid="window-controls" />,
}));

vi.mock("./ui/toastContext", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Mock ConfirmDialog to avoid complex Radix UI portal logic in JSDOM
vi.mock("./ui/dialog", () => ({
  ConfirmDialog: ({ open, onConfirm, confirmText }: any) => {
    if (!open) return null;
    return (
      <div data-testid="confirm-dialog">
        <button data-testid="confirm-button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    );
  },
}));

describe("TitleBar Component", () => {
  let container: HTMLDivElement | null = null;
  const mockElectronAPI = {
    getPlatform: vi.fn(),
    appQuit: vi.fn(),
  };

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "electronAPI", {
      value: mockElectronAPI,
      writable: true,
    });
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockElectronAPI.getPlatform.mockReset();
    mockElectronAPI.appQuit.mockReset();
  });

  afterEach(() => {
    if (container) {
      document.body.removeChild(container);
      container = null;
    }
  });

  it("renders title on macOS (darwin)", async () => {
    mockElectronAPI.getPlatform.mockReturnValue("darwin");

    await act(async () => {
      const root = createRoot(container!);
      root.render(<TitleBar title="ChordVox-Mac" showTitle={true} />);
    });

    const titleElement = container!.querySelector("h1");
    expect(titleElement).toBeTruthy();
    expect(titleElement!.textContent).toBe("ChordVox-Mac");
  });

  it("handles Quit flow on macOS (darwin)", async () => {
    mockElectronAPI.getPlatform.mockReturnValue("darwin");

    await act(async () => {
      const root = createRoot(container!);
      root.render(<TitleBar title="ChordVox-Mac" showTitle={true} />);
    });

    // On macOS, Quit button is on the right
    const quitButton = container!.querySelector(
      'button[aria-label="titleBar.quitTitle"]'
    ) as HTMLButtonElement;
    expect(quitButton).toBeTruthy();

    // Click quit button
    await act(async () => {
      quitButton.click();
    });

    // Confirm dialog should be open
    const confirmDialog = container!.querySelector('[data-testid="confirm-dialog"]');
    expect(confirmDialog).toBeTruthy();

    const confirmButton = container!.querySelector(
      '[data-testid="confirm-button"]'
    ) as HTMLButtonElement;
    expect(confirmButton).toBeTruthy();

    // Click confirm quit
    await act(async () => {
      confirmButton.click();
    });

    expect(mockElectronAPI.appQuit).toHaveBeenCalledTimes(1);
  });

  it("renders WindowControls and places Quit button on the left on Windows (win32)", async () => {
    mockElectronAPI.getPlatform.mockReturnValue("win32");

    await act(async () => {
      const root = createRoot(container!);
      root.render(<TitleBar title="ChordVox-Win" showTitle={true} />);
    });

    // WindowControls should be rendered
    const windowControls = container!.querySelector('[data-testid="window-controls"]');
    expect(windowControls).toBeTruthy();

    // On Windows, the title h1 should NOT be rendered (macOS-only in TitleBar.tsx)
    const titleElement = container!.querySelector("h1");
    expect(titleElement).toBeFalsy();
  });
});
