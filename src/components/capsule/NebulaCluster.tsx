import type * as React from "react";

// Stars orbiting in the tilted galactic-disk plane. CSS has no trig, so each
// star carries its precomputed unit vector (cos/sin of `angle`); `rot` is the
// tangent direction (angle + 90°) so the meteor tail trails the orbit.
// Angles are deliberately uneven — a regular spread reads as a clock face.
interface OrbitStar {
  id: string;
  px: number;
  py: number;
  rot: number;
  orbit: number;
  size: number;
  period: number;
  delay: number;
}

const ORBIT_STARS: OrbitStar[] = [
  { id: "o0", px: 1, py: 0, rot: 90, orbit: 38, size: 3.4, period: 2600, delay: 0 },
  { id: "o1", px: 0.766, py: 0.643, rot: 130, orbit: 46, size: 2.4, period: 3400, delay: 300 },
  { id: "o2", px: 0.174, py: 0.985, rot: 170, orbit: 34, size: 3.4, period: 2900, delay: 650 },
  { id: "o3", px: -0.5, py: 0.866, rot: 210, orbit: 50, size: 2.4, period: 3800, delay: 150 },
  { id: "o4", px: -0.94, py: 0.342, rot: 250, orbit: 39, size: 3.4, period: 3100, delay: 900 },
  { id: "o5", px: -0.866, py: -0.5, rot: 300, orbit: 45, size: 2.4, period: 2700, delay: 480 },
  { id: "o6", px: -0.342, py: -0.94, rot: 340, orbit: 35, size: 3.4, period: 3600, delay: 1100 },
  { id: "o7", px: 0.423, py: -0.906, rot: 25, orbit: 48, size: 2.4, period: 3000, delay: 720 },
  { id: "o8", px: 0.906, py: -0.423, rot: 65, orbit: 40, size: 3.4, period: 4000, delay: 1300 },
];

// One round galaxy: deep-space starfield, breathing haze, a tilted spinning
// spiral disk, three extra elliptical orbit lines at varied tilts (each with
// a comet riding it), stars riding the disk plane with meteor tails, then
// corona + white-hot core with diffraction-spike flares on top. Voice
// reactivity rides the inherited --dv-amp.
export function NebulaCluster({ className }: { className?: string }) {
  return (
    <div className={className ? `dv-nebula ${className}` : "dv-nebula"}>
      <span className="dv-nebula__haze" />
      <span className="dv-nebula__disk">
        <span className="dv-nebula__disk-spin" />
      </span>
      {["a", "b", "c"].map((ring) => (
        <span key={ring} className={`dv-nebula__orbit dv-nebula__orbit--${ring}`}>
          <span className="dv-nebula__orbit-spin">
            <span className="dv-nebula__comet" />
          </span>
        </span>
      ))}
      <span className="dv-nebula__ring">
        <span className="dv-nebula__ring-spin">
          {ORBIT_STARS.map((star) => (
            <span
              key={star.id}
              className="dv-nebula__star"
              style={
                {
                  "--dv-star-px": String(star.px),
                  "--dv-star-py": String(star.py),
                  "--dv-star-rot": `${star.rot}deg`,
                  "--dv-star-orbit": `${star.orbit}px`,
                  "--dv-star-size": `${star.size}px`,
                  "--dv-star-period": `${star.period}ms`,
                  "--dv-delay": `${star.delay}ms`,
                } as React.CSSProperties
              }
            />
          ))}
        </span>
      </span>
      <span className="dv-nebula__corona" />
      <span className="dv-nebula__core" />
    </div>
  );
}
