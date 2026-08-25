import * as React from "react";
import { Check, Mic } from "lucide-react";

import type { CapsuleState } from "./types";

interface OrbProps {
  state: CapsuleState;
}

export function Orb({ state }: OrbProps) {
  return (
    <div className="dv-orb" aria-hidden="true">
      <span className="dv-orb__core" />
      <span className="dv-orb__ring dv-orb__ring--inner" />
      <span className="dv-orb__ring dv-orb__ring--outer" />
      <span className="dv-orb__satellites">
        <span />
        <span />
        <span />
      </span>
      {state === "processing" ? (
        <span className="dv-orb__dots">
          <span />
          <span />
          <span />
        </span>
      ) : state === "success" ? (
        <Check size={20} strokeWidth={2.8} className="dv-orb__icon" />
      ) : (
        <Mic size={20} strokeWidth={2.25} className="dv-orb__icon" />
      )}
    </div>
  );
}
