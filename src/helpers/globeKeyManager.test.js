import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const GlobeKeyManager = require("./globeKeyManager");

describe("Globe listener packaging/runtime resolution", () => {
  it("includes the packaged Resources/bin location", () => {
    const candidates = GlobeKeyManager.getGlobeListenerCandidates({
      moduleDir: "/project/build/electron",
      resourcesPath: "/Applications/ChordVox.app/Contents/Resources",
    });

    expect(candidates).toContain(
      "/Applications/ChordVox.app/Contents/Resources/bin/macos-globe-listener"
    );
  });

  it("requires a regular executable file before spawning", () => {
    const files = new Map([
      ["/tmp/listener", { isFile: () => true }],
      ["/tmp/not-file", { isFile: () => false }],
    ]);
    const fakeFs = {
      constants: { X_OK: 1 },
      statSync: (filePath) => {
        const value = files.get(filePath);
        if (!value) throw new Error("missing");
        return value;
      },
      accessSync: (filePath) => {
        if (filePath !== "/tmp/listener") throw new Error("not executable");
      },
    };

    expect(GlobeKeyManager.isUsableGlobeListenerBinary("/tmp/listener", fakeFs)).toBe(true);
    expect(GlobeKeyManager.isUsableGlobeListenerBinary("/tmp/not-file", fakeFs)).toBe(false);
    expect(GlobeKeyManager.isUsableGlobeListenerBinary("/tmp/missing", fakeFs)).toBe(false);
  });
});
