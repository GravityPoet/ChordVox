import { useEffect } from "react";

const NATIVE_GLASS_METHODS = new Set(["liquid-glass", "vibrancy", "acrylic"]);

function applyNativeGlassMethod(method?: string): void {
  if (typeof document === "undefined") return;

  if (method && NATIVE_GLASS_METHODS.has(method)) {
    document.documentElement.setAttribute("data-native-glass", method);
    return;
  }

  document.documentElement.removeAttribute("data-native-glass");
}

export function useNativeGlassCapability(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;

    let disposed = false;

    window.electronAPI
      ?.getNativeGlassCapability?.()
      ?.then?.((capability: { method?: string }) => {
        if (!disposed) {
          applyNativeGlassMethod(capability?.method);
        }
      })
      ?.catch?.(() => {
        if (!disposed) {
          applyNativeGlassMethod(undefined);
        }
      });

    const dispose = window.electronAPI?.onNativeGlassCapability?.(
      (payload: { method?: string }) => {
        applyNativeGlassMethod(payload?.method);
      }
    );

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [enabled]);
}
