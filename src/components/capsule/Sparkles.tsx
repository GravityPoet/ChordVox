import * as React from "react";

export function Sparkles() {
  return (
    <div className="dv-sparkles" aria-hidden="true">
      <div className="dv-sparkles__trail" />
      {Array.from({ length: 12 }, (_, index) => (
        <span key={index} className="dv-sparkles__particle" />
      ))}
    </div>
  );
}
