import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const requireFromHere = createRequire(import.meta.url);
const originalPublisher = process.env.WINDOWS_PUBLISHER_NAME;

afterEach(() => {
  if (originalPublisher === undefined) delete process.env.WINDOWS_PUBLISHER_NAME;
  else process.env.WINDOWS_PUBLISHER_NAME = originalPublisher;
  delete requireFromHere.cache[requireFromHere.resolve("../../electron-builder.win.cjs")];
});

describe("release acceptance gates", () => {
  it("forces Windows signing and binds publisherName to an explicit release variable", () => {
    const baseConfig = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "electron-builder.json"), "utf8")
    );
    expect(baseConfig.win.forceCodeSigning).toBe(true);

    process.env.WINDOWS_PUBLISHER_NAME = "ChordVox Local Code Signing";
    const winConfig = requireFromHere("../../electron-builder.win.cjs");
    expect(winConfig.win.forceCodeSigning).toBe(true);
    expect(winConfig.win.signtoolOptions.publisherName).toEqual(["ChordVox Local Code Signing"]);
    expect(winConfig.win.signtoolOptions.signingHashAlgorithms).toEqual(["sha256"]);
  });

  it("fails Windows config loading when publisherName is absent", () => {
    delete process.env.WINDOWS_PUBLISHER_NAME;
    expect(() => requireFromHere("../../electron-builder.win.cjs")).toThrow(
      "WINDOWS_PUBLISHER_NAME is required"
    );
  });

  it("rejects publisher drift from the fixed self-signed Windows identity", () => {
    process.env.WINDOWS_PUBLISHER_NAME = "Different Publisher";
    expect(() => requireFromHere("../../electron-builder.win.cjs")).toThrow(
      "must remain 'ChordVox Local Code Signing'"
    );
  });

  it("locks release workflows to signed and packaged native runtime evidence", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const workflow = fs.readFileSync(
      path.join(repoRoot, ".github", "workflows", "release.yml"),
      "utf8"
    );
    const packagedSpec = fs.readFileSync(
      path.join(repoRoot, "tests", "e2e", "packaged-dictation.real.spec.ts"),
      "utf8"
    );
    const main = fs.readFileSync(path.join(repoRoot, "main.js"), "utf8");

    expect(packageJson.scripts["build:win:package"]).toContain("electron-builder.win.cjs");
    expect(packageJson.scripts["build:win"]).toContain("verify:win:authenticode");
    expect(workflow).toContain("WINDOWS_PUBLISHER_NAME");
    expect(workflow).toContain("resources/windows/chordvox-local-code-signing.cer");
    expect(workflow).toContain("Cert:\\CurrentUser\\TrustedPeople");
    expect(workflow).toContain("verify:win:authenticode");
    expect(workflow).toContain("verify:packaged:dictation");
    expect(workflow).toContain("windows-authenticode-evidence.json");
    expect(workflow).toContain("native-runtime-evidence-linux.json");
    expect(workflow).toContain("native-runtime-evidence-windows.json");
    expect(packagedSpec).toContain("expect(runtimeInfo.isPackaged).toBe(true)");
    expect(packagedSpec).toContain("expect(rendererHasFixtureHook).toBe(false)");
    expect(packagedSpec).toContain("expect(clickTrust).toEqual([true, true])");
    expect(packagedSpec).toContain("path.resolve(runtimeInfo.userDataPath)");
    expect(main).toContain('app.setPath("userData", explicitUserDataPath)');
  });
});
