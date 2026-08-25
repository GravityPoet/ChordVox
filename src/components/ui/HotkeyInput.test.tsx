// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { HotkeyInput } from "./HotkeyInput";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("HotkeyInput keyboard access", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setHotkeyListeningMode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    setHotkeyListeningMode = vi.fn();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getPlatform: () => "darwin",
        setHotkeyListeningMode,
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("does not capture on focus and preserves Tab navigation", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<HotkeyInput value="GLOBE" onChange={onChange} />));
    const input = container.querySelector('[role="button"]') as HTMLDivElement;

    await act(async () => input.focus());
    expect(input.getAttribute("aria-pressed")).toBe("false");
    expect(setHotkeyListeningMode).not.toHaveBeenCalledWith(true, null, "primary");

    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(tabEvent));
    expect(tabEvent.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("exposes the configured shortcut and a visible keyboard focus style", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<HotkeyInput value="GLOBE" onChange={onChange} />));
    const input = container.querySelector('[role="button"]') as HTMLDivElement;

    expect(input.getAttribute("aria-label")).toContain("Globe/Fn");
    expect(input.className).toContain("focus-visible:ring-2");
    expect(input.getAttribute("aria-disabled")).toBe("false");
  });

  it("starts explicitly, preserves Escape shortcuts, and lets Tab cancel", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<HotkeyInput value="GLOBE" onChange={onChange} />));
    const input = container.querySelector('[role="button"]') as HTMLDivElement;

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(input.getAttribute("aria-pressed")).toBe("true");
    expect(setHotkeyListeningMode).toHaveBeenCalledWith(true, null, "primary");

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(input.getAttribute("aria-pressed")).toBe("false");
    expect(onChange).toHaveBeenCalledWith("Esc");
    expect(setHotkeyListeningMode).toHaveBeenLastCalledWith(false, null, "primary");

    await act(async () => input.click());
    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(tabEvent));
    expect(tabEvent.defaultPrevented).toBe(false);
    expect(input.getAttribute("aria-pressed")).toBe("false");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
