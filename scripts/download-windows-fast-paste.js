#!/usr/bin/env node
/**
 * Downloads prebuilt Windows fast-paste binary from GitHub releases.
 * Used for terminal-aware clipboard paste on Windows.
 *
 * Usage:
 *   node scripts/download-windows-fast-paste.js [--force]
 *
 * Options:
 *   --force    Re-download even if binary already exists
 */

const fs = require("fs");
const path = require("path");
const {
  downloadFileVerified,
  extractZip,
  fetchReleaseWithLegacyFallback,
  parseRepoList,
  setExecutable,
} = require("./lib/download-utils");

const PRIMARY_REPO_CANDIDATES = [
  process.env.CHORDVOX_WINDOWS_FAST_PASTE_REPO,
  ...parseRepoList(process.env.CHORDVOX_WINDOWS_BIN_REPOS),
  process.env.CHORDVOX_WINDOWS_BIN_REPO,
  "GravityPoet/ChordVox",
  "GravityPoet/ChordVox-Pro",
].filter(Boolean);
const LEGACY_REPO_OWNER = ["Open", "Whispr"].join("");
const LEGACY_REPO_NAME = ["open", "whispr"].join("");
const LEGACY_REPO_CANDIDATES =
  process.env.CHORDVOX_ALLOW_LEGACY_WINDOWS_BIN_FALLBACK === "1"
    ? [`${LEGACY_REPO_OWNER}/${LEGACY_REPO_NAME}`]
    : [];
const TAG_PREFIX = "windows-fast-paste-v";
const DEFAULT_RELEASE_TAG = "windows-fast-paste-v1.0.0";
const ZIP_NAME = "windows-fast-paste-win32-x64.zip";
const BINARY_NAME = "windows-fast-paste.exe";

const VERSION_OVERRIDE = process.env.WINDOWS_FAST_PASTE_VERSION || null;

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

function resolveReleaseTag(versionOverride) {
  const normalizedOverride = String(versionOverride || "").trim();
  if (!normalizedOverride) return DEFAULT_RELEASE_TAG;
  if (normalizedOverride.startsWith(TAG_PREFIX)) return normalizedOverride;
  return `${TAG_PREFIX}${normalizedOverride.startsWith("v") ? normalizedOverride : `v${normalizedOverride}`}`;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("[windows-fast-paste] Skipping download (not Windows)");
    return;
  }

  const forceDownload = process.argv.includes("--force");
  const outputPath = path.join(BIN_DIR, BINARY_NAME);

  if (fs.existsSync(outputPath) && !forceDownload) {
    console.log("[windows-fast-paste] Already exists (use --force to re-download)");
    console.log(`  ${outputPath}`);
    return;
  }

  const releaseTag = resolveReleaseTag(VERSION_OVERRIDE);
  if (VERSION_OVERRIDE) {
    console.log(`\n[windows-fast-paste] Using pinned release tag: ${releaseTag}`);
  } else {
    console.log(`\n[windows-fast-paste] Using default release tag: ${releaseTag}`);
  }
  const { release, sourceType, reposChecked } = await fetchReleaseWithLegacyFallback({
    primaryRepos: PRIMARY_REPO_CANDIDATES,
    legacyRepos: LEGACY_REPO_CANDIDATES,
    options: { exactTag: releaseTag },
    componentLabel: "windows-fast-paste",
  });

  if (!release) {
    console.error("[windows-fast-paste] Could not find release tag:", releaseTag);
    console.log("[windows-fast-paste] Repositories checked:", reposChecked.join(", "));
    if (LEGACY_REPO_CANDIDATES.length === 0) {
      console.log(
        "[windows-fast-paste] Legacy Windows helper fallback is disabled by default. Set CHORDVOX_ALLOW_LEGACY_WINDOWS_BIN_FALLBACK=1 for a temporary fallback."
      );
    }
    console.log("[windows-fast-paste] Paste will use nircmd/PowerShell fallback");
    return;
  }

  if (sourceType === "legacy") {
    console.warn(
      "[windows-fast-paste] WARNING: using legacy upstream fallback from the historical release source."
    );
    console.warn(
      "[windows-fast-paste] Mirror this asset to GravityPoet/ChordVox or GravityPoet/ChordVox-Pro to restore the primary release chain."
    );
  }

  const zipAsset = release.assets.find((a) => a.name === ZIP_NAME);
  if (!zipAsset) {
    console.error(`[windows-fast-paste] Release ${release.tag} does not contain ${ZIP_NAME}`);
    console.log(
      "[windows-fast-paste] Available assets:",
      release.assets.map((a) => a.name).join(", ")
    );
    return;
  }

  console.log(`\nDownloading Windows fast-paste (${release.tag}) from ${release.repo}...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const zipPath = path.join(BIN_DIR, ZIP_NAME);
  console.log(`  Downloading from: ${zipAsset.url}`);

  try {
    await downloadFileVerified(zipAsset.url, zipPath, zipAsset.digest);

    const extractDir = path.join(BIN_DIR, "temp-windows-fast-paste");
    fs.mkdirSync(extractDir, { recursive: true });

    console.log("  Extracting...");
    await extractZip(zipPath, extractDir);

    const binaryPath = path.join(extractDir, BINARY_NAME);
    if (fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  Extracted to: ${BINARY_NAME}`);
    } else {
      throw new Error(`Binary not found in archive: ${BINARY_NAME}`);
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    const stats = fs.statSync(outputPath);
    console.log(
      `\n[windows-fast-paste] Successfully downloaded ${release.tag} from ${release.repo} (${Math.round(stats.size / 1024)}KB)`
    );
  } catch (error) {
    console.error(`\n[windows-fast-paste] Download failed: ${error.message}`);

    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    console.log("[windows-fast-paste] Paste will use nircmd/PowerShell fallback");
  }
}

main().catch((error) => {
  console.error("[windows-fast-paste] Unexpected error:", error);
  // Don't fail the build
});
