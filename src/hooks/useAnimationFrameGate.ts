import { useEffect, useState } from "react";

function readReducedMotionPreference(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function readDocumentVisibility(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Shared gate for requestAnimationFrame work. Hidden documents and users who
 * request reduced motion should not pay for a visual animation loop.
 */
export function useAnimationFrameGate(active: boolean): boolean {
  const [isDocumentVisible, setIsDocumentVisible] = useState(readDocumentVisibility);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(readReducedMotionPreference);

  useEffect(() => {
    if (typeof document === "undefined") {
      return undefined;
    }

    const handleVisibilityChange = () => {
      setIsDocumentVisible(readDocumentVisibility());
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const mediaQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const handleMotionChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    if (mediaQuery?.addEventListener) {
      mediaQuery.addEventListener("change", handleMotionChange);
    } else if (mediaQuery?.addListener) {
      mediaQuery.addListener(handleMotionChange);
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (mediaQuery?.removeEventListener) {
        mediaQuery.removeEventListener("change", handleMotionChange);
      } else if (mediaQuery?.removeListener) {
        mediaQuery.removeListener(handleMotionChange);
      }
    };
  }, []);

  return active && isDocumentVisible && !prefersReducedMotion;
}
