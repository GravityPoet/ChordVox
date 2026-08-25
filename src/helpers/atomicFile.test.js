import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { createRequire } from "module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { atomicWriteFile, atomicWriteFileSync, readJsonWithBackup } = require("./atomicFile");

describe("atomicFile", () => {
  const temporaryDirectories = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps both the current file and its backup private", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-atomic-file-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, ".env");
    fs.writeFileSync(filePath, "VALUE=old\n", "utf8");
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o644);
    }

    await atomicWriteFile(filePath, "VALUE=new\n", { mode: 0o600, backup: true });

    expect(fs.readFileSync(filePath, "utf8")).toBe("VALUE=new\n");
    expect(fs.readFileSync(`${filePath}.bak`, "utf8")).toBe("VALUE=old\n");
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(`${filePath}.bak`).mode & 0o777).toBe(0o600);
    }
  });

  it("can recover a corrupt primary JSON file from its backup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-atomic-json-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "license-state.json");
    fs.writeFileSync(filePath, '{"broken"', "utf8");
    fs.writeFileSync(`${filePath}.bak`, JSON.stringify({ status: "active" }), "utf8");

    await expect(readJsonWithBackup(filePath, { recoverCorrupt: true })).resolves.toMatchObject({
      value: { status: "active" },
      source: `${filePath}.bak`,
    });
  });

  it("writes synchronous secret-store updates through a rename", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-atomic-sync-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "secure-secrets.json");
    fs.writeFileSync(filePath, "old", "utf8");

    atomicWriteFileSync(filePath, "new", { mode: 0o600, backup: true });

    expect(fs.readFileSync(filePath, "utf8")).toBe("new");
    expect(fs.readFileSync(`${filePath}.bak`, "utf8")).toBe("old");
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(`${filePath}.bak`).mode & 0o777).toBe(0o600);
    }
  });
});
