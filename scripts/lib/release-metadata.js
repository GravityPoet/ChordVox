"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { extractFile } = require("@electron/asar");

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;

function resolveGitSourceSha(projectRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to resolve source SHA: git exited with ${result.status}`);
  }
  const sourceSha = String(result.stdout || "").trim();
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error(`Invalid source SHA returned by git: ${sourceSha || "<empty>"}`);
  }
  return sourceSha;
}

function readPackagedMetadata(asarPath) {
  if (!asarPath || !fs.existsSync(asarPath)) {
    throw new Error(`Packaged app.asar not found: ${asarPath}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to read packaged package.json from ${asarPath}: ${error.message}`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`Packaged package.json is not an object: ${asarPath}`);
  }
  return metadata;
}

function readPackagedSourceSha(asarPath) {
  const metadata = readPackagedMetadata(asarPath);
  const sourceSha = String(metadata.releaseSourceSha || "").trim();
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error(
      `Packaged package.json is missing a valid releaseSourceSha (expected 40 lowercase hex characters): ${asarPath}`
    );
  }
  return sourceSha;
}

function resolveAsarPathForExecutable(executablePath) {
  const resolvedExecutable = path.resolve(executablePath);
  const executableDir = path.dirname(resolvedExecutable);
  const candidates = [
    path.join(executableDir, "resources", "app.asar"),
    path.resolve(executableDir, "..", "Resources", "app.asar"),
    path.resolve(executableDir, "..", "Resources", "app.asar.unpacked", "..", "app.asar"),
  ];
  const asarPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!asarPath) {
    throw new Error(
      `Unable to locate packaged app.asar for ${resolvedExecutable}. Tried:\n${candidates
        .map((candidate) => `- ${candidate}`)
        .join("\n")}`
    );
  }
  return asarPath;
}

module.exports = {
  SOURCE_SHA_PATTERN,
  readPackagedMetadata,
  readPackagedSourceSha,
  resolveAsarPathForExecutable,
  resolveGitSourceSha,
};
