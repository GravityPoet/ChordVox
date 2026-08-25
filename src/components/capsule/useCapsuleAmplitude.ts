import * as React from "react";

import type { CapsuleState } from "./types";
import { useAnimationFrameGate } from "../../hooks/useAnimationFrameGate";

interface Options {
  level: number;
  state: CapsuleState;
  target: React.RefObject<HTMLElement | null>;
}

const ATTACK = 0.7;
const RELEASE = 0.22;
const NEBULA_LIGHT_KNEE = 0.5;
const NEBULA_LIGHT_HIGH_RANGE_SCALE = 0.64;

function getAmplitudeSource(level: number, state: CapsuleState): number {
  const active = state === "recording" || state === "starting";
  const clamped = active ? Math.min(Math.max(level, 0), 1) : 0;
  return Math.pow(clamped, 0.75);
}

export function getNebulaLightAmplitude(value: number): number {
  const clamped = Math.min(Math.max(value, 0), 1);
  if (clamped <= NEBULA_LIGHT_KNEE) {
    return clamped;
  }

  return NEBULA_LIGHT_KNEE + (clamped - NEBULA_LIGHT_KNEE) * NEBULA_LIGHT_HIGH_RANGE_SCALE;
}

export function useCapsuleAmplitude({ level, state, target }: Options) {
  const valueRef = React.useRef(0);
  const rafRef = React.useRef<number | null>(null);
  const levelRef = React.useRef(level);
  const stateRef = React.useRef(state);
  levelRef.current = level;
  stateRef.current = state;

  const shouldAnimate = useAnimationFrameGate(state === "recording" || state === "starting");

  const writeAmplitude = React.useCallback(
    (value: number) => {
      const element = target.current;
      if (!element) return;

      element.style.setProperty("--dv-amp", value.toFixed(3));
      element.style.setProperty("--dv-amp-soft", (value * 0.6 + 0.4).toFixed(3));
      element.style.setProperty("--dv-nebula-light-amp", getNebulaLightAmplitude(value).toFixed(3));
    },
    [target]
  );

  React.useEffect(() => {
    if (shouldAnimate) return;

    const source = getAmplitudeSource(level, state);
    valueRef.current = source;
    writeAmplitude(source);
  }, [level, shouldAnimate, state, writeAmplitude]);

  React.useEffect(() => {
    if (!shouldAnimate) {
      return undefined;
    }

    const tick = () => {
      // Perceptual curve: lift quiet speech into the visible range without
      // clipping loud peaks (0.2 -> 0.30, 0.5 -> 0.59, 1 -> 1).
      const source = getAmplitudeSource(levelRef.current, stateRef.current);
      const easing = source > valueRef.current ? ATTACK : RELEASE;
      valueRef.current += (source - valueRef.current) * easing;

      writeAmplitude(valueRef.current);

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [shouldAnimate, writeAmplitude]);
}
