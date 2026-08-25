#!/usr/bin/env node
/**
 * Downloads prebuilt Windows key listener binary from GitHub releases.
 * Used for Push-to-Talk functionality on Windows.
 *
 * Usage:
 *   node scripts/download-windows-key-listener.js [--force]
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
  process.env.CHORDVOX_WINDOWS_KEY_LISTENER_REPO,
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
const TAG_PREFIX = "windows-key-listener-v";
const DEFAULT_RELEASE_TAG = "windows-key-listener-v1.0.0";
const ZIP_NAME = "windows-key-listener-win32-x64.zip";
const BINARY_NAME = "windows-key-listener.exe";

// Version can be pinned via environment variable for reproducible builds
const VERSION_OVERRIDE = process.env.WINDOWS_KEY_LISTENER_VERSION || null;

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

function resolveReleaseTag(versionOverride) {
  const normalizedOverride = String(versionOverride || "").trim();
  if (!normalizedOverride) return DEFAULT_RELEASE_TAG;
  if (normalizedOverride.startsWith(TAG_PREFIX)) return normalizedOverride;
  return `${TAG_PREFIX}${normalizedOverride.startsWith("v") ? normalizedOverride : `v${normalizedOverride}`}`;
}

async function main() {
  // Only needed on Windows
  if (process.platform !== "win32") {
    console.log("[windows-key-listener] Skipping download (not Windows)");
    return;
  }

  const forceDownload = process.argv.includes("--force");
  const outputPath = path.join(BIN_DIR, BINARY_NAME);

  // Check if already exists
  if (fs.existsSync(outputPath) && !forceDownload) {
    console.log("[windows-key-listener] Already exists (use --force to re-download)");
    console.log(`  ${outputPath}`);
    return;
  }

  // Fetch release (pinned version or latest)
  const releaseTag = resolveReleaseTag(VERSION_OVERRIDE);
  if (VERSION_OVERRIDE) {
    console.log(`\n[windows-key-listener] Using pinned release tag: ${releaseTag}`);
  } else {
    console.log(`\n[windows-key-listener] Using default release tag: ${releaseTag}`);
  }
  const { release, sourceType, reposChecked } = await fetchReleaseWithLegacyFallback({
    primaryRepos: PRIMARY_REPO_CANDIDATES,
    legacyRepos: LEGACY_REPO_CANDIDATES,
    options: { exactTag: releaseTag },
    componentLabel: "windows-key-listener",
  });

  if (!release) {
    console.error("[windows-key-listener] Could not find release tag:", releaseTag);
    console.log("[windows-key-listener] Repositories checked:", reposChecked.join(", "));
    if (LEGACY_REPO_CANDIDATES.length === 0) {
      console.log(
        "[windows-key-listener] Legacy Windows helper fallback is disabled by default. Set CHORDVOX_ALLOW_LEGACY_WINDOWS_BIN_FALLBACK=1 for a temporary fallback."
      );
    }
    console.log(
      "[windows-key-listener] Push-to-Talk will use fallback mode (compile locally or tap mode)"
    );
    return;
  }

  if (sourceType === "legacy") {
    console.warn(
      "[windows-key-listener] WARNING: using legacy upstream fallback from the historical release source."
    );
    console.warn(
      "[windows-key-listener] Mirror this asset to GravityPoet/ChordVox or GravityPoet/ChordVox-Pro to restore the primary release chain."
    );
  }

  // Find the zip asset
  const zipAsset = release.assets.find((a) => a.name === ZIP_NAME);
  if (!zipAsset) {
    console.error(`[windows-key-listener] Release ${release.tag} does not contain ${ZIP_NAME}`);
    console.log(
      "[windows-key-listener] Available assets:",
      release.assets.map((a) => a.name).join(", ")
    );
    return;
  }

  console.log(`\nDownloading Windows key listener (${release.tag}) from ${release.repo}...\n`);

  // Ensure bin directory exists
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const zipPath = path.join(BIN_DIR, ZIP_NAME);
  console.log(`  Downloading from: ${zipAsset.url}`);

  try {
    await downloadFileVerified(zipAsset.url, zipPath, zipAsset.digest);

    // Extract zip
    const extractDir = path.join(BIN_DIR, "temp-windows-key-listener");
    fs.mkdirSync(extractDir, { recursive: true });

    console.log("  Extracting...");
    await extractZip(zipPath, extractDir);

    // Find and copy the binary
    const binaryPath = path.join(extractDir, BINARY_NAME);
    if (fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  Extracted to: ${BINARY_NAME}`);
    } else {
      throw new Error(`Binary not found in archive: ${BINARY_NAME}`);
    }

    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    const stats = fs.statSync(outputPath);
    console.log(
      `\n[windows-key-listener] Successfully downloaded ${release.tag} from ${release.repo} (${Math.round(stats.size / 1024)}KB)`
    );
  } catch (error) {
    console.error(`\n[windows-key-listener] Download failed: ${error.message}`);

    // Cleanup on failure
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    // Don't fail the build - Push-to-Talk can fall back to tap mode
    console.log(
      "[windows-key-listener] Push-to-Talk will use fallback mode (compile locally or tap mode)"
    );
    console.log(
      "[windows-key-listener] To compile locally, install Visual Studio Build Tools or MinGW-w64"
    );
  }
}

main().catch((error) => {
  console.error("[windows-key-listener] Unexpected error:", error);
  // Don't fail the build
});
