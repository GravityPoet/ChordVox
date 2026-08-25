import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Capsule } from "./Capsule";

const BASE_PROPS = {
  level: 0,
  text: "",
  textAnimationKey: 0,
} as const;

describe("Capsule nebula completion", () => {
  it("renders a glyph-free stellar completion pulse only after the nebula reaches success", () => {
    const success = renderToStaticMarkup(
      <Capsule {...BASE_PROPS} animationStyle="nebula" state="success" />
    );
    const processing = renderToStaticMarkup(
      <Capsule {...BASE_PROPS} animationStyle="nebula" state="processing" />
    );

    expect(success).toContain('class="dv-nebula-completion"');
    expect(success).toContain('class="dv-nebula-completion__flare"');
    expect(success).toContain('class="dv-nebula-completion__wave"');
    expect(success).not.toContain("<svg");
    expect(success).not.toContain("check");
    expect(success).not.toContain("lens");
    expect(success).not.toContain("dv-sparkles__trail");
    expect(processing).not.toContain("dv-nebula-completion");
  });

  it("exposes paste-pending state without showing a completion pulse", () => {
    const markup = renderToStaticMarkup(
      <Capsule {...BASE_PROPS} animationStyle="nebula" isPastePending state="processing" />
    );

    expect(markup).toContain('data-pasting="true"');
    expect(markup).not.toContain("dv-nebula-completion");
  });

  it("keeps the existing sparkle treatment for non-nebula success styles", () => {
    const markup = renderToStaticMarkup(
      <Capsule {...BASE_PROPS} animationStyle="flow" state="success" />
    );

    expect(markup).toContain("dv-sparkles__trail");
    expect(markup).not.toContain("dv-nebula-completion");
  });
});
