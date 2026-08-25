#!/usr/bin/env node
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const asar = require("@electron/asar");
const { FuseV1Options, getCurrentFuseWire } = require("@electron/fuses");
const {
  BINARIES: LLAMA_BINARIES,
  inspectExistingRuntime,
  readPortableArchitecture,
} = require("./download-llama-server");
const {
  canRunDarwinArchitecture,
  findMachOArchitectureMismatches,
  getMachOArchitectures,
  normalizeDarwinArchitecture,
  runLlamaServerHelp,
  validateDarwinLlamaRuntime,
} = require("./lib/macos-runtime-verification");
const {
  MACOS_BUNDLE_ID,
  MACOS_SIGNING_CERTIFICATE_SHA256,
  MACOS_SIGNING_IDENTITY,
  macosCodeRequirement,
} = require("../src/config/macosSigningIdentity");
const { SOURCE_SHA_PATTERN } = require("./lib/release-metadata");

const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const PACKAGED_LLAMA_HELP_TIMEOUT_MS = 60000;
const LINUX_GLIBC_BASELINE = "2.35";
const productName = "ChordVox";
const FUSE_ENABLED = "1".charCodeAt(0);
const FUSE_DISABLED = "0".charCodeAt(0);

function parseArgs(argv) {
  const options = {
    platform: "mac",
    explicitPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--platform") {
      options.platform = argv[index + 1] || options.platform;
      index += 1;
      continue;
    }
    if (!current.startsWith("--") && !options.explicitPath) {
      options.explicitPath = path.resolve(projectRoot, current);
    }
  }

  return options;
}

function log(message) {
  console.log(`[verify-package] ${message}`);
}

function fail(message) {
  console.error(`[verify-package] ${message}`);
  process.exit(1);
}

function fileExists(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function executableExists(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readFileMagic(targetPath, byteCount = 2) {
  const header = Buffer.alloc(byteCount);
  const fd = fs.openSync(targetPath, "r");
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header.toString("latin1");
}

function verifyWindowsPeFile(targetPath, label) {
  if (!fileExists(targetPath)) {
    fail(`Missing Windows ${label}: ${targetPath}`);
  }

  const magic = readFileMagic(targetPath, 2);
  if (magic !== "MZ") {
    fail(
      `Invalid Windows ${label}: expected PE/MZ header, found ${JSON.stringify(
        magic
      )} at ${targetPath}`
    );
  }

  const architecture = readPortableArchitecture(targetPath, "win32");
  if (architecture !== "x64") {
    fail(`Invalid Windows ${label} architecture: expected x64, found ${architecture || "unknown"}`);
  }
}

function verifyLinuxElfFile(targetPath, label) {
  if (!fileExists(targetPath)) {
    fail(`Missing Linux ${label}: ${targetPath}`);
  }

  const architecture = readPortableArchitecture(targetPath, "linux");
  if (architecture !== "x64") {
    fail(`Invalid Linux ${label} architecture: expected x64, found ${architecture || "unknown"}`);
  }
}

function compareDottedVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function assertLinuxGlibcCompatibility(
  targetPath,
  maximumVersion = LINUX_GLIBC_BASELINE,
  spawnSyncImpl = spawnSync
) {
  const result = spawnSyncImpl("readelf", ["--version-info", targetPath], {
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`Unable to inspect glibc requirements for ${targetPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "unknown readelf failure").trim();
    throw new Error(`Unable to inspect glibc requirements for ${targetPath}: ${detail}`);
  }

  const versions = Array.from(String(result.stdout).matchAll(/GLIBC_(\d+(?:\.\d+)+)/g), (match) =>
    match[1]
  );
  if (versions.length === 0) {
    throw new Error(`No glibc requirements found in ${targetPath}`);
  }

  const requiredVersion = versions.reduce((maximum, version) =>
    compareDottedVersions(version, maximum) > 0 ? version : maximum
  );
  if (compareDottedVersions(requiredVersion, maximumVersion) > 0) {
    throw new Error(
      `${targetPath} requires GLIBC_${requiredVersion}; maximum supported GLIBC_${maximumVersion}`
    );
  }

  return requiredVersion;
}

function walkFiles(rootPath) {
  if (!fileExists(rootPath)) return [];
  const results = [];
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(entryPath));
      continue;
    }
    if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results;
}

function listDistDirectories(pattern) {
  if (!fileExists(distRoot)) return [];
  return fs
    .readdirSync(distRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => path.join(distRoot, entry.name));
}

function toResourceRelativePath(filePath, rootPath) {
  return path.relative(rootPath, filePath).replace(/\\/g, "/");
}

function normalizeAsarEntry(entry) {
  const normalized = String(entry).trim().replace(/\\/g, "/");
  if (!normalized) return "";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function toAsarLookupPath(entry, separator = path.sep) {
  return normalizeAsarEntry(entry).replace(/^\//, "").split("/").join(separator);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256NormalizedLegalText(buffer) {
  const normalized = Buffer.from(buffer.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
  return sha256(normalized);
}

function extractAsarFile(asarPath, entry) {
  const lookupPath = toAsarLookupPath(entry);
  try {
    return asar.extractFile(asarPath, lookupPath);
  } catch (error) {
    fail(`Unable to extract ${entry} from app.asar: ${error.message}`);
  }
}

function isFirstPartyCodePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("node_modules/")) return false;
  return /\.(?:cjs|mjs|js|jsx|ts|tsx)$/i.test(normalized);
}

function collectFirstPartySourceHashes() {
  const roots = [
    path.join(projectRoot, "main.js"),
    path.join(projectRoot, "preload.js"),
    path.join(projectRoot, "macPrivacyDragHelperPreload.js"),
    path.join(projectRoot, "src"),
  ];
  const hashes = new Map();

  for (const root of roots) {
    const candidates = fs.statSync(root).isDirectory() ? walkFiles(root) : [root];
    for (const candidate of candidates) {
      const relative = path.relative(projectRoot, candidate).replace(/\\/g, "/");
      if (relative.startsWith("src/dist/") || !/\.(?:cjs|mjs|js|jsx|ts|tsx)$/i.test(relative)) {
        continue;
      }
      const digest = sha256(fs.readFileSync(candidate));
      const existing = hashes.get(digest) || [];
      existing.push(relative);
      hashes.set(digest, existing);
    }
  }

  return hashes;
}

function resolvePackage(platform, explicitPath) {
  if (platform === "mac") {
    const candidates = [
      explicitPath,
      path.join(distRoot, ".mac-dmg-work", "mac-arm64", `${productName}.app`),
      path.join(distRoot, ".mac-dmg-work", "mac-x64", `${productName}.app`),
      path.join(distRoot, ".mac-dmg-work", "mac", `${productName}.app`),
      path.join(distRoot, "mac-arm64", `${productName}.app`),
      path.join(distRoot, "mac-x64", `${productName}.app`),
      path.join(distRoot, "mac", `${productName}.app`),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fileExists(candidate)) {
        return {
          platform,
          appRoot: candidate,
          resourcesPath: path.join(candidate, "Contents", "Resources"),
          asarPath: path.join(candidate, "Contents", "Resources", "app.asar"),
        };
      }
    }

    fail(
      `No packaged macOS app found. Tried:\n${candidates.map((item) => `- ${item}`).join("\n")}`
    );
  }

  if (platform === "win") {
    const candidateDirs = [
      explicitPath,
      path.join(distRoot, "win-unpacked"),
      ...listDistDirectories(/^win.*-unpacked$/),
    ].filter(Boolean);

    for (const candidateDir of candidateDirs) {
      if (!fileExists(candidateDir)) continue;
      const exePath = path.join(candidateDir, `${productName}.exe`);
      if (!fileExists(exePath)) continue;
      return {
        platform,
        appRoot: candidateDir,
        resourcesPath: path.join(candidateDir, "resources"),
        asarPath: path.join(candidateDir, "resources", "app.asar"),
      };
    }

    fail(
      `No packaged Windows app found. Tried:\n${candidateDirs.map((item) => `- ${item}`).join("\n")}`
    );
  }

  if (platform === "linux") {
    const candidateDirs = [
      explicitPath,
      path.join(distRoot, "linux-unpacked"),
      ...listDistDirectories(/^linux.*-unpacked$/),
    ].filter(Boolean);

    for (const candidateDir of candidateDirs) {
      if (!fileExists(candidateDir)) continue;
      const executableCandidates = [
        path.join(candidateDir, productName),
        path.join(candidateDir, productName.toLowerCase()),
      ];
      const executablePath = executableCandidates.find((item) => fileExists(item));
      if (!executablePath) continue;
      return {
        platform,
        appRoot: candidateDir,
        resourcesPath: path.join(candidateDir, "resources"),
        asarPath: path.join(candidateDir, "resources", "app.asar"),
      };
    }

    fail(
      `No packaged Linux app found. Tried:\n${candidateDirs.map((item) => `- ${item}`).join("\n")}`
    );
  }

  fail(`Unsupported platform "${platform}". Use one of: mac, win, linux.`);
}

function verifyExtraResources(pkg) {
  const { platform, resourcesPath } = pkg;
  const requiredExecutablesByPlatform = {
    mac: [
      path.join(resourcesPath, "bin", "macos-globe-listener"),
      path.join(resourcesPath, "bin", "macos-fast-paste"),
    ],
    win: [
      path.join(resourcesPath, "bin", "windows-key-listener.exe"),
      path.join(resourcesPath, "bin", "windows-fast-paste.exe"),
      path.join(resourcesPath, "bin", "nircmd.exe"),
    ],
    linux: [path.join(resourcesPath, "bin", "linux-fast-paste")],
  };

  const requiredExecutables = requiredExecutablesByPlatform[platform] || [];
  const nodeRuntimeCandidatesByPlatform = {
    mac: [
      path.join(resourcesPath, "bin", "node-runtime", "darwin-arm64", "bin", "node"),
      path.join(resourcesPath, "bin", "node-runtime", "darwin-x64", "bin", "node"),
    ],
    win: [path.join(resourcesPath, "bin", "node-runtime", "win32-x64", "node.exe")],
    linux: [
      path.join(resourcesPath, "bin", "node-runtime", "linux-x64", "bin", "node"),
      path.join(resourcesPath, "bin", "node-runtime", "linux-arm64", "bin", "node"),
    ],
  };

  for (const executablePath of requiredExecutables) {
    if (!fileExists(executablePath)) {
      fail(`Missing required ${platform} helper binary: ${executablePath}`);
    }
    if (!executableExists(executablePath)) {
      fail(`Helper binary is not executable: ${executablePath}`);
    }
  }

  const nodeRuntimeCandidates = nodeRuntimeCandidatesByPlatform[platform] || [];
  if (nodeRuntimeCandidates.length > 0) {
    const nodeRuntimePath = nodeRuntimeCandidates.find((candidate) => fileExists(candidate));
    if (!nodeRuntimePath) {
      fail(
        `Missing packaged Node runtime. Tried:\n${nodeRuntimeCandidates
          .map((item) => `- ${item}`)
          .join("\n")}`
      );
    }
    if (!executableExists(nodeRuntimePath)) {
      fail(`Packaged Node runtime is not executable: ${nodeRuntimePath}`);
    }
  }

  const binRoot = path.join(resourcesPath, "bin");
  const forbiddenMatchersByPlatform = {
    mac: [
      (item) => item.endsWith(".dll"),
      (item) => item.endsWith(".exe"),
      (item) => item.endsWith(".so") || item.includes(".so."),
      (item) => item.includes("win32") || item.includes("windows"),
      (item) => item.includes("linux"),
    ],
    win: [
      (item) => item.endsWith(".dylib"),
      (item) => item.endsWith(".so") || item.includes(".so."),
      (item) => item.includes("darwin") || item.includes("macos"),
      (item) => item.includes("linux"),
    ],
    linux: [
      (item) => item.endsWith(".dylib"),
      (item) => item.endsWith(".dll"),
      (item) => item.endsWith(".exe"),
      (item) => item.includes("darwin") || item.includes("macos"),
      (item) => item.includes("win32") || item.includes("windows"),
    ],
  };
  const forbiddenMatchers = forbiddenMatchersByPlatform[platform] || [];
  const foreignResourceFiles = walkFiles(binRoot).filter((filePath) => {
    const relativePath = toResourceRelativePath(filePath, binRoot).toLowerCase();
    return forbiddenMatchers.some((matches) => matches(relativePath));
  });

  if (foreignResourceFiles.length > 0) {
    fail(
      `Foreign platform runtime files found in ${platform} package resources:\n${foreignResourceFiles
        .slice(0, 30)
        .map((item) => `- ${toResourceRelativePath(item, resourcesPath)}`)
        .join("\n")}`
    );
  }

  log(`Verified packaged ${platform} helper binaries.`);
}

function resolveMacMainExecutable(pkg) {
  const executableDir = path.join(pkg.appRoot, "Contents", "MacOS");
  if (!fileExists(executableDir)) {
    fail(`Missing macOS executable directory: ${executableDir}`);
  }

  const candidates = fs
    .readdirSync(executableDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(executableDir, entry.name));
  const preferred = path.join(executableDir, productName);
  if (fileExists(preferred)) return preferred;
  if (candidates.length === 1) return candidates[0];
  fail(`Unable to identify the packaged macOS executable in ${executableDir}`);
}

function resolveMainExecutable(pkg) {
  if (pkg.platform === "mac") {
    return resolveMacMainExecutable(pkg);
  }

  const candidates =
    pkg.platform === "win"
      ? [path.join(pkg.appRoot, `${productName}.exe`)]
      : [path.join(pkg.appRoot, productName), path.join(pkg.appRoot, productName.toLowerCase())];
  const executable = candidates.find((candidate) => fileExists(candidate));
  if (!executable) {
    fail(`Unable to identify the packaged ${pkg.platform} executable.`);
  }
  return executable;
}

async function verifyElectronFuses(pkg) {
  const executable = resolveMainExecutable(pkg);
  let fuseWire;
  try {
    fuseWire = await getCurrentFuseWire(executable);
  } catch (error) {
    fail(`Unable to read Electron fuses: ${error.message}`);
  }

  const expected = new Map([
    [FuseV1Options.RunAsNode, FUSE_DISABLED],
    [FuseV1Options.EnableCookieEncryption, FUSE_DISABLED],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_DISABLED],
    [FuseV1Options.EnableNodeCliInspectArguments, FUSE_DISABLED],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE_ENABLED],
    [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FUSE_DISABLED],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FUSE_ENABLED],
  ]);

  for (const [fuse, expectedState] of expected) {
    if (fuseWire[fuse] !== expectedState) {
      fail(
        `Unexpected Electron fuse ${FuseV1Options[fuse]}: expected ${
          expectedState === FUSE_ENABLED ? "enabled" : "disabled"
        }, found ${JSON.stringify(fuseWire[fuse])}.`
      );
    }
  }

  log(
    "Verified Electron fuses: ASAR integrity and OnlyLoadAppFromAsar enabled; RunAsNode, NODE_OPTIONS, and CLI inspect disabled."
  );
}

function runMacSigningCommand(args) {
  const result = spawnSync("/usr/bin/codesign", args, {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`codesign ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function verifyMacCodeSignature(pkg) {
  if (pkg.platform !== "mac") return;
  if (process.platform !== "darwin") {
    fail("macOS signature verification must run on macOS.");
  }

  const expectedRequirement = macosCodeRequirement(MACOS_BUNDLE_ID);
  try {
    runMacSigningCommand(["--verify", "--deep", "--strict", "--verbose=2", pkg.appRoot]);
    runMacSigningCommand([
      "--verify",
      "--deep",
      "--strict",
      `-R=${expectedRequirement}`,
      pkg.appRoot,
    ]);

    const details = runMacSigningCommand(["-dv", "--verbose=4", pkg.appRoot]);
    if (!details.includes(`Authority=${MACOS_SIGNING_IDENTITY}`)) {
      fail(`Packaged macOS app was not signed by ${MACOS_SIGNING_IDENTITY}.`);
    }
    if (/Signature=adhoc/i.test(details)) {
      fail("Packaged macOS app unexpectedly uses an ad-hoc signature.");
    }
    if (!/^CodeDirectory .*flags=.*\(runtime\)/m.test(details)) {
      fail("Packaged macOS app is missing the hardened runtime signature flag.");
    }

    const requirementOutput = runMacSigningCommand(["-d", "-r-", pkg.appRoot]);
    if (!requirementOutput.includes(`designated => ${expectedRequirement}`)) {
      fail("Packaged macOS app has an unexpected designated requirement.");
    }

    const certificateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-cert-"));
    try {
      const certificatePrefix = path.join(certificateDir, "certificate");
      runMacSigningCommand(["-d", `--extract-certificates=${certificatePrefix}`, pkg.appRoot]);
      const leafCertificatePath = `${certificatePrefix}0`;
      if (!fileExists(leafCertificatePath)) {
        fail("Packaged macOS app has no extractable signing certificate.");
      }
      const actualSha256 = crypto
        .createHash("sha256")
        .update(fs.readFileSync(leafCertificatePath))
        .digest("hex");
      if (actualSha256 !== MACOS_SIGNING_CERTIFICATE_SHA256) {
        fail("Packaged macOS app signing certificate does not match the pinned certificate.");
      }
    } finally {
      fs.rmSync(certificateDir, { recursive: true, force: true });
    }
  } catch (error) {
    fail(`Invalid packaged macOS signature: ${error.message}`);
  }

  log(`Verified pinned macOS signature: ${MACOS_SIGNING_IDENTITY}.`);
}

function serverNameForMachOArchitecture(architecture) {
  if (architecture === "arm64") return "llama-server-darwin-arm64";
  if (architecture === "x86_64") return "llama-server-darwin-x64";
  fail(`Unsupported packaged macOS architecture: ${architecture}`);
}

function verifyMacNativeRuntime(pkg) {
  if (pkg.platform !== "mac") return;

  const mainExecutablePath = resolveMacMainExecutable(pkg);
  let appArchitectures;
  try {
    appArchitectures = getMachOArchitectures(mainExecutablePath).map(normalizeDarwinArchitecture);
  } catch (error) {
    fail(`Unable to inspect packaged app architecture: ${error.message}`);
  }

  const binRoot = path.join(pkg.resourcesPath, "bin");
  const binFiles = walkFiles(binRoot);
  const mismatches = findMachOArchitectureMismatches(binFiles, appArchitectures);
  if (mismatches.length > 0) {
    fail(
      `Mach-O files missing packaged app architecture (${appArchitectures.join(
        ", "
      )}):\n${mismatches
        .slice(0, 30)
        .map(
          ({ filePath, actual, missing, error }) =>
            `- ${toResourceRelativePath(filePath, pkg.resourcesPath)}: ${
              error || `has ${actual.join(", ") || "unknown"}; missing ${missing.join(", ")}`
            }`
        )
        .join("\n")}`
    );
  }

  const expectedServerNames = new Set(appArchitectures.map(serverNameForMachOArchitecture));
  const packagedServerNames = fs
    .readdirSync(binRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("llama-server-darwin-"))
    .map((entry) => entry.name);
  const unexpectedServers = packagedServerNames.filter(
    (serverName) => !expectedServerNames.has(serverName)
  );
  if (unexpectedServers.length > 0) {
    fail(`Unexpected macOS llama-server architecture(s): ${unexpectedServers.join(", ")}`);
  }

  for (const architecture of appArchitectures) {
    const serverName = serverNameForMachOArchitecture(architecture);
    const serverPath = path.join(binRoot, serverName);
    if (!fileExists(serverPath)) {
      fail(`Missing packaged llama-server for ${architecture}: ${serverPath}`);
    }
    if (!executableExists(serverPath)) {
      fail(`Packaged llama-server is not executable: ${serverPath}`);
    }

    const runtimeValidation = validateDarwinLlamaRuntime({
      binaryPath: serverPath,
      expectedArchitecture: architecture,
      libraryDir: binRoot,
    });
    if (!runtimeValidation.ok) {
      fail(`Invalid packaged ${serverName} runtime: ${runtimeValidation.reason}`);
    }

    if (canRunDarwinArchitecture(architecture)) {
      try {
        const helpResult = runLlamaServerHelp({
          binaryPath: serverPath,
          libraryDir: binRoot,
          timeoutMs: PACKAGED_LLAMA_HELP_TIMEOUT_MS,
        });
        log(`${serverName} --help started successfully (exit ${helpResult.exitCode}).`);
      } catch (error) {
        fail(`Packaged ${serverName} failed its --help startup check: ${error.message}`);
      }
    } else {
      log(
        `Skipped ${serverName} startup check on ${process.arch}; architecture and recursive dependencies were verified statically.`
      );
    }
  }

  log(`Verified packaged macOS Mach-O architecture: ${appArchitectures.join(", ")}.`);
}

function runPortableLlamaServerHelp(binaryPath, libraryDir, platform, spawnSyncImpl = spawnSync) {
  const env = { ...process.env };
  if (platform === "win32") {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
    env[pathKey] = `${libraryDir};${env[pathKey] || ""}`;
  } else {
    env.LD_LIBRARY_PATH = `${libraryDir}:${env.LD_LIBRARY_PATH || ""}`;
  }

  const result = spawnSyncImpl(binaryPath, ["--help"], {
    cwd: libraryDir,
    encoding: "utf8",
    env,
    timeout: PACKAGED_LLAMA_HELP_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`exited with ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result.status;
}

function verifyPortableLlamaRuntime(pkg) {
  const targetByPlatform = {
    win: { hostPlatform: "win32", platformArch: "win32-x64" },
    linux: { hostPlatform: "linux", platformArch: "linux-x64" },
  };
  const target = targetByPlatform[pkg.platform];
  if (!target) return;

  const config = LLAMA_BINARIES[target.platformArch];
  const binRoot = path.join(pkg.resourcesPath, "bin");
  const validation = inspectExistingRuntime(target.platformArch, config, binRoot);
  if (!validation.ok) {
    fail(`Invalid packaged ${target.platformArch} llama runtime: ${validation.reason}`);
  }

  const serverPath = path.join(binRoot, config.outputName);
  if (pkg.platform === "linux" && !executableExists(serverPath)) {
    fail(`Packaged llama-server is not executable: ${serverPath}`);
  }

  if (process.platform === target.hostPlatform) {
    try {
      const exitCode = runPortableLlamaServerHelp(serverPath, binRoot, target.hostPlatform);
      log(`${config.outputName} --help started successfully (exit ${exitCode}).`);
    } catch (error) {
      fail(`Packaged ${config.outputName} failed its --help startup check: ${error.message}`);
    }
  } else {
    log(
      `Skipped ${config.outputName} startup check on ${process.platform}; architecture and required libraries were verified statically.`
    );
  }
}

function verifyAsarRuntime(pkg) {
  const { asarPath } = pkg;
  if (!fileExists(asarPath)) {
    fail(`Missing app.asar: ${asarPath}`);
  }

  let asarEntries;
  try {
    asarEntries = new Set(asar.listPackage(asarPath).map(normalizeAsarEntry));
  } catch (error) {
    fail(`Failed to inspect app.asar: ${error.message}`);
  }

  const requiredEntries = [
    "/package.json",
    "/build/electron/main.js",
    "/build/electron/preload.js",
    "/build/electron/macPrivacyDragHelperPreload.js",
    "/build/electron/sherpaStreamingWorker.js",
    "/build/electron/databaseWorker.js",
    "/src/dist/index.html",
    "/node_modules/electron-updater/package.json",
    "/node_modules/builder-util-runtime/package.json",
    "/node_modules/fs-extra/package.json",
    "/node_modules/graceful-fs/package.json",
  ];

  for (const entry of requiredEntries) {
    if (!asarEntries.has(entry)) {
      fail(`Missing required runtime module in app.asar: ${entry}`);
    }
  }

  const prohibitedEntries = [...asarEntries].filter((entry) => {
    const normalized = entry.toLowerCase();
    if (normalized.startsWith("/node_modules/")) {
      return normalized.endsWith(".map") || /\.(?:ts|tsx)$/.test(normalized);
    }
    if (
      normalized.endsWith(".map") ||
      /\.(?:ts|tsx)$/.test(normalized) ||
      /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(normalized) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    ) {
      return true;
    }
    if (["/main.js", "/preload.js", "/macprivacydraghelperpreload.js"].includes(normalized)) {
      return true;
    }
    if (
      normalized.startsWith("/src/") &&
      normalized !== "/src/dist" &&
      !normalized.startsWith("/src/dist/")
    ) {
      return true;
    }
    if (
      isFirstPartyCodePath(normalized.replace(/^\//, "")) &&
      !normalized.startsWith("/src/dist/") &&
      !/^\/build\/electron\/(?:main|preload|macprivacydraghelperpreload|sherpastreamingworker|databaseworker)\.js$/.test(
        normalized
      )
    ) {
      return true;
    }
    return false;
  });

  if (prohibitedEntries.length > 0) {
    fail(
      `Raw source, tests, source maps, or unexpected first-party code found in app.asar:\n${prohibitedEntries
        .slice(0, 50)
        .map((entry) => `- ${entry}`)
        .join("\n")}`
    );
  }

  const packagedMetadata = JSON.parse(extractAsarFile(asarPath, "/package.json").toString("utf8"));
  const expectedMetadata = require(path.join(projectRoot, "package.json"));
  if (packagedMetadata.main !== "build/electron/main.js") {
    fail(`Packaged main entry is not the production bundle: ${packagedMetadata.main}`);
  }
  if (packagedMetadata.license !== "UNLICENSED") {
    fail(`Packaged license metadata must be UNLICENSED, found ${packagedMetadata.license}.`);
  }
  if (packagedMetadata.version !== expectedMetadata.version) {
    fail(
      `Packaged version ${packagedMetadata.version} does not match source version ${expectedMetadata.version}.`
    );
  }
  const expectedSourceSha = String(process.env.CHORDVOX_EXPECTED_SOURCE_SHA || "").trim();
  if (expectedSourceSha) {
    if (!SOURCE_SHA_PATTERN.test(expectedSourceSha)) {
      fail(`CHORDVOX_EXPECTED_SOURCE_SHA is not a valid 40-character source SHA.`);
    }
    const packagedSourceSha = String(packagedMetadata.releaseSourceSha || "").trim();
    if (!SOURCE_SHA_PATTERN.test(packagedSourceSha)) {
      fail("Packaged package.json is missing a valid releaseSourceSha.");
    }
    if (packagedSourceSha !== expectedSourceSha) {
      fail(
        `Packaged source SHA ${packagedSourceSha} does not match expected ${expectedSourceSha}.`
      );
    }
    log(`Verified packaged releaseSourceSha=${packagedSourceSha}.`);
  }

  const sourceHashes = collectFirstPartySourceHashes();
  const exactSourceCopies = [];
  const serverOnlyIdentifiers = [
    "CREEM_API_KEY",
    "CREEM_WEBHOOK_SECRET",
    "INTERNAL_OWNER_KEY",
    "LICENSE_KEY_PEPPER",
    "LICENSE_SERVER_ADMIN_TOKEN",
  ];
  for (const entry of asarEntries) {
    const relative = entry.replace(/^\//, "");
    if (!isFirstPartyCodePath(relative)) continue;

    const content = extractAsarFile(asarPath, entry);
    const matchingSources = sourceHashes.get(sha256(content));
    if (matchingSources) {
      exactSourceCopies.push(`${entry} == ${matchingSources.join(", ")}`);
    }

    const text = content.toString("utf8");
    const leakedIdentifier = serverOnlyIdentifiers.find((identifier) => text.includes(identifier));
    if (leakedIdentifier) {
      fail(`Server-only secret binding ${leakedIdentifier} found in packaged code: ${entry}`);
    }
  }

  if (exactSourceCopies.length > 0) {
    fail(
      `Exact first-party source copies found in app.asar:\n${exactSourceCopies
        .slice(0, 30)
        .map((entry) => `- ${entry}`)
        .join("\n")}`
    );
  }

  log(
    "Verified bundled main/preloads/workers, package metadata, and zero raw first-party source copies inside app.asar."
  );
  return asarEntries;
}

function verifyUnpackedRuntime(pkg) {
  const { resourcesPath } = pkg;
  const unpackedRoot = path.join(resourcesPath, "app.asar.unpacked");
  const requiredFiles = [
    path.join(unpackedRoot, "build", "electron", "sherpaStreamingWorker.js"),
    path.join(unpackedRoot, "build", "electron", "databaseWorker.js"),
    path.join(unpackedRoot, "node_modules", "sherpa-onnx-node", "package.json"),
    path.join(unpackedRoot, "node_modules", "tar", "package.json"),
    path.join(unpackedRoot, "node_modules", "@isaacs", "fs-minipass", "package.json"),
    path.join(unpackedRoot, "node_modules", "chownr", "package.json"),
    path.join(unpackedRoot, "node_modules", "minipass", "package.json"),
    path.join(unpackedRoot, "node_modules", "minizlib", "package.json"),
    path.join(unpackedRoot, "node_modules", "yallist", "package.json"),
  ];

  for (const runtimeFile of requiredFiles) {
    if (!fileExists(runtimeFile)) {
      fail(`Missing unpacked local streaming runtime file: ${runtimeFile}`);
    }
  }

  const unpackedFiles = walkFiles(unpackedRoot);
  const prohibitedFiles = unpackedFiles.filter((filePath) => {
    const relative = path.relative(unpackedRoot, filePath).replace(/\\/g, "/");
    const normalized = relative.toLowerCase();
    if (normalized.startsWith("node_modules/")) {
      return normalized.endsWith(".map") || /\.(?:ts|tsx)$/.test(normalized);
    }
    if (
      normalized.endsWith(".map") ||
      /\.(?:ts|tsx)$/.test(normalized) ||
      /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(normalized) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    ) {
      return true;
    }
    return ![
      "build/electron/sherpastreamingworker.js",
      "build/electron/databaseworker.js",
    ].includes(normalized);
  });

  if (prohibitedFiles.length > 0) {
    fail(
      `Unexpected first-party files found outside app.asar:\n${prohibitedFiles
        .slice(0, 50)
        .map((filePath) => `- ${path.relative(unpackedRoot, filePath).replace(/\\/g, "/")}`)
        .join("\n")}`
    );
  }

  const workerPath = path.join(unpackedRoot, "build", "electron", "sherpaStreamingWorker.js");
  const workerSha256 = sha256(fs.readFileSync(workerPath));
  const mainBundle = extractAsarFile(pkg.asarPath, "/build/electron/main.js").toString("utf8");
  if (!mainBundle.includes(workerSha256)) {
    fail("Packaged main bundle does not contain the unpacked streaming worker integrity hash.");
  }

  const sourceHashes = collectFirstPartySourceHashes();
  const matchingSources = sourceHashes.get(workerSha256);
  if (matchingSources) {
    fail(`Unpacked streaming worker is an exact raw source copy: ${matchingSources.join(", ")}`);
  }

  log("Verified unpacked first-party worker bundles and the streaming worker integrity hash.");
}

function verifyLegalResources(pkg) {
  const legalRoot = path.join(pkg.resourcesPath, "resources", "legal");
  const requiredFiles = [
    "APACHE-2.0.txt",
    "CHORDVOX_PRO_COMMERCIAL_LICENSE.txt",
    "NOTICE.txt",
    "OPEN_SOURCE_NOTICES.txt",
    "PROPRIETARY_COMPONENTS.txt",
  ];

  for (const fileName of requiredFiles) {
    const targetPath = path.join(legalRoot, fileName);
    if (!fileExists(targetPath)) {
      fail(`Missing packaged legal notice: ${targetPath}`);
    }
  }

  const packagedLicense = fs.readFileSync(
    path.join(legalRoot, "CHORDVOX_PRO_COMMERCIAL_LICENSE.txt")
  );
  const rootLicense = fs.readFileSync(path.join(projectRoot, "LICENSE"));
  if (sha256NormalizedLegalText(packagedLicense) !== sha256NormalizedLegalText(rootLicense)) {
    fail("Packaged commercial license does not match the repository LICENSE.");
  }

  const packagedNotice = fs.readFileSync(path.join(legalRoot, "NOTICE.txt"));
  const rootNotice = fs.readFileSync(path.join(projectRoot, "NOTICE"));
  if (sha256NormalizedLegalText(packagedNotice) !== sha256NormalizedLegalText(rootNotice)) {
    fail("Packaged NOTICE does not match the repository NOTICE.");
  }

  const licenseText = packagedLicense.toString("utf8");
  const componentsText = fs.readFileSync(
    path.join(legalRoot, "PROPRIETARY_COMPONENTS.txt"),
    "utf8"
  );
  const openSourceText = fs.readFileSync(path.join(legalRoot, "OPEN_SOURCE_NOTICES.txt"), "utf8");
  for (const requiredPhrase of ["mandatory law", "open-source components", "Earlier releases"]) {
    if (!licenseText.includes(requiredPhrase)) {
      fail(`Commercial license is missing required boundary language: ${requiredPhrase}`);
    }
  }
  if (!componentsText.includes("ChordVox Pro") || !componentsText.includes("Proprietary")) {
    fail("Packaged proprietary component boundary is incomplete.");
  }
  if (!openSourceText.includes("MIT License") || !openSourceText.includes("Apache License")) {
    fail("Packaged open-source notices do not contain the expected MIT and Apache attributions.");
  }

  log("Verified commercial license, proprietary component boundary, and open-source notices.");
}

function verifyAuxiliaryResourceHygiene(pkg) {
  const sourceHashes = collectFirstPartySourceHashes();
  const ignoredPrefixes = ["app.asar", "app.asar.unpacked/", "bin/", "resources/bin/"];
  const suspicious = [];

  for (const filePath of walkFiles(pkg.resourcesPath)) {
    const relative = path.relative(pkg.resourcesPath, filePath).replace(/\\/g, "/");
    if (ignoredPrefixes.some((prefix) => relative === prefix || relative.startsWith(prefix))) {
      continue;
    }

    if (
      relative.endsWith(".map") ||
      /\.(?:ts|tsx)$/i.test(relative) ||
      /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(relative) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(relative)
    ) {
      suspicious.push(relative);
      continue;
    }

    if (isFirstPartyCodePath(relative)) {
      const matchingSources = sourceHashes.get(sha256(fs.readFileSync(filePath)));
      suspicious.push(
        matchingSources
          ? `${relative} == ${matchingSources.join(", ")}`
          : `${relative} (unexpected executable code)`
      );
    }
  }

  if (suspicious.length > 0) {
    fail(
      `Unexpected source-like auxiliary resources found:\n${suspicious
        .slice(0, 50)
        .map((item) => `- ${item}`)
        .join("\n")}`
    );
  }

  log("Verified auxiliary resources contain no first-party source, tests, or source maps.");
}

function verifyWindowsNativeRuntime(pkg) {
  if (pkg.platform !== "win") return;

  const { resourcesPath } = pkg;
  const unpackedRoot = path.join(resourcesPath, "app.asar.unpacked");
  const sqliteNodePath = path.join(
    unpackedRoot,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node"
  );
  const ffmpegExePath = path.join(unpackedRoot, "node_modules", "ffmpeg-static", "ffmpeg.exe");

  verifyWindowsPeFile(sqliteNodePath, "better-sqlite3 native module");
  verifyWindowsPeFile(ffmpegExePath, "ffmpeg-static binary");

  const allUnpackedFiles = walkFiles(unpackedRoot);
  const linuxRuntimeFiles = allUnpackedFiles.filter((filePath) => {
    const normalized = filePath.replace(/\\/g, "/");
    return (
      normalized.includes("/sherpa-onnx-linux-") ||
      normalized.endsWith("/node_modules/ffmpeg-static/ffmpeg") ||
      normalized.endsWith(".so") ||
      normalized.includes(".so.")
    );
  });

  if (linuxRuntimeFiles.length > 0) {
    fail(
      `Linux runtime files found in Windows package:\n${linuxRuntimeFiles
        .slice(0, 20)
        .map((item) => `- ${item}`)
        .join("\n")}`
    );
  }

  log("Verified Windows native modules and FFmpeg are Windows binaries.");
}

function verifyLinuxNativeRuntime(pkg) {
  if (pkg.platform !== "linux") return;

  const fastPastePath = path.join(pkg.resourcesPath, "bin", "linux-fast-paste");
  verifyLinuxElfFile(fastPastePath, "fast-paste helper");
  const fastPasteGlibcVersion = assertLinuxGlibcCompatibility(fastPastePath);

  const unpackedRoot = path.join(pkg.resourcesPath, "app.asar.unpacked");
  verifyLinuxElfFile(
    path.join(
      unpackedRoot,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node"
    ),
    "better-sqlite3 native module"
  );
  verifyLinuxElfFile(
    path.join(unpackedRoot, "node_modules", "ffmpeg-static", "ffmpeg"),
    "ffmpeg-static binary"
  );

  const foreignRuntimeFiles = walkFiles(unpackedRoot).filter((filePath) => {
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    return (
      normalized.includes("/sherpa-onnx-darwin-") ||
      normalized.includes("/sherpa-onnx-win32-") ||
      normalized.endsWith("/node_modules/ffmpeg-static/ffmpeg.exe") ||
      normalized.endsWith(".dylib") ||
      normalized.endsWith(".dll") ||
      normalized.endsWith(".exe")
    );
  });
  if (foreignRuntimeFiles.length > 0) {
    fail(
      `Foreign platform runtime files found in Linux package:\n${foreignRuntimeFiles
        .slice(0, 20)
        .map((item) => `- ${item}`)
        .join("\n")}`
    );
  }

  log(
    `Verified Linux native modules and FFmpeg are x64 ELF binaries; fast-paste maximum required symbol version is GLIBC_${fastPasteGlibcVersion} (baseline GLIBC_${LINUX_GLIBC_BASELINE}).`
  );
}

async function main() {
  const { platform, explicitPath } = parseArgs(process.argv.slice(2));
  const pkg = resolvePackage(platform, explicitPath);
  log(`Inspecting ${pkg.appRoot}`);
  verifyExtraResources(pkg);
  await verifyElectronFuses(pkg);
  verifyMacCodeSignature(pkg);
  verifyMacNativeRuntime(pkg);
  verifyPortableLlamaRuntime(pkg);
  verifyAsarRuntime(pkg);
  verifyUnpackedRuntime(pkg);
  verifyLegalResources(pkg);
  verifyAuxiliaryResourceHygiene(pkg);
  verifyWindowsNativeRuntime(pkg);
  verifyLinuxNativeRuntime(pkg);
  log(`${platform} package verification passed.`);
}

module.exports = {
  assertLinuxGlibcCompatibility,
  runPortableLlamaServerHelp,
  sha256NormalizedLegalText,
  toAsarLookupPath,
  verifyLinuxElfFile,
  verifyWindowsPeFile,
};

if (require.main === module) {
  main().catch((error) => {
    fail(error.stack || error.message);
  });
}
