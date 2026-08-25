#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const defaultAudioFixture = path.join(repoRoot, "tests", "fixtures", "dictation", "release-en.wav");

function getEnv(name) {
  return String(process.env[name] || "").trim();
}

function resolveRequiredFile(primaryName, fallbackName, defaultPath, label) {
  const rawValue = getEnv(primaryName) || getEnv(fallbackName) || defaultPath;
  if (!rawValue) {
    throw new Error(
      `Set ${primaryName} to the fixed release ${label.toLowerCase()} path before publishing.`
    );
  }
  const resolvedPath = path.resolve(repoRoot, rawValue);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `${label} not found: ${resolvedPath}\n` +
        `Set ${primaryName} to the fixed release ${label.toLowerCase()} path before publishing.`
    );
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`${label} is not a file: ${resolvedPath}`);
  }

  return { path: resolvedPath, size: stats.size };
}

function run(command, args, options = {}) {
  const executable =
    process.platform === "win32" && !command.endsWith(".cmd") ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...options.env,
    },
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}`);
  }
}

function readCommand(command, args) {
  const executable =
    process.platform === "win32" && !command.endsWith(".cmd") ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}`);
  }
  return String(result.stdout || "").trim();
}

function resolveGitSha() {
  return readCommand("git", ["rev-parse", "HEAD"]);
}

function ensureCleanGitTree() {
  if (getEnv("CHORDVOX_RELEASE_DICTATION_ALLOW_DIRTY") === "1") {
    console.warn("[release-real-dictation] WARNING: dirty worktree check bypassed.");
    return;
  }

  const status = readCommand("git", ["status", "--porcelain=v1"]);
  if (status) {
    throw new Error(
      "Release dictation proof must run from a clean Git worktree.\n" +
        "Commit or stash local changes first, then rerun this gate on the exact source SHA.\n" +
        "For one-off local debugging only, set CHORDVOX_RELEASE_DICTATION_ALLOW_DIRTY=1."
    );
  }
}

function main() {
  const sourceSha = resolveGitSha();
  ensureCleanGitTree();

  const audioFixture = resolveRequiredFile(
    "CHORDVOX_RELEASE_DICTATION_AUDIO_FILE",
    "CHORDVOX_E2E_REAL_FAKE_AUDIO_FILE",
    defaultAudioFixture,
    "Audio fixture"
  );
  const whisperModel = resolveRequiredFile(
    "CHORDVOX_RELEASE_DICTATION_WHISPER_MODEL",
    "CHORDVOX_E2E_REAL_WHISPER_MODEL",
    "",
    "Whisper model"
  );

  if (audioFixture.size < 2048) {
    throw new Error(`Audio fixture is too small to be a useful release gate: ${audioFixture.path}`);
  }
  if (whisperModel.size < 1_000_000) {
    throw new Error(`Whisper model is too small to be valid: ${whisperModel.path}`);
  }

  const expectedPattern =
    getEnv("CHORDVOX_RELEASE_DICTATION_EXPECTED_PATTERN") ||
    getEnv("CHORDVOX_E2E_REAL_EXPECTED_PATTERN") ||
    "hello|world|chordvox";

  console.log("[release-real-dictation] Using fixed audio fixture:", audioFixture.path);
  console.log("[release-real-dictation] Using local Whisper model:", whisperModel.path);
  console.log("[release-real-dictation] Expected transcript pattern:", expectedPattern);
  console.log("[release-real-dictation] Source SHA:", sourceSha);

  run("npm", ["run", "build:renderer"]);
  run("npx", ["playwright", "test", "tests/e2e/dictation-flow.real.spec.ts"], {
    env: {
      CHORDVOX_E2E_REAL_DICTATION: "1",
      CHORDVOX_E2E_REAL_FIXTURE_INJECTION: "1",
      CHORDVOX_E2E_REAL_FAKE_AUDIO_FILE: audioFixture.path,
      CHORDVOX_E2E_REAL_WHISPER_MODEL: whisperModel.path,
      CHORDVOX_E2E_REAL_EXPECTED_PATTERN: expectedPattern,
    },
  });

  console.log("[release-real-dictation] PASSED");
  console.log("[release-real-dictation] real_dictation_verified_sha:", sourceSha);
}

try {
  main();
} catch (error) {
  console.error("[release-real-dictation] FAILED");
  console.error(error.message || error);
  process.exit(1);
}
