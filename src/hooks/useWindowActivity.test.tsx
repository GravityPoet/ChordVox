// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useWindowActivity } from "./useWindowActivity";

function Probe() {
  useWindowActivity();
  return null;
}

describe("useWindowActivity", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete document.documentElement.dataset.windowActivity;
    vi.useRealTimers();
  });

  it("parks decorative work after inactivity and wakes on interaction", async () => {
    await act(async () => root.render(<Probe />));
    expect(document.documentElement.dataset.windowActivity).toBe("active");

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(document.documentElement.dataset.windowActivity).toBe("idle");

    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    expect(document.documentElement.dataset.windowActivity).toBe("active");
  });

  it("marks a visible window as background when it loses focus", async () => {
    await act(async () => root.render(<Probe />));

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(document.documentElement.dataset.windowActivity).toBe("background");
  });
});
