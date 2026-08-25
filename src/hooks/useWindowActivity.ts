import { useEffect } from "react";

export const WINDOW_ACTIVITY_IDLE_MS = 15_000;

export type WindowActivityState = "active" | "idle" | "background" | "hidden";

interface WindowActivityOptions {
  idleAfterMs?: number;
}

/**
 * Publishes a cheap renderer-local activity state for CSS-only work.
 * Electron keeps visible, unfocused windows composited on macOS, so a page
 * with decorative infinite animations can otherwise keep the GPU busy while
 * the user is working in another app. Functional state and IPC remain live;
 * only presentation code consumes this attribute.
 */
export function useWindowActivity(options: WindowActivityOptions = {}): void {
  const idleAfterMs = Math.max(1000, Number(options.idleAfterMs) || WINDOW_ACTIVITY_IDLE_MS);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    const root = document.documentElement;
    const previousState = root.dataset.windowActivity;
    let idleTimer: number | null = null;
    let lastPointerActivityAt = 0;
    let lastActivityAt = Date.now();

    const clearIdleTimer = () => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const setState = (state: WindowActivityState) => {
      if (root.dataset.windowActivity !== state) {
        root.dataset.windowActivity = state;
      }
    };

    const scheduleIdleTransition = () => {
      clearIdleTimer();
      const remainingMs = Math.max(0, idleAfterMs - (Date.now() - lastActivityAt));
      idleTimer = window.setTimeout(() => {
        idleTimer = null;
        if (document.visibilityState !== "visible") {
          setState("hidden");
          return;
        }

        const elapsedMs = Date.now() - lastActivityAt;
        if (elapsedMs >= idleAfterMs) {
          setState("idle");
        } else {
          scheduleIdleTransition();
        }
      }, remainingMs);
    };

    const markActive = () => {
      lastActivityAt = Date.now();
      if (document.visibilityState !== "visible") {
        setState("hidden");
        clearIdleTimer();
        return;
      }
      setState("active");
      scheduleIdleTransition();
    };

    const handlePointerMove = () => {
      const now = Date.now();
      if (now - lastPointerActivityAt < 1000) return;
      lastPointerActivityAt = now;
      markActive();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        markActive();
      } else {
        setState("hidden");
        clearIdleTimer();
      }
    };

    const handleWindowBlur = () => {
      if (document.visibilityState === "visible") {
        setState("background");
      }
      clearIdleTimer();
    };

    const activityEvents: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
    ];
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, markActive, { passive: true });
    }
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("focus", markActive);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    setState(document.visibilityState === "visible" ? "active" : "hidden");
    scheduleIdleTransition();

    return () => {
      clearIdleTimer();
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, markActive);
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("focus", markActive);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      if (previousState === undefined) {
        delete root.dataset.windowActivity;
      } else {
        root.dataset.windowActivity = previousState;
      }
    };
  }, [idleAfterMs]);
}
