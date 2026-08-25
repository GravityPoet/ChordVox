#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  readPackagedSourceSha,
  resolveAsarPathForExecutable,
  resolveGitSourceSha,
} = require("./lib/release-metadata");

const repoRoot = path.resolve(__dirname, "..");
const defaultFixture = path.join(repoRoot, "tests", "fixtures", "dictation", "release-en.wav");
const defaultModel = path.join(repoRoot, ".cache", "release-dictation-model", "ggml-tiny.bin");
const installedMacExecutable = "/Applications/ChordVox.app/Contents/MacOS/ChordVox";

function getInstalledMacPids() {
  const escapedExecutable = installedMacExecutable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const result = spawnSync("/usr/bin/pgrep", ["-f", `^${escapedExecutable}(?:\\s|$)`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function getEnv(name) {
  return String(process.env[name] || "").trim();
}

function getArgValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  if (!argv[index + 1]) throw new Error(`${name} requires a value`);
  return argv[index + 1];
}

function readCommand(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}`);
  }
  return String(result.stdout || "").trim();
}

function ensureCleanGitTree() {
  if (getEnv("CHORDVOX_PACKAGED_DICTATION_ALLOW_DIRTY") === "1") return;
  const status = readCommand("git", ["status", "--porcelain=v1"]);
  if (status) {
    throw new Error(
      "Packaged dictation proof must run from a clean Git worktree. Commit or stash changes first."
    );
  }
}

function requireFile(filePath, label, minimumSize) {
  const resolvedPath = path.resolve(repoRoot, filePath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new Error(`${label} not found: ${resolvedPath}`);
  }
  if (fs.statSync(resolvedPath).size < minimumSize) {
    throw new Error(`${label} is too small to be valid: ${resolvedPath}`);
  }
  return resolvedPath;
}

function stopInstalledMacApp() {
  spawnSync(
    "/usr/bin/osascript",
    ["-e", 'tell application id "com.gravitypoet.chordvox" to quit'],
    { stdio: "ignore" }
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (getInstalledMacPids().length === 0) return;
    spawnSync("/bin/sleep", ["0.5"], { stdio: "ignore" });
  }

  // The app intentionally delays `before-quit` while stopping native services;
  // AppleScript reports that cancellation even when shutdown is still pending.
  // This runner owns the explicit stop/start window, so terminate only the
  // exact installed main-process PIDs after the graceful window has elapsed.
  const lingeringPids = getInstalledMacPids();
  for (const pid of lingeringPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (getInstalledMacPids().length === 0) return;
    spawnSync("/bin/sleep", ["0.5"], { stdio: "ignore" });
  }

  for (const pid of getInstalledMacPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (getInstalledMacPids().length === 0) return;
    spawnSync("/bin/sleep", ["0.5"], { stdio: "ignore" });
  }
  throw new Error("Installed ChordVox did not quit before packaged acceptance.");
}

function restartInstalledMacApp() {
  spawnSync("/usr/bin/open", ["-na", "/Applications/ChordVox.app"], { stdio: "ignore" });
}

function runPlaywright(env) {
  const args = ["test", "tests/e2e/packaged-dictation.real.spec.ts"];
  // A .cmd shim is not a native executable. Node can return EINVAL when a
  // Windows ARM guest launches npx.cmd through spawnSync, so invoke the
  // Playwright CLI with the same Node binary directly on Windows.
  const command = process.platform === "win32" ? process.execPath : "npx";
  const commandArgs =
    process.platform === "win32"
      ? [require.resolve("@playwright/test/cli"), ...args]
      : ["playwright", ...args];
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
}

function main() {
  const argv = process.argv.slice(2);
  const installedMac = argv.includes("--installed-mac");
  if (installedMac && process.platform !== "darwin") {
    throw new Error("--installed-mac can only run on macOS");
  }

  ensureCleanGitTree();
  const checkoutSourceSha = resolveGitSourceSha(repoRoot);
  const executable = requireFile(
    installedMac
      ? installedMacExecutable
      : getArgValue(argv, "--executable") || getEnv("CHORDVOX_PACKAGED_APP_EXECUTABLE"),
    "Packaged app executable",
    16_384
  );
  const packagedAsarPath = resolveAsarPathForExecutable(executable);
  const packagedSourceSha = readPackagedSourceSha(packagedAsarPath);
  const expectedSourceSha = getEnv("CHORDVOX_PACKAGED_EXPECTED_SOURCE_SHA") || checkoutSourceSha;
  if (packagedSourceSha !== expectedSourceSha) {
    throw new Error(
      `Packaged source SHA mismatch: expected ${expectedSourceSha}, found ${packagedSourceSha} in ${packagedAsarPath}`
    );
  }
  // Evidence must be bound to the package metadata, not merely to the checkout
  // from which this verifier happened to be invoked.
  const sourceSha = packagedSourceSha;
  const fixture = requireFile(
    getArgValue(argv, "--audio") ||
      getEnv("CHORDVOX_PACKAGED_DICTATION_AUDIO_FILE") ||
      defaultFixture,
    "Fixed WAV fixture",
    2_048
  );
  const model = requireFile(
    getArgValue(argv, "--model") ||
      getEnv("CHORDVOX_PACKAGED_DICTATION_WHISPER_MODEL") ||
      defaultModel,
    "Whisper model",
    1_000_000
  );
  const expectedPlatform =
    getArgValue(argv, "--platform") ||
    getEnv("CHORDVOX_PACKAGED_EXPECTED_PLATFORM") ||
    process.platform;
  const evidencePath = path.resolve(
    repoRoot,
    getArgValue(argv, "--evidence") ||
      getEnv("CHORDVOX_PACKAGED_EVIDENCE_PATH") ||
      path.join(
        "dist",
        `native-runtime-evidence-${installedMac ? "macos-installed" : expectedPlatform}.json`
      )
  );
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  if (fs.existsSync(evidencePath)) fs.unlinkSync(evidencePath);

  const env = {
    ...process.env,
    CHORDVOX_E2E: "0",
    CHORDVOX_PACKAGED_DICTATION: "1",
    CHORDVOX_PACKAGED_APP_EXECUTABLE: executable,
    CHORDVOX_PACKAGED_DICTATION_AUDIO_FILE: fixture,
    CHORDVOX_PACKAGED_DICTATION_WHISPER_MODEL: model,
    CHORDVOX_PACKAGED_EXPECTED_PLATFORM: expectedPlatform,
    CHORDVOX_PACKAGED_EVIDENCE_PATH: evidencePath,
    CHORDVOX_PACKAGED_SOURCE_SHA: sourceSha,
    CHORDVOX_PACKAGED_EXPECTED_SOURCE_SHA: expectedSourceSha,
    CHORDVOX_PACKAGED_INSTALL_KIND: installedMac ? "installed" : "packaged",
  };

  console.log(`[packaged-real-dictation] executable: ${executable}`);
  console.log(`[packaged-real-dictation] fixed WAV: ${fixture}`);
  console.log(`[packaged-real-dictation] source SHA: ${sourceSha}`);

  if (installedMac) stopInstalledMacApp();
  let result;
  try {
    result = runPlaywright(env);
  } finally {
    if (installedMac) restartInstalledMacApp();
  }

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Packaged dictation Playwright gate exited with code ${result.status}`);
  }
  if (!fs.existsSync(evidencePath)) {
    throw new Error("Packaged dictation test exited without producing runtime evidence.");
  }

  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  if (
    evidence.sourceSha !== sourceSha ||
    evidence.appIsPackaged !== true ||
    evidence.userDataIsolated !== true ||
    evidence.transcriptMatched !== true ||
    evidence.trustedButtonClicks !== true ||
    evidence.trustedPasteInput !== true ||
    evidence.pasteTargetProcessDistinct !== true
  ) {
    throw new Error("Packaged dictation evidence is incomplete or does not match the source SHA.");
  }

  console.log(`[packaged-real-dictation] PASSED: ${evidencePath}`);
}

try {
  main();
} catch (error) {
  console.error(`[packaged-real-dictation] FAILED: ${error.message || error}`);
  process.exit(1);
}
