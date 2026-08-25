import * as React from "react";
import { useAnimationFrameGate } from "../../hooks/useAnimationFrameGate";

const MAX_TILT_DEG = 1.4;
const MAX_SHIFT = 1.0;
const LERP = 0.14;

export function useCapsuleParallax(target: React.RefObject<HTMLElement | null>) {
  const valuesRef = React.useRef({ mx: 0, my: 0, tx: 0, ty: 0 });
  const rafRef = React.useRef<number | null>(null);
  const animationAllowed = useAnimationFrameGate(true);

  React.useEffect(() => {
    const cancelFrame = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    if (!animationAllowed) {
      valuesRef.current = { mx: 0, my: 0, tx: 0, ty: 0 };
      cancelFrame();
      const element = target.current;
      element?.style.setProperty("--dv-mx", "0");
      element?.style.setProperty("--dv-my", "0");
      return undefined;
    }

    const handleMove = (event: PointerEvent) => {
      const element = target.current;
      if (!element) return;

      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const proximity = 260;
      const deltaX = (event.clientX - centerX) / proximity;
      const deltaY = (event.clientY - centerY) / proximity;

      valuesRef.current.tx = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, deltaX));
      valuesRef.current.ty = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, deltaY));
    };

    const handleLeave = () => {
      valuesRef.current.tx = 0;
      valuesRef.current.ty = 0;
    };

    window.addEventListener("pointermove", handleMove, { passive: true });
    window.addEventListener("pointerleave", handleLeave);

    const tick = () => {
      const values = valuesRef.current;
      values.mx += (values.tx - values.mx) * LERP;
      values.my += (values.ty - values.my) * LERP;

      const element = target.current;
      if (element) {
        element.style.setProperty("--dv-mx", values.mx.toFixed(3));
        element.style.setProperty("--dv-my", values.my.toFixed(3));
        element.style.setProperty("--dv-tilt-deg", `${MAX_TILT_DEG}deg`);
      }

      const settled =
        Math.abs(values.tx - values.mx) < 0.001 && Math.abs(values.ty - values.my) < 0.001;
      rafRef.current = settled ? null : requestAnimationFrame(tick);
    };

    const scheduleFrame = () => {
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    const handleMoveWithScheduling = (event: PointerEvent) => {
      handleMove(event);
      scheduleFrame();
    };

    const handleLeaveWithScheduling = () => {
      handleLeave();
      scheduleFrame();
    };

    window.addEventListener("pointermove", handleMoveWithScheduling, { passive: true });
    window.addEventListener("pointerleave", handleLeaveWithScheduling);

    return () => {
      window.removeEventListener("pointermove", handleMoveWithScheduling);
      window.removeEventListener("pointerleave", handleLeaveWithScheduling);

      cancelFrame();
    };
  }, [animationAllowed, target]);
}
