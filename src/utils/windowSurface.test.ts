import { describe, expect, it } from "vitest";
import { resolveWindowSurface } from "./windowSurface";

describe("resolveWindowSurface", () => {
  it("recognizes only exact control-panel routes", () => {
    expect(resolveWindowSurface({ pathname: "/control-panel", search: "" })).toBe("control-panel");
    expect(resolveWindowSurface({ pathname: "/", search: "?panel=true" })).toBe("control-panel");
    expect(resolveWindowSurface({ pathname: "/my-control-notes", search: "" })).toBe("dictation");
    expect(resolveWindowSurface({ pathname: "/", search: "?panel=trueish" })).toBe("dictation");
  });

  it("recognizes command and completion windows by exact query values", () => {
    expect(resolveWindowSurface({ pathname: "/", search: "?commandMenu=true" })).toBe(
      "command-menu"
    );
    expect(
      resolveWindowSurface({ pathname: "/", search: "?completionAlert=fileTranscription" })
    ).toBe("completion-alert");
    expect(resolveWindowSurface({ pathname: "/", search: "?commandMenu=false" })).toBe("dictation");
  });
});
