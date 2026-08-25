import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { resolveElectronEntry } = require("../helpers/electronBundlePaths") as {
  resolveElectronEntry: (fileName: string) => string;
};

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("ChordVox Pro proprietary packaging boundary", () => {
  it("packages production bundles instead of first-party source trees", () => {
    const config = JSON.parse(readRepoFile("electron-builder.json")) as {
      extraMetadata: { main: string; license: string };
      files: string[];
      asarUnpack: string[];
    };

    expect(config.extraMetadata).toEqual({
      main: "build/electron/main.js",
      license: "UNLICENSED",
    });
    expect(config.files).toContain("build/electron/**/*");
    expect(config.files).toContain("src/dist/**/*");
    expect(config.files).toContain("!**/*.map");
    expect(config.files).toContain("!**/*.ts");
    expect(config.files).toContain("!**/*.tsx");

    for (const rawSourceTree of [
      "main.js",
      "preload.js",
      "macPrivacyDragHelperPreload.js",
      "src/helpers/**/*",
      "src/config/**/*",
      "src/hooks/**/*",
      "src/models/**/*",
      "src/services/localReasoningBridge.js",
      "src/types/**/*",
      "src/utils/**/*",
    ]) {
      expect(config.files).not.toContain(rawSourceTree);
    }

    expect(config.asarUnpack.filter((pattern) => !pattern.includes("node_modules"))).toEqual([
      "build/electron/sherpaStreamingWorker.js",
      "build/electron/databaseWorker.js",
    ]);
  });

  it("sets the hardened Electron fuses required by the package verifier", () => {
    const config = JSON.parse(readRepoFile("electron-builder.json")) as {
      electronFuses: Record<string, boolean>;
    };

    expect(config.electronFuses).toMatchObject({
      runAsNode: false,
      enableCookieEncryption: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: true,
    });
  });

  it("keeps source-mode preload resolution intact for development", () => {
    expect(resolveElectronEntry("preload.js")).toBe(path.join(repoRoot, "preload.js"));
    expect(resolveElectronEntry("macPrivacyDragHelperPreload.js")).toBe(
      path.join(repoRoot, "macPrivacyDragHelperPreload.js")
    );
  });

  it("builds every distributable through the Electron production bundler", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      version: string;
      license: string;
      scripts: Record<string, string>;
    };
    const packageLock = JSON.parse(readRepoFile("package-lock.json")) as {
      packages: { "": { version: string; license: string } };
    };

    expect(packageJson.version).toBe("1.5.135");
    expect(packageJson.license).toBe("UNLICENSED");
    expect(packageLock.packages[""]).toMatchObject({
      version: packageJson.version,
      license: packageJson.license,
    });
    for (const scriptName of [
      "build",
      "build:mac",
      "build:mac:customer",
      "build:mac:test",
      "build:mac:dmg",
      "build:mac:dmg:test",
      "build:win:package",
      "build:linux:package",
      "pack",
      "dist",
    ]) {
      expect(packageJson.scripts[scriptName]).toContain("build:production");
    }

    for (const workflowPath of [
      ".github/workflows/build-and-notarize.yml",
      ".github/workflows/release.yml",
    ]) {
      const workflow = readRepoFile(workflowPath);
      expect(workflow).toContain("npm run build:production");
      expect(workflow).not.toContain("npm run build:renderer");
    }

    const macDmgScript = readRepoFile("scripts/build-mac-dmg.js");
    expect(macDmgScript).toContain('run(process.execPath, ["scripts/build-electron.js"])');
    expect(macDmgScript).toContain('require("app-builder-lib/out/targets/blockmap/blockmap.js")');
    expect(macDmgScript).not.toContain('"app-builder-bin"');
  });

  it("keeps commercial, public AGPL, upstream MIT, and server-secret boundaries explicit", () => {
    const license = readRepoFile("LICENSE");
    const packagedLicense = readRepoFile("resources/legal/CHORDVOX_PRO_COMMERCIAL_LICENSE.txt");
    const components = readRepoFile("resources/legal/PROPRIETARY_COMPONENTS.txt");
    const workerManager = readRepoFile("src/helpers/sherpaStreamingProcessManager.js");

    expect(packagedLicense).toBe(license);
    expect(license).toContain("mandatory law");
    expect(license).toContain("ChordVox v1.5.131");
    expect(license).toContain("GNU AGPL-3.0");
    for (const publicProduct of ["ChordVox", "AppSift", "OpenFind", "rime-smart-simplified"]) {
      expect(components).toContain(publicProduct);
    }
    expect(components).toContain("server private keys");
    expect(workerManager).toContain("__CHORDVOX_STREAMING_WORKER_SHA256__");
    expect(workerManager).toContain("LOCAL_STREAMING_WORKER_INTEGRITY_FAILED");
  });
});
