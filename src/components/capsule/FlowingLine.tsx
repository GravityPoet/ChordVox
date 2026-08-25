import * as React from "react";

import type { CapsuleState } from "./types";

interface FlowingLineProps {
  level: number;
  state: CapsuleState;
}

const VIEW_W = 132;
const VIEW_H = 42;
const SAMPLES = 32;
const FREQUENCY = 5;

interface FlowPoint {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getEnergy(level: number, state: CapsuleState): number {
  if (state !== "recording") return 0;
  return Math.pow(clamp(level, 0, 1), 0.55);
}

function getAmplitude(level: number, state: CapsuleState): number {
  const energy = getEnergy(level, state);

  switch (state) {
    case "recording":
      return 3 + energy * 17;
    case "processing":
      return 7;
    case "success":
      return 4;
    case "starting":
      return 5;
    case "error":
      return 3;
    case "idle":
    default:
      return 2.5;
  }
}

function getPhase(level: number, state: CapsuleState): number {
  const energy = getEnergy(level, state);

  switch (state) {
    case "recording":
      return energy * 3.2;
    case "processing":
      return 0.65;
    case "success":
      return 0.2;
    case "starting":
      return 0.35;
    case "error":
      return 0.1;
    case "idle":
    default:
      return 0;
  }
}

function computePoints(level: number, state: CapsuleState): FlowPoint[] {
  const center = VIEW_H / 2;
  const amplitude = getAmplitude(level, state);
  const phase = getPhase(level, state);
  const points: FlowPoint[] = [];

  for (let index = 0; index < SAMPLES; index += 1) {
    const t = index / (SAMPLES - 1);
    const x = t * VIEW_W;
    const envelope = Math.sin(t * Math.PI);
    const y = center + Math.sin((t * FREQUENCY + phase) * Math.PI) * amplitude * envelope;

    points.push({ x, y });
  }

  return points;
}

function buildPath(points: FlowPoint[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

export function FlowingLine({ level, state }: FlowingLineProps) {
  const gradientId = React.useId().replace(/:/g, "");
  const points = React.useMemo(() => computePoints(level, state), [level, state]);
  const path = React.useMemo(() => buildPath(points), [points]);
  const energy = getEnergy(level, state);
  const glowStrokeWidth = state === "recording" ? 7 + energy * 2 : 6.4;
  const mainStrokeWidth = state === "recording" ? 3.4 + energy * 0.5 : 3.1;

  return (
    <svg className="dv-wave dv-wave--line" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} aria-hidden="true">
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2={VIEW_W}
          y2="0"
        >
          <stop offset="0%" stopColor="rgb(var(--dv-accent-cool-rgb))" />
          <stop offset="50%" stopColor="rgb(var(--dv-accent-mid-rgb))" />
          <stop offset="100%" stopColor="rgb(var(--dv-accent-warm-rgb))" />
        </linearGradient>
      </defs>
      <path
        className={`dv-wave__path dv-wave__path-glow dv-wave__path--${state}`}
        d={path}
        stroke={`url(#${gradientId})`}
        strokeWidth={glowStrokeWidth}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        fill="none"
      />
      <path
        className={`dv-wave__path dv-wave__path--main dv-wave__path--${state}`}
        d={path}
        stroke={`url(#${gradientId})`}
        strokeWidth={mainStrokeWidth}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        fill="none"
      />
    </svg>
  );
}
