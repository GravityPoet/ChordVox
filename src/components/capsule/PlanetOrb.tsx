// A lit sphere wrapped in a voice-reactive nebula mist, for the same
// shell-less round window as NebulaCluster. Pure presentational: the audio
// rides the inherited --dv-amp CSS variable (set by useCapsuleAmplitude on
// the .dv-capsule root), so this component takes no props beyond an optional
// className for preview reuse.
//
// The premium tell is mass separation — the outer mist scales/brightens hard
// with the voice while the globe barely breathes (heavy stays still, light
// flies). All layers share one fixed light source at upper-left (~34%/32%):
// globe highlight, terminator shadow (lower-right), atmosphere rim and glint
// all answer to it. z-order (bottom→top): deepfield → mist → mistring →
// globe → atmo → glint.
export function PlanetOrb({ className }: { className?: string }) {
  return (
    <div className={className ? `dv-planet ${className}` : "dv-planet"}>
      <span className="dv-planet__deepfield" />
      <span className="dv-planet__mist" />
      <span className="dv-planet__mistring">
        <span className="dv-planet__mistring-spin" />
      </span>
      <span className="dv-planet__globe">
        <span className="dv-planet__surface" />
        <span className="dv-planet__terminator" />
      </span>
      <span className="dv-planet__atmo" />
      <span className="dv-planet__glint" />
    </div>
  );
}
