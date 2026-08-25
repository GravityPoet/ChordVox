// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowDrag } from "./useWindowDrag";

describe("useWindowDrag", () => {
  let container;
  let root;
  let hookValue;
  let startWindowDrag;
  let stopWindowDrag;

  function TestComponent() {
    hookValue = useWindowDrag();
    return null;
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    startWindowDrag = vi.fn().mockResolvedValue({ success: true });
    stopWindowDrag = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { startWindowDrag, stopWindowDrag },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<TestComponent />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("stops a drag even when press, movement, and release share one React turn", () => {
    act(() => {
      hookValue.startDragging();
      hookValue.stopDragging();
    });

    expect(startWindowDrag).toHaveBeenCalledTimes(1);
    expect(stopWindowDrag).toHaveBeenCalledTimes(1);
    expect(hookValue.isDragging).toBe(false);
  });

  it("starts the main-process drag loop only once before React rerenders", () => {
    act(() => {
      hookValue.startDragging();
      hookValue.startDragging();
    });

    expect(startWindowDrag).toHaveBeenCalledTimes(1);
  });

  it("stops an active drag when movement reports that the primary button is released", () => {
    act(() => hookValue.startDragging());
    act(() => window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0 })));

    expect(stopWindowDrag).toHaveBeenCalledTimes(1);
    expect(hookValue.isDragging).toBe(false);
  });

  it("stops an active drag when the renderer loses focus", () => {
    act(() => hookValue.startDragging());
    act(() => window.dispatchEvent(new Event("blur")));

    expect(stopWindowDrag).toHaveBeenCalledTimes(1);
    expect(hookValue.isDragging).toBe(false);
  });
});
