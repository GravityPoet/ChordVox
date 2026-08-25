#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "build", "electron");
const entryPoints = Object.freeze({
  main: path.join(projectRoot, "main.js"),
  preload: path.join(projectRoot, "preload.js"),
  macPrivacyDragHelperPreload: path.join(projectRoot, "macPrivacyDragHelperPreload.js"),
  sherpaStreamingWorker: path.join(projectRoot, "src", "helpers", "sherpaStreamingWorker.js"),
  databaseWorker: path.join(projectRoot, "src", "helpers", "databaseWorker.js"),
});
const expectedOutputs = Object.keys(entryPoints).map((name) => `${name}.js`);
const forbiddenServerSecretIdentifiers = [
  "CREEM_API_KEY",
  "CREEM_WEBHOOK_SECRET",
  "INTERNAL_OWNER_KEY",
  "LICENSE_KEY_PEPPER",
  "LICENSE_SERVER_ADMIN_TOKEN",
];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertSafeOutputDir(targetDir) {
  const expected = path.resolve(projectRoot, "build", "electron");
  if (path.resolve(targetDir) !== expected) {
    throw new Error(
      `Refusing to write outside the dedicated Electron build directory: ${targetDir}`
    );
  }
}

function verifyMetafile(metafile) {
  const unsafeInputs = Object.keys(metafile.inputs || {}).filter((inputPath) => {
    const normalized = inputPath.replace(/\\/g, "/");
    return (
      normalized.startsWith("services/") ||
      /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(normalized) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
    );
  });

  if (unsafeInputs.length > 0) {
    throw new Error(
      `Production Electron bundle unexpectedly includes server or test inputs:\n${unsafeInputs
        .map((item) => `- ${item}`)
        .join("\n")}`
    );
  }
}

function verifyElectronBundles(targetDir = outputDir) {
  assertSafeOutputDir(targetDir);

  const actualFiles = fs.existsSync(targetDir)
    ? fs
        .readdirSync(targetDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];
  const unexpectedFiles = actualFiles.filter((fileName) => !expectedOutputs.includes(fileName));
  const missingFiles = expectedOutputs.filter((fileName) => !actualFiles.includes(fileName));

  if (missingFiles.length > 0) {
    throw new Error(`Missing Electron production bundle(s): ${missingFiles.join(", ")}`);
  }
  if (unexpectedFiles.length > 0) {
    throw new Error(`Unexpected Electron build output(s): ${unexpectedFiles.join(", ")}`);
  }

  const results = [];
  for (const fileName of expectedOutputs) {
    const filePath = path.join(targetDir, fileName);
    const content = fs.readFileSync(filePath);
    const text = content.toString("utf8");

    if (content.length === 0) {
      throw new Error(`Electron production bundle is empty: ${fileName}`);
    }
    if (/sourceMappingURL/i.test(text)) {
      throw new Error(`Electron production bundle contains a source-map reference: ${fileName}`);
    }
    if (text.includes(projectRoot)) {
      throw new Error(`Electron production bundle leaks the local project path: ${fileName}`);
    }

    const leakedSecretIdentifier = forbiddenServerSecretIdentifiers.find((identifier) =>
      text.includes(identifier)
    );
    if (leakedSecretIdentifier) {
      throw new Error(
        `Electron production bundle contains server-only secret binding ${leakedSecretIdentifier}: ${fileName}`
      );
    }

    results.push({
      fileName,
      bytes: content.length,
      sha256: sha256(content),
    });
  }

  return results;
}

async function buildElectronBundles() {
  assertSafeOutputDir(outputDir);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const commonOptions = {
    absWorkingDir: projectRoot,
    outdir: outputDir,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ["node18"],
    packages: "external",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    treeShaking: true,
    metafile: true,
    logLevel: "warning",
  };
  const workerResult = await esbuild.build({
    ...commonOptions,
    entryPoints: {
      sherpaStreamingWorker: entryPoints.sherpaStreamingWorker,
      databaseWorker: entryPoints.databaseWorker,
    },
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  });
  verifyMetafile(workerResult.metafile);

  const workerBundle = fs.readFileSync(path.join(outputDir, "sherpaStreamingWorker.js"));
  const workerSha256 = sha256(workerBundle);
  const mainResult = await esbuild.build({
    ...commonOptions,
    entryPoints: {
      main: entryPoints.main,
      preload: entryPoints.preload,
      macPrivacyDragHelperPreload: entryPoints.macPrivacyDragHelperPreload,
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      __CHORDVOX_STREAMING_WORKER_SHA256__: JSON.stringify(workerSha256),
    },
  });
  verifyMetafile(mainResult.metafile);

  return verifyElectronBundles(outputDir);
}

async function main() {
  const verifyOnly = process.argv.includes("--verify-only");
  const results = verifyOnly ? verifyElectronBundles(outputDir) : await buildElectronBundles();

  for (const result of results) {
    console.log(
      `[build-electron] ${result.fileName}: ${result.bytes} bytes sha256=${result.sha256}`
    );
  }
  console.log(`[build-electron] ${verifyOnly ? "Verification" : "Build and verification"} passed.`);
}

module.exports = {
  buildElectronBundles,
  entryPoints,
  expectedOutputs,
  outputDir,
  verifyElectronBundles,
  verifyMetafile,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[build-electron] ${error.stack || error.message}`);
    process.exit(1);
  });
}
