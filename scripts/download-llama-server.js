#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  downloadFileVerified,
  extractArchive,
  fetchLatestRelease,
  findBinaryInDir,
  parseArgs,
  setExecutable,
} = require("./lib/download-utils");
const { validateDarwinLlamaRuntime } = require("./lib/macos-runtime-verification");

const LLAMA_CPP_REPO = "ggerganov/llama.cpp";
const VERSION_OVERRIDE = process.env.LLAMA_CPP_VERSION || null;

const BINARIES = {
  "darwin-arm64": {
    assetPattern: /^llama-.*-bin-macos-arm64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-darwin-arm64",
    libPattern: "*.dylib",
    ownedLibraryPattern: /^lib(?:ggml.*|llama.*|mtmd.*)\.dylib$/,
  },
  "darwin-x64": {
    assetPattern: /^llama-.*-bin-macos-x64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-darwin-x64",
    libPattern: "*.dylib",
    ownedLibraryPattern: /^lib(?:ggml.*|llama.*|mtmd.*)\.dylib$/,
  },
  "win32-x64": {
    assetPattern: /^llama-.*-bin-win-cpu-x64\.zip$/,
    binaryPath: "build/bin/llama-server.exe",
    outputName: "llama-server-win32-x64.exe",
    libPattern: "*.dll",
    ownedLibraryPattern:
      /^(?:cargs|ggml.*|libomp.*|llama|llama-common|llama-server-impl|mtmd)\.dll$/i,
    requiredLibraryNames: [
      "llama-server-impl.dll",
      "llama-common.dll",
      "llama.dll",
      "ggml.dll",
      "ggml-base.dll",
      "mtmd.dll",
    ],
  },
  "linux-x64": {
    assetPattern: /^llama-.*-bin-ubuntu-x64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-linux-x64",
    libPattern: "*.so*",
    ownedLibraryPattern: /^lib(?:ggml.*|llama.*|mtmd.*)\.so(?:\.\d+)*$/,
    requiredLibraryNames: ["libllama.so.0", "libggml.so.0", "libggml-base.so.0", "libmtmd.so.0"],
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");
let cachedRelease = null;

async function getRelease() {
  if (cachedRelease) return cachedRelease;
  cachedRelease = VERSION_OVERRIDE
    ? await fetchLatestRelease(LLAMA_CPP_REPO, { tagPrefix: VERSION_OVERRIDE })
    : await fetchLatestRelease(LLAMA_CPP_REPO);
  return cachedRelease;
}

function findAsset(release, pattern) {
  return release?.assets?.find((asset) => pattern.test(asset.name));
}

function matchesPattern(filename, pattern) {
  if (pattern === "*.dylib") return filename.endsWith(".dylib");
  if (pattern === "*.dll") return filename.endsWith(".dll");
  if (pattern === "*.so*") return /\.so(?:\.\d+)*$/.test(filename);
  return false;
}

function findLibrariesInDir(dir, pattern, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];

  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findLibrariesInDir(fullPath, pattern, maxDepth, currentDepth + 1));
    } else if ((entry.isFile() || entry.isSymbolicLink()) && matchesPattern(entry.name, pattern)) {
      results.push(fullPath);
    }
  }
  return results;
}

function listOwnedLibraryNames(binDir, config) {
  if (!fs.existsSync(binDir)) return [];
  return fs
    .readdirSync(binDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && config.ownedLibraryPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function getPlatformName(platformArch) {
  return platformArch.slice(0, platformArch.lastIndexOf("-"));
}

function getConflictingServerPaths(platformArch, config, binDir = BIN_DIR) {
  if (!fs.existsSync(binDir)) return [];
  const prefix = `llama-server-${getPlatformName(platformArch)}-`;
  return fs
    .readdirSync(binDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name !== config.outputName
    )
    .map((entry) => path.join(binDir, entry.name));
}

function readPortableArchitecture(filePath, platform) {
  const buffer = fs.readFileSync(filePath);

  if (platform === "win32") {
    if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") return null;
    const peOffset = buffer.readUInt32LE(0x3c);
    if (
      peOffset + 6 > buffer.length ||
      buffer.toString("binary", peOffset, peOffset + 4) !== "PE\0\0"
    ) {
      return null;
    }
    const machine = buffer.readUInt16LE(peOffset + 4);
    if (machine === 0x8664) return "x64";
    if (machine === 0xaa64) return "arm64";
    return `machine-0x${machine.toString(16)}`;
  }

  if (platform === "linux") {
    if (buffer.length < 20 || buffer[0] !== 0x7f || buffer.toString("ascii", 1, 4) !== "ELF") {
      return null;
    }
    const machine = buffer[5] === 2 ? buffer.readUInt16BE(18) : buffer.readUInt16LE(18);
    if (machine === 0x3e) return "x64";
    if (machine === 0xb7) return "arm64";
    return `machine-0x${machine.toString(16)}`;
  }

  return null;
}

function validatePortableLlamaRuntime({
  binaryPath,
  expectedArchitecture,
  libraryDir,
  ownedLibraryNames,
  platform,
  requiredLibraryNames = [],
}) {
  for (const libraryName of requiredLibraryNames) {
    if (!ownedLibraryNames.includes(libraryName)) {
      return { ok: false, reason: `Missing llama runtime library: ${libraryName}` };
    }
  }

  const files = [binaryPath, ...ownedLibraryNames.map((name) => path.join(libraryDir, name))];
  for (const filePath of files) {
    let architecture;
    try {
      architecture = readPortableArchitecture(filePath, platform);
    } catch (error) {
      return {
        ok: false,
        reason: `Could not inspect ${path.basename(filePath)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!architecture) {
      return { ok: false, reason: `${path.basename(filePath)} is not a valid ${platform} binary` };
    }
    if (architecture !== expectedArchitecture) {
      return {
        ok: false,
        reason: `${path.basename(filePath)} is ${architecture}, expected ${expectedArchitecture}`,
      };
    }
  }

  return { ok: true, checkedLibraries: [...ownedLibraryNames] };
}

function inspectExistingRuntime(platformArch, config, binDir = BIN_DIR, spawnSyncImpl) {
  const outputPath = path.join(binDir, config.outputName);
  if (!fs.existsSync(outputPath)) {
    return { ok: false, exists: false, reason: `${config.outputName} is missing` };
  }

  const ownedLibraryNames = listOwnedLibraryNames(binDir, config);
  if (platformArch.startsWith("darwin-")) {
    const result = validateDarwinLlamaRuntime({
      binaryPath: outputPath,
      expectedArchitecture: platformArch.slice("darwin-".length),
      libraryDir: binDir,
      ownedLibraryNames,
      spawnSyncImpl,
    });
    return { ...result, exists: true, ownedLibraryNames };
  }

  const platform = getPlatformName(platformArch);
  const result = validatePortableLlamaRuntime({
    binaryPath: outputPath,
    expectedArchitecture: platformArch.slice(platform.length + 1),
    libraryDir: binDir,
    ownedLibraryNames,
    platform,
    requiredLibraryNames: config.requiredLibraryNames,
  });
  return { ...result, exists: true, ownedLibraryNames };
}

function getRuntimeFilesToReplace(platformArch, config, binDir = BIN_DIR) {
  const candidates = [
    path.join(binDir, config.outputName),
    ...listOwnedLibraryNames(binDir, config).map((name) => path.join(binDir, name)),
    ...getConflictingServerPaths(platformArch, config, binDir),
  ];
  return [...new Set(candidates)].filter((filePath) => fs.existsSync(filePath));
}

function removeConflictingServerFiles(platformArch, config, binDir = BIN_DIR) {
  for (const filePath of getConflictingServerPaths(platformArch, config, binDir)) {
    console.log(`  ${platformArch}: Removing conflicting server ${path.basename(filePath)}`);
    fs.rmSync(filePath, { force: true });
  }
}

function stageRuntime(binaryPath, libraries, config, binDir = BIN_DIR) {
  const stageDir = fs.mkdtempSync(
    path.join(binDir, `.llama-stage-${path.basename(config.outputName)}-`)
  );
  try {
    const stagedBinaryPath = path.join(stageDir, config.outputName);
    fs.copyFileSync(binaryPath, stagedBinaryPath);
    setExecutable(stagedBinaryPath);

    const copiedNames = new Set();
    for (const libraryPath of libraries) {
      const libraryName = path.basename(libraryPath);
      if (!config.ownedLibraryPattern.test(libraryName) || copiedNames.has(libraryName)) continue;
      copiedNames.add(libraryName);
      const stagedLibraryPath = path.join(stageDir, libraryName);
      fs.copyFileSync(libraryPath, stagedLibraryPath);
      setExecutable(stagedLibraryPath);
    }
    if (copiedNames.size === 0) {
      throw new Error(`No owned llama runtime libraries found for ${config.outputName}`);
    }

    return { stageDir, stagedBinaryPath, stagedLibraryNames: [...copiedNames].sort() };
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function assertRuntimeValid(platformArch, config, libraryDir) {
  const validation = inspectExistingRuntime(platformArch, config, libraryDir);
  if (!validation.ok) {
    throw new Error(`Invalid ${platformArch} llama runtime: ${validation.reason}`);
  }
}

function installStagedRuntime(platformArch, config, stageDir, binDir = BIN_DIR) {
  const stagedFiles = fs
    .readdirSync(stageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(stageDir, entry.name));
  const previousFiles = getRuntimeFilesToReplace(platformArch, config, binDir);
  const backupDir = fs.mkdtempSync(path.join(binDir, `.llama-backup-${platformArch}-`));
  const installedPaths = [];
  const backedUpPaths = [];

  try {
    for (const previousPath of previousFiles) {
      const backupPath = path.join(backupDir, path.basename(previousPath));
      fs.renameSync(previousPath, backupPath);
      backedUpPaths.push({ previousPath, backupPath });
    }

    for (const stagedPath of stagedFiles) {
      const destinationPath = path.join(binDir, path.basename(stagedPath));
      fs.renameSync(stagedPath, destinationPath);
      setExecutable(destinationPath);
      installedPaths.push(destinationPath);
    }

    assertRuntimeValid(platformArch, config, binDir);
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    for (const installedPath of installedPaths) {
      fs.rmSync(installedPath, { force: true });
    }
    for (const { previousPath, backupPath } of backedUpPaths.reverse()) {
      if (fs.existsSync(backupPath)) fs.renameSync(backupPath, previousPath);
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
}

async function downloadBinary(platformArch, config, release, isForce = false) {
  if (!config) {
    console.log(`  ${platformArch}: Not supported`);
    return false;
  }

  const existing = inspectExistingRuntime(platformArch, config);
  if (existing.ok && !isForce) {
    removeConflictingServerFiles(platformArch, config);
    console.log(
      `  ${platformArch}: Existing server and dependencies match the target architecture`
    );
    return true;
  }
  if (existing.exists && !isForce) {
    console.warn(
      `  ${platformArch}: Existing runtime is invalid (${existing.reason}); refreshing it`
    );
  }

  const asset = findAsset(release, config.assetPattern);
  if (!asset) {
    console.error(`  ${platformArch}: No matching asset found for pattern ${config.assetPattern}`);
    return false;
  }

  console.log(`  ${platformArch}: Downloading from ${asset.url}`);
  const archivePath = path.join(
    BIN_DIR,
    `.llama-download-${platformArch}-${process.pid}-${Date.now()}-${asset.name}`
  );
  const extractDir = fs.mkdtempSync(path.join(BIN_DIR, `.llama-extract-${platformArch}-`));
  let stageDir = "";

  try {
    await downloadFileVerified(asset.url, archivePath, asset.digest);
    await extractArchive(archivePath, extractDir);

    const binaryName = path.basename(config.binaryPath);
    let binaryPath = path.join(extractDir, config.binaryPath);
    if (!fs.existsSync(binaryPath)) {
      binaryPath = findBinaryInDir(extractDir, binaryName);
    }
    if (!binaryPath || !fs.existsSync(binaryPath)) {
      throw new Error(`Binary '${binaryName}' not found in archive`);
    }

    const libraries = findLibrariesInDir(extractDir, config.libPattern);
    if (libraries.length === 0) {
      throw new Error(`No ${config.libPattern} runtime libraries found in archive`);
    }

    const staged = stageRuntime(binaryPath, libraries, config);
    stageDir = staged.stageDir;
    assertRuntimeValid(platformArch, config, stageDir);
    installStagedRuntime(platformArch, config, stageDir);

    console.log(`  ${platformArch}: Installed ${config.outputName}`);
    for (const libraryName of staged.stagedLibraryNames) {
      console.log(`  ${platformArch}: Installed library ${libraryName}`);
    }
    return true;
  } catch (error) {
    console.error(`  ${platformArch}: Failed - ${error.message}`);
    return false;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (stageDir) fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function printAvailableBinaries() {
  console.log("\n---");
  const files = fs.existsSync(BIN_DIR)
    ? fs.readdirSync(BIN_DIR).filter((file) => file.startsWith("llama-server"))
    : [];
  if (files.length === 0) {
    console.log("No binaries downloaded yet.");
    console.log(`\nMake sure release exists: https://github.com/${LLAMA_CPP_REPO}/releases`);
    return;
  }

  console.log("Available llama-server binaries:\n");
  for (const file of files) {
    const stats = fs.statSync(path.join(BIN_DIR, file));
    console.log(`  - ${file} (${Math.round(stats.size / 1024 / 1024)}MB)`);
  }
}

async function main() {
  const args = parseArgs();
  fs.mkdirSync(BIN_DIR, { recursive: true });

  if (args.isCurrent && !BINARIES[args.platformArch]) {
    throw new Error(`Unsupported platform/arch: ${args.platformArch}`);
  }
  if (!args.isCurrent) {
    throw new Error(
      "llama-server runtimes must be prepared one target at a time because macOS architectures use conflicting shared libraries. Use --current with explicit --platform and --arch values."
    );
  }

  if (args.isCurrent && !args.isForce) {
    const config = BINARIES[args.platformArch];
    const existing = inspectExistingRuntime(args.platformArch, config);
    if (existing.ok) {
      removeConflictingServerFiles(args.platformArch, config);
      console.log(
        `\n[llama-server] ${args.platformArch} server and dependencies already match the target architecture.`
      );
      printAvailableBinaries();
      return;
    }
    if (existing.exists) {
      console.warn(
        `\n[llama-server] Existing ${args.platformArch} runtime failed validation: ${existing.reason}`
      );
    }
  }

  console.log(
    VERSION_OVERRIDE
      ? `\n[llama-server] Using pinned version: ${VERSION_OVERRIDE}`
      : "\n[llama-server] Fetching latest release..."
  );
  const release = await getRelease();
  if (!release) {
    throw new Error(`Could not fetch release from ${LLAMA_CPP_REPO}`);
  }

  console.log(`\nDownloading llama-server binaries (${release.tag})...\n`);
  console.log(`Downloading for target platform (${args.platformArch}):`);
  const ok = await downloadBinary(
    args.platformArch,
    BINARIES[args.platformArch],
    release,
    args.isForce
  );
  if (!ok) throw new Error(`Failed to download binaries for ${args.platformArch}`);
  if (args.shouldCleanup) {
    removeConflictingServerFiles(args.platformArch, BINARIES[args.platformArch]);
  }

  printAvailableBinaries();
}

module.exports = {
  BINARIES,
  BIN_DIR,
  downloadBinary,
  findLibrariesInDir,
  getConflictingServerPaths,
  getRuntimeFilesToReplace,
  inspectExistingRuntime,
  listOwnedLibraryNames,
  readPortableArchitecture,
  stageRuntime,
  validatePortableLlamaRuntime,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[llama-server] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
