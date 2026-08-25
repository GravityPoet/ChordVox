import { useCallback, useEffect, useRef, useState } from "react";

export const useWindowDrag = () => {
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);

  const startDragging = useCallback(() => {
    if (isDraggingRef.current) return;
    isDraggingRef.current = true;
    setIsDragging(true);
    void window.electronAPI.startWindowDrag?.();
  }, []);

  const stopDragging = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);
    void window.electronAPI.stopWindowDrag?.();
  }, []);

  useEffect(() => {
    const handleRelease = () => stopDragging();
    const handleMove = (event) => {
      if (isDraggingRef.current && (event.buttons & 1) === 0) {
        stopDragging();
      }
    };
    const handleVisibilityChange = () => {
      if (document.hidden) stopDragging();
    };

    window.addEventListener("mouseup", handleRelease, true);
    window.addEventListener("pointerup", handleRelease, true);
    window.addEventListener("pointercancel", handleRelease, true);
    window.addEventListener("mousemove", handleMove, true);
    window.addEventListener("pointermove", handleMove, true);
    window.addEventListener("blur", handleRelease);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("mouseup", handleRelease, true);
      window.removeEventListener("pointerup", handleRelease, true);
      window.removeEventListener("pointercancel", handleRelease, true);
      window.removeEventListener("mousemove", handleMove, true);
      window.removeEventListener("pointermove", handleMove, true);
      window.removeEventListener("blur", handleRelease);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        void window.electronAPI.stopWindowDrag?.();
      }
    };
  }, [stopDragging]);

  return {
    isDragging,
    startDragging,
    stopDragging,
  };
};
