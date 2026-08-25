import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { mergeMacUpdateMetadata } = require("../../scripts/merge-mac-update-metadata");

const temporaryDirectories = [];

function createFixture(version = "1.2.3") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-mac-update-"));
  temporaryDirectories.push(directory);

  const x64Path = path.join(directory, "x64.yml");
  const arm64Path = path.join(directory, "arm64.yml");
  const outputPath = path.join(directory, "merged", "latest-mac.yml");

  fs.writeFileSync(
    x64Path,
    yaml.dump({
      version,
      files: [
        { url: `ChordVox-${version}-mac.zip`, sha512: "intel-zip", size: 10 },
        { url: `ChordVox-${version}.dmg`, sha512: "intel-dmg", size: 20 },
      ],
      path: `ChordVox-${version}-mac.zip`,
      sha512: "intel-zip",
      releaseDate: "2026-07-10T00:00:00.000Z",
    })
  );
  fs.writeFileSync(
    arm64Path,
    yaml.dump({
      version,
      files: [
        { url: `ChordVox-${version}-arm64-mac.zip`, sha512: "arm-zip", size: 11 },
        { url: `ChordVox-${version}-arm64.dmg`, sha512: "arm-dmg", size: 21 },
      ],
      path: `ChordVox-${version}-arm64-mac.zip`,
      sha512: "arm-zip",
      releaseDate: "2026-07-11T00:00:00.000Z",
    })
  );

  return { x64Path, arm64Path, outputPath };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("mergeMacUpdateMetadata", () => {
  it("keeps both architectures and an Intel-compatible legacy top-level path", () => {
    const fixture = createFixture();
    const merged = mergeMacUpdateMetadata(fixture.x64Path, fixture.arm64Path, fixture.outputPath);

    expect(merged.files).toHaveLength(4);
    expect(merged.files.map((file) => file.url)).toContain("ChordVox-1.2.3-mac.zip");
    expect(merged.files.map((file) => file.url)).toContain("ChordVox-1.2.3-arm64-mac.zip");
    expect(merged.path).toBe("ChordVox-1.2.3-mac.zip");
    expect(merged.sha512).toBe("intel-zip");
    expect(yaml.load(fs.readFileSync(fixture.outputPath, "utf8"))).toEqual(merged);
  });

  it("rejects metadata generated from different app versions", () => {
    const fixture = createFixture();
    const armMetadata = yaml.load(fs.readFileSync(fixture.arm64Path, "utf8"));
    armMetadata.version = "9.9.9";
    fs.writeFileSync(fixture.arm64Path, yaml.dump(armMetadata));

    expect(() =>
      mergeMacUpdateMetadata(fixture.x64Path, fixture.arm64Path, fixture.outputPath)
    ).toThrow(/version mismatch/);
  });
});
