import * as React from "react";

export function NebulaCompletionPulse() {
  return (
    <div className="dv-nebula-completion" aria-hidden="true">
      <span className="dv-nebula-completion__aura" />
      <span className="dv-nebula-completion__wave" />
      <span className="dv-nebula-completion__flare" />
      <span className="dv-nebula-completion__dust dv-nebula-completion__dust--a" />
      <span className="dv-nebula-completion__dust dv-nebula-completion__dust--b" />
      <span className="dv-nebula-completion__dust dv-nebula-completion__dust--c" />
    </div>
  );
}
