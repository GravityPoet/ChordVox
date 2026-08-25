#!/usr/bin/env node
/**
 * Downloads nircmd.exe for Windows builds.
 *
 * nircmd is a small utility for Windows that allows sending keyboard input
 * and other system commands. Used for fast clipboard paste operations.
 *
 * Source: https://www.nirsoft.net/utils/nircmd.html
 * License: Free for non-commercial use
 */

const fs = require("fs");
const path = require("path");
const { downloadFileVerified, extractZip } = require("./lib/download-utils");

const NIRCMD_URL = "https://www.nirsoft.net/utils/nircmd-x64.zip";
const NIRCMD_SHA256 = "51e34ed379dd099a96bbf0a2266003361e2864fe3ef2f8baed76634909763a7c";
const BIN_DIR = path.join(__dirname, "..", "resources", "bin");
const NIRCMD_PATH = path.join(BIN_DIR, "nircmd.exe");

async function main() {
  // Skip if not Windows and not building for all platforms
  if (process.platform !== "win32" && !process.argv.includes("--all")) {
    console.log("\nSkipping nircmd.exe download (Windows-only utility)\n");
    return;
  }

  console.log("\nDownloading nircmd.exe for Windows...\n");

  // Create bin directory
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // Check if already exists
  if (fs.existsSync(NIRCMD_PATH)) {
    console.log("  nircmd.exe already exists, skipping\n");
    return;
  }

  const zipPath = path.join(BIN_DIR, "nircmd-x64.zip");

  try {
    console.log(`  Downloading from ${NIRCMD_URL}`);
    await downloadFileVerified(NIRCMD_URL, zipPath, NIRCMD_SHA256);

    console.log("  Extracting...");
    const extractDir = path.join(BIN_DIR, "temp-nircmd");
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);

    // Copy nircmd.exe to bin directory
    const extractedPath = path.join(extractDir, "nircmd.exe");
    if (fs.existsSync(extractedPath)) {
      fs.copyFileSync(extractedPath, NIRCMD_PATH);
      const stats = fs.statSync(NIRCMD_PATH);
      console.log(`  ✓ nircmd.exe downloaded (${Math.round(stats.size / 1024)}KB)\n`);
    } else {
      console.error("  ✗ nircmd.exe not found in archive\n");
      process.exit(1);
    }

    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.unlinkSync(zipPath);
  } catch (error) {
    console.error(`  ✗ Failed to download nircmd.exe: ${error.message}\n`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    process.exit(1);
  }
}

main().catch(console.error);
