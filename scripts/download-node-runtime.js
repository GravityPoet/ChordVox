#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const tar = require("tar");
const unzipper = require("unzipper");

const NODE_RUNTIME_VERSION = process.env.CHORDVOX_NODE_RUNTIME_VERSION || "22.19.0";
const DIST_BASE_URL = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}`;
const projectRoot = path.resolve(__dirname, "..");
const outputRoot = path.join(projectRoot, "resources", "bin", "node-runtime");
const downloadRoot = path.join(projectRoot, "resources", "bin", ".node-runtime-downloads");

const TARGETS = [
  { platform: "darwin", arch: "arm64", nodePlatform: "darwin", nodeArch: "arm64", ext: "tar.gz" },
  { platform: "darwin", arch: "x64", nodePlatform: "darwin", nodeArch: "x64", ext: "tar.gz" },
  { platform: "linux", arch: "x64", nodePlatform: "linux", nodeArch: "x64", ext: "tar.gz" },
  { platform: "linux", arch: "arm64", nodePlatform: "linux", nodeArch: "arm64", ext: "tar.gz" },
  { platform: "win32", arch: "x64", nodePlatform: "win", nodeArch: "x64", ext: "zip" },
];

function log(message) {
  console.log(`[node-runtime] ${message}`);
}

function fail(message) {
  console.error(`[node-runtime] ${message}`);
  process.exit(1);
}

function parseArgs(
  argv,
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch
) {
  const options = {
    all: false,
    platform: env.TARGET_PLATFORM || hostPlatform,
    arch: env.TARGET_ARCH || hostArch,
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--all") {
      options.all = true;
      continue;
    }
    if (current === "--current") {
      continue;
    }
    if (current === "--force") {
      options.force = true;
      continue;
    }
    if (current === "--platform" && argv[index + 1]) {
      options.platform = argv[index + 1];
      index += 1;
      continue;
    }
    if (current === "--arch" && argv[index + 1]) {
      options.arch = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

function getTargetKey(target) {
  return `${target.platform}-${target.arch}`;
}

function getArchiveName(target) {
  return `node-v${NODE_RUNTIME_VERSION}-${target.nodePlatform}-${target.nodeArch}.${target.ext}`;
}

function getExecutablePath(target) {
  const targetDir = path.join(outputRoot, getTargetKey(target));
  return target.platform === "win32"
    ? path.join(targetDir, "node.exe")
    : path.join(targetDir, "bin", "node");
}

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(response.body, fs.createWriteStream(destPath));
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function getExpectedSha256(archiveName) {
  const shasums = await downloadText(`${DIST_BASE_URL}/SHASUMS256.txt`);
  const line = shasums.split(/\r?\n/).find((entry) => entry.trim().endsWith(`  ${archiveName}`));
  if (!line) {
    throw new Error(`No checksum found for ${archiveName}`);
  }
  return line.split(/\s+/)[0];
}

async function extractArchive(archivePath, target, extractDir) {
  await fs.promises.rm(extractDir, { recursive: true, force: true });
  await fs.promises.mkdir(extractDir, { recursive: true });

  if (target.ext === "zip") {
    await fs
      .createReadStream(archivePath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();
    return;
  }

  await tar.x({ file: archivePath, cwd: extractDir });
}

async function findExtractedNodeExecutable(extractDir, target) {
  const entries = await fs.promises.readdir(extractDir);
  for (const entry of entries) {
    const candidateRoot = path.join(extractDir, entry);
    const executablePath =
      target.platform === "win32"
        ? path.join(candidateRoot, "node.exe")
        : path.join(candidateRoot, "bin", "node");
    if (fs.existsSync(executablePath)) {
      return executablePath;
    }
  }
  throw new Error(`Unable to locate node executable in extracted ${getArchiveName(target)}`);
}

async function installTarget(target, options) {
  const targetKey = getTargetKey(target);
  const finalExecutable = getExecutablePath(target);
  if (!options.force && fs.existsSync(finalExecutable)) {
    log(`${targetKey}: already installed`);
    return;
  }

  const archiveName = getArchiveName(target);
  const archiveUrl = `${DIST_BASE_URL}/${archiveName}`;
  const archivePath = path.join(downloadRoot, archiveName);
  const extractDir = path.join(downloadRoot, `${targetKey}-extract`);
  const targetDir = path.join(outputRoot, targetKey);

  log(`${targetKey}: downloading ${archiveName}`);
  await downloadFile(archiveUrl, archivePath);

  const [expectedHash, actualHash] = await Promise.all([
    getExpectedSha256(archiveName),
    Promise.resolve(sha256File(archivePath)),
  ]);

  if (actualHash !== expectedHash) {
    throw new Error(
      `${archiveName} checksum mismatch. Expected ${expectedHash}, got ${actualHash}`
    );
  }

  await extractArchive(archivePath, target, extractDir);
  const extractedExecutable = await findExtractedNodeExecutable(extractDir, target);

  await fs.promises.rm(targetDir, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(finalExecutable), { recursive: true });
  await fs.promises.copyFile(extractedExecutable, finalExecutable);
  if (target.platform !== "win32") {
    await fs.promises.chmod(finalExecutable, 0o755);
  }

  await fs.promises.rm(extractDir, { recursive: true, force: true });
  log(`${targetKey}: installed ${finalExecutable}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selectedTargets = options.all
    ? TARGETS
    : TARGETS.filter(
        (target) => target.platform === options.platform && target.arch === options.arch
      );

  if (!selectedTargets.length) {
    fail(`Unsupported Node runtime target: ${options.platform}-${options.arch}`);
  }

  for (const target of selectedTargets) {
    await installTarget(target, options);
  }
}

module.exports = {
  parseArgs,
};

if (require.main === module) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
