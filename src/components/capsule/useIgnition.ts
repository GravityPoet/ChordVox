import * as React from "react";

import type { CapsuleState } from "./types";

const IGNITION_DURATION_MS = 400;

export function useIgnition(state: CapsuleState): boolean {
  const [igniting, setIgniting] = React.useState(false);
  const previousStateRef = React.useRef<CapsuleState>(state);

  React.useEffect(() => {
    const previousState = previousStateRef.current;
    previousStateRef.current = state;

    if (previousState !== "idle" || state !== "starting") {
      return undefined;
    }

    setIgniting(true);
    const timeoutId = window.setTimeout(() => {
      setIgniting(false);
    }, IGNITION_DURATION_MS);

    return () => window.clearTimeout(timeoutId);
  }, [state]);

  return igniting;
}
