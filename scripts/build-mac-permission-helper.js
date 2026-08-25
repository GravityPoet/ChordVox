#!/usr/bin/env node

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const isMac = process.platform === "darwin";
if (!isMac) {
  process.exit(0);
}

// Support cross-compilation via --arch flag or TARGET_ARCH env var
const archIndex = process.argv.indexOf("--arch");
const targetArch =
  (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;

const ARCH_TO_TARGET = {
  arm64: "arm64-apple-macosx11.0",
  x64: "x86_64-apple-macosx11.0",
};
const ARCH_TO_LIPO_ARCH = {
  arm64: "arm64",
  x64: "x86_64",
};
const swiftTarget = ARCH_TO_TARGET[targetArch];
if (!swiftTarget) {
  console.error(`[permission-helper] Unsupported architecture: ${targetArch}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const swiftSource = path.join(projectRoot, "resources", "macos-permission-helper.swift");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "macos-permission-helper");
const hashFile = path.join(outputDir, `.macos-permission-helper.${targetArch}.hash`);
const moduleCacheDir = "/tmp/swift-module-cache-permission";

function log(message) {
  console.log(`[permission-helper] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function binarySupportsTargetArch(binaryPath, arch) {
  const expectedArch = ARCH_TO_LIPO_ARCH[arch];
  if (!expectedArch) {
    return false;
  }
  const result = spawnSync("lipo", ["-archs", binaryPath], { encoding: "utf8" });
  if (result.status !== 0) {
    log(`Unable to inspect cached binary architecture, rebuild needed: ${result.stderr || "lipo failed"}`);
    return false;
  }
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .includes(expectedArch);
}

if (!fs.existsSync(swiftSource)) {
  console.error(`[permission-helper] Swift source not found at ${swiftSource}`);
  process.exit(1);
}

ensureDir(outputDir);
ensureDir(moduleCacheDir);

let needsBuild = true;
if (fs.existsSync(outputBinary)) {
  try {
    const binaryStat = fs.statSync(outputBinary);
    const sourceStat = fs.statSync(swiftSource);
    if (binaryStat.mtimeMs >= sourceStat.mtimeMs) {
      needsBuild = false;
    }
  } catch {
    needsBuild = true;
  }
}

if (!needsBuild && fs.existsSync(outputBinary) && !binarySupportsTargetArch(outputBinary, targetArch)) {
  log(`Cached helper binary does not support ${targetArch}, rebuild needed`);
  needsBuild = true;
}

// Secondary check: compare source hash
if (!needsBuild && fs.existsSync(outputBinary)) {
  try {
    const sourceContent = fs.readFileSync(swiftSource, "utf8");
    const currentHash = crypto.createHash("sha256").update(sourceContent).digest("hex");

    if (fs.existsSync(hashFile)) {
      const savedHash = fs.readFileSync(hashFile, "utf8").trim();
      if (savedHash !== currentHash) {
        log("Source hash changed, rebuild needed");
        needsBuild = true;
      }
    } else {
      log("Architecture-specific hash is missing, rebuild needed");
      needsBuild = true;
    }
  } catch (err) {
    log(`Hash check failed: ${err.message}, forcing rebuild`);
    needsBuild = true;
  }
}

if (!needsBuild) {
  process.exit(0);
}

function attemptCompile(command, args) {
  log(`Compiling with ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      SWIFT_MODULE_CACHE_PATH: moduleCacheDir,
    },
  });
}

const compileArgs = [
  swiftSource,
  "-O",
  "-target",
  swiftTarget,
  "-module-cache-path",
  moduleCacheDir,
  "-o",
  outputBinary,
];

let result = attemptCompile("swiftc", compileArgs);

if (result.status !== 0) {
  result = attemptCompile("xcrun", ["swiftc", ...compileArgs]);
}

if (result.status !== 0) {
  console.error("[permission-helper] Failed to compile macOS permission helper binary.");
  process.exit(result.status ?? 1);
}

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[permission-helper] Unable to set executable permissions: ${error.message}`);
}

// Save source hash after successful build
try {
  const sourceContent = fs.readFileSync(swiftSource, "utf8");
  const hash = crypto.createHash("sha256").update(sourceContent).digest("hex");
  fs.writeFileSync(hashFile, hash);
} catch (err) {
  // Non-critical, just log
  log(`Warning: Could not save source hash: ${err.message}`);
}

log(`Successfully built macOS permission helper binary (${targetArch}).`);
