import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { validateTarArchiveEntries } = require("./archiveSecurity");

const tempDirs = [];

function checksum(block) {
  for (let index = 148; index < 156; index += 1) {
    block[index] = 0x20;
  }
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  return sum;
}

function writeOctal(block, offset, length, value) {
  const octal = value.toString(8).padStart(length - 1, "0");
  block.write(octal.slice(0, length - 1), offset, length - 1, "ascii");
  block[offset + length - 1] = 0;
}

function createSingleEntryTar(filePath, entryPath, typeflag) {
  const block = Buffer.alloc(512, 0);
  block.write(entryPath, 0, 100, "utf8");
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, 0);
  writeOctal(block, 136, 12, 0);
  block[156] = typeflag.charCodeAt(0);
  block.write("ustar", 257, 5, "ascii");
  block.write("00", 263, 2, "ascii");
  writeOctal(block, 148, 8, checksum(block));
  fs.writeFileSync(filePath, Buffer.concat([block, Buffer.alloc(1024, 0)]));
}

describe("archiveSecurity", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects tar FIFO and other special entries before extraction", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-tar-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "special.tar");
    const extractDir = path.join(dir, "extract");
    fs.mkdirSync(extractDir);
    createSingleEntryTar(archivePath, "pipe-entry", "6");

    await expect(validateTarArchiveEntries(archivePath, extractDir)).rejects.toThrow(
      /unsupported|special/i
    );
  });
});
