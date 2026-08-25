import type * as React from "react";

import { NebulaCluster } from "./NebulaCluster";

// Distant stars scattered across the rest of the waveform slot so the area
// right of the galaxy doesn't sit empty.
interface FieldStar {
  id: string;
  x: number;
  y: number;
  size: number;
  period: number;
  delay: number;
}

const FIELD_STARS: FieldStar[] = [
  { id: "f0", x: 34, y: 22, size: 2, period: 4200, delay: 200 },
  { id: "f1", x: 46, y: 64, size: 1.5, period: 3600, delay: 800 },
  { id: "f2", x: 58, y: 30, size: 2, period: 4800, delay: 1400 },
  { id: "f3", x: 70, y: 58, size: 1.5, period: 3900, delay: 500 },
  { id: "f4", x: 82, y: 24, size: 2, period: 4500, delay: 1100 },
  { id: "f5", x: 92, y: 50, size: 1.5, period: 3300, delay: 1700 },
];

// In-capsule variant: the same 132px galaxy as the nebula orb, scaled down
// into the waveform slot. Voice reactivity rides --dv-amp (inherited from
// .dv-capsule), so the component itself is static — no props needed despite
// the WaveProps slot.
export function Stardust() {
  return (
    <div className="dv-wave dv-wave--stardust" aria-hidden="true">
      <div className="dv-wave__nebula-stage">
        <NebulaCluster />
      </div>
      {FIELD_STARS.map((star) => (
        <span
          key={star.id}
          className="dv-field-star"
          style={
            {
              left: `${star.x}%`,
              top: `${star.y}%`,
              "--dv-star-size": `${star.size}px`,
              "--dv-star-period": `${star.period}ms`,
              "--dv-delay": `${star.delay}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
