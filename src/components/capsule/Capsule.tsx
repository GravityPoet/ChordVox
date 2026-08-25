import * as React from "react";

import { FlowingLine } from "./FlowingLine";
import { NebulaCluster } from "./NebulaCluster";
import { NebulaCompletionPulse } from "./NebulaCompletionPulse";
import { Orb } from "./Orb";
import { Sparkles } from "./Sparkles";
import { Stardust } from "./Stardust";
import type { AnimationStyle, CapsuleState, CapsuleTextMode } from "./types";
import { useCapsuleAmplitude } from "./useCapsuleAmplitude";
import { useIgnition } from "./useIgnition";
import { useCapsuleParallax } from "./useCapsuleParallax";

interface CapsuleProps {
  animationStyle: AnimationStyle;
  "data-exiting"?: "true";
  isPastePending?: boolean;
  level: number;
  state: CapsuleState;
  text: string;
  textAnimationKey: number;
  textMode?: CapsuleTextMode;
}

interface WaveProps {
  level: number;
  state: CapsuleState;
}

const WAVE_COMPONENTS: Partial<Record<AnimationStyle, React.ComponentType<WaveProps>>> = {
  flow: FlowingLine,
  stardust: Stardust,
};

function useStateBloom(state: CapsuleState, target: React.RefObject<HTMLElement | null>) {
  const previousState = React.useRef(state);

  React.useEffect(() => {
    if (previousState.current === state) return;

    previousState.current = state;
    const element = target.current;
    if (!element) return;

    element.setAttribute("data-bloom", "true");
    const timeoutId = window.setTimeout(() => {
      element.removeAttribute("data-bloom");
    }, 520);

    return () => window.clearTimeout(timeoutId);
  }, [state, target]);
}

export function Capsule({
  animationStyle,
  "data-exiting": dataExiting,
  isPastePending = false,
  level,
  state,
  text,
  textAnimationKey,
  textMode = "batch-placeholder",
}: CapsuleProps) {
  const igniting = useIgnition(state);
  const WaveComponent = WAVE_COMPONENTS[animationStyle] ?? FlowingLine;
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  useStateBloom(state, rootRef);
  useCapsuleAmplitude({ level, state, target: rootRef });
  useCapsuleParallax(rootRef);

  // Nebula drops the capsule shell entirely: the whole floating window becomes
  // one round cosmic orb. State colors still flow through the .dv-capsule
  // [data-state] palette variables.
  if (animationStyle === "nebula") {
    return (
      <div
        ref={rootRef}
        className="dv-capsule dv-capsule--nebula"
        data-state={state}
        data-style={animationStyle}
        data-ignite={igniting ? "true" : "false"}
        data-exiting={dataExiting}
        data-pasting={isPastePending ? "true" : undefined}
      >
        <div className="dv-capsule__halo" />
        <div className="dv-capsule__rimglow" />
        <NebulaCluster />
        {state === "success" ? <NebulaCompletionPulse /> : null}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="dv-capsule"
      data-state={state}
      data-style={animationStyle}
      data-ignite={igniting ? "true" : "false"}
      data-exiting={dataExiting}
      data-text-mode={textMode}
    >
      <div className="dv-capsule__halo" />
      <div className="dv-capsule__ambient dv-capsule__ambient--far" />
      <div className="dv-capsule__ambient dv-capsule__ambient--mid" />
      <div className="dv-capsule__ambient dv-capsule__ambient--near" />
      <div className="dv-capsule__rimglow" />
      <div className="dv-capsule__grain" />
      <div className="dv-capsule__conduit" aria-hidden="true">
        <span className="dv-capsule__conduit-beam" />
        <span className="dv-capsule__conduit-pulse dv-capsule__conduit-pulse--1" />
        <span className="dv-capsule__conduit-pulse dv-capsule__conduit-pulse--2" />
        <span className="dv-capsule__conduit-pulse dv-capsule__conduit-pulse--3" />
        <span className="dv-capsule__conduit-echo" />
      </div>
      <div className="dv-capsule__ignition" />
      <div className="dv-capsule__content">
        <Orb state={state} />
        <div className="dv-capsule__main">
          <div className="dv-capsule__signal-row">
            <WaveComponent state={state} level={level} />
            <div key={textAnimationKey} className="dv-text dv-text--appear">
              {text}
            </div>
          </div>
        </div>
      </div>
      {state === "success" ? <Sparkles /> : null}
    </div>
  );
}
