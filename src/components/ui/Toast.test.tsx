// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "./Toast";
import { useToast } from "./toastContext";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function ToastTrigger() {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast({ title: "Saved", duration: 4000 })}>
      Show
    </button>
  );
}

describe("Toast hover timing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("subtracts only active display time across repeated hovers", async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <ToastTrigger />
        </ToastProvider>
      );
    });
    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const toast = container.querySelector('[role="status"]') as HTMLElement;
    expect(toast).toBeTruthy();

    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => toast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(500));
    await act(async () => toast.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));

    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => toast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(500));
    await act(async () => toast.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));

    await act(async () => vi.advanceTimersByTime(1600));
    expect(container.querySelector('[role="status"]')).toBeTruthy();

    await act(async () => vi.advanceTimersByTime(400));
    expect(container.querySelector('[role="status"]')?.className).toContain("opacity-0");
    await act(async () => vi.advanceTimersByTime(200));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
