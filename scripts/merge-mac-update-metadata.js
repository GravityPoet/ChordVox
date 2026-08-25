#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function fail(message) {
  throw new Error(`Cannot merge macOS update metadata: ${message}`);
}

function readMetadata(filePath) {
  const parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object") fail(`${filePath} is not a YAML object`);
  if (!parsed.version) fail(`${filePath} has no version`);
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  if (files.length === 0) fail(`${filePath} has no files list`);
  for (const file of files) {
    if (!file?.url || (!file.sha512 && !file.sha2)) {
      fail(`${filePath} contains an update file without URL/checksum`);
    }
  }
  return parsed;
}

function isZip(file) {
  return String(file?.url || "")
    .toLowerCase()
    .endsWith(".zip");
}

function isArm64(file) {
  return String(file?.url || "")
    .toLowerCase()
    .includes("arm64");
}

function mergeMacUpdateMetadata(x64Path, arm64Path, outputPath) {
  const x64 = readMetadata(x64Path);
  const arm64 = readMetadata(arm64Path);
  if (String(x64.version) !== String(arm64.version)) {
    fail(`version mismatch (${x64.version} vs ${arm64.version})`);
  }

  const files = [];
  const seenUrls = new Set();
  for (const file of [...x64.files, ...arm64.files]) {
    if (seenUrls.has(file.url)) continue;
    seenUrls.add(file.url);
    files.push(file);
  }

  const x64Zip = files.find((file) => isZip(file) && !isArm64(file));
  const arm64Zip = files.find((file) => isZip(file) && isArm64(file));
  if (!x64Zip || !arm64Zip) {
    fail("both Intel and Apple Silicon ZIP files are required");
  }

  const merged = {
    ...x64,
    files,
    path: x64Zip.url,
    sha512: x64Zip.sha512,
    releaseDate: arm64.releaseDate || x64.releaseDate,
  };
  if (!merged.sha512) delete merged.sha512;
  if (x64Zip.sha2) merged.sha2 = x64Zip.sha2;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.dump(merged, { lineWidth: -1, noRefs: true }), "utf8");
  return merged;
}

if (require.main === module) {
  const [x64Path, arm64Path, outputPath] = process.argv.slice(2);
  if (!x64Path || !arm64Path || !outputPath) {
    console.error(
      "Usage: node scripts/merge-mac-update-metadata.js <x64/latest-mac.yml> <arm64/latest-mac.yml> <output>"
    );
    process.exit(2);
  }
  try {
    mergeMacUpdateMetadata(x64Path, arm64Path, outputPath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { mergeMacUpdateMetadata };
