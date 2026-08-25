#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const options = { excludes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--repo" || current === "--tag" || current === "--dir") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${current} requires a value`);
      options[current.slice(2)] = value;
      index += 1;
      continue;
    }
    if (current === "--exclude") {
      const value = argv[index + 1];
      if (!value) throw new Error("--exclude requires a relative path");
      options.excludes.push(value.replace(/\\/g, "/"));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }
  if (!options.repo || !options.tag || !options.dir) {
    throw new Error("Usage: verify-release-assets.js --repo OWNER/REPO --tag TAG --dir DIR");
  }
  return options;
}

function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) return listFiles(root, childRelative);
    return entry.isFile() ? [childRelative] : [];
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function runGhApi(args, outputFd = "pipe") {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: outputFd === "pipe" ? "utf8" : undefined,
    stdio: outputFd === "pipe" ? ["ignore", "pipe", "pipe"] : ["ignore", outputFd, "pipe"],
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(`gh api ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return outputFd === "pipe" ? String(result.stdout || "") : "";
}

async function assertDownloadReachable(url) {
  if (!url) throw new Error("Release asset has no browser download URL");
  const headers = {};
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const request = async (method, extraHeaders = {}) => {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      headers: { ...headers, ...extraHeaders },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    if (response.body) {
      await response.body.cancel();
    }
  };

  try {
    await request("HEAD");
  } catch (headError) {
    // Some CDNs reject HEAD. A one-byte range GET still proves the public URL
    // resolves without downloading the full installer.
    try {
      await request("GET", { Range: "bytes=0-0" });
    } catch (getError) {
      throw new Error(
        `Download URL is not reachable: ${getError.message} (HEAD: ${headError.message})`
      );
    }
  }
}

function downloadAssetBytes(repo, assetId, destination) {
  const fd = fs.openSync(destination, "w", 0o600);
  try {
    runGhApi(
      [`repos/${repo}/releases/assets/${assetId}`, "-H", "Accept: application/octet-stream"],
      fd
    );
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Release asset directory not found: ${root}`);
  }

  const excluded = new Set(options.excludes);
  const expectedByName = new Map();
  for (const relativePath of listFiles(root)) {
    const normalized = relativePath.replace(/\\/g, "/");
    if (excluded.has(normalized)) continue;
    const name = path.basename(relativePath);
    if (expectedByName.has(name)) {
      throw new Error(`Duplicate staged release asset name: ${name}`);
    }
    const filePath = path.join(root, relativePath);
    expectedByName.set(name, {
      filePath,
      size: fs.statSync(filePath).size,
      sha256: sha256File(filePath),
    });
  }
  if (expectedByName.size === 0) throw new Error("No staged release assets found");

  const release = JSON.parse(
    runGhApi([`repos/${options.repo}/releases/tags/${encodeURIComponent(options.tag)}`])
  );
  const remoteAssets = new Map(
    (Array.isArray(release.assets) ? release.assets : []).map((asset) => [asset.name, asset])
  );
  const expectedNames = [...expectedByName.keys()].sort();
  const remoteNames = [...remoteAssets.keys()].sort();
  const missing = expectedNames.filter((name) => !remoteAssets.has(name));
  const unexpected = remoteNames.filter((name) => !expectedByName.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Release asset set mismatch. Missing: ${missing.join(", ") || "<none>"}; unexpected: ${
        unexpected.join(", ") || "<none>"
      }`
    );
  }

  for (const [name, expected] of expectedByName) {
    const remote = remoteAssets.get(name);
    if (Number(remote.size) !== expected.size) {
      throw new Error(
        `Release asset size mismatch for ${name}: local=${expected.size} remote=${remote.size}`
      );
    }
    await assertDownloadReachable(remote.browser_download_url);

    let remoteSha = String(remote.digest || "")
      .replace(/^sha256:/i, "")
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(remoteSha)) {
      const temporaryPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-release-asset-")),
        name
      );
      try {
        downloadAssetBytes(options.repo, remote.id, temporaryPath);
        remoteSha = sha256File(temporaryPath);
      } finally {
        fs.rmSync(path.dirname(temporaryPath), { recursive: true, force: true });
      }
    }
    if (remoteSha !== expected.sha256) {
      throw new Error(
        `Release asset SHA-256 mismatch for ${name}: local=${expected.sha256} remote=${remoteSha}`
      );
    }
    console.log(
      `[release-assets] verified ${name} (${expected.size} bytes, sha256=${expected.sha256})`
    );
  }
  console.log(
    `[release-assets] PASSED: ${expectedNames.length} assets for ${options.repo}@${options.tag}`
  );
}

main().catch((error) => {
  console.error(`[release-assets] FAILED: ${error.message || error}`);
  process.exit(1);
});
