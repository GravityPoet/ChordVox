"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MACH_O_MAGICS = new Set([
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
]);

function normalizeDarwinArchitecture(architecture) {
  return architecture === "x64" ? "x86_64" : architecture;
}

function isMachOFile(filePath) {
  try {
    const header = Buffer.alloc(4);
    const descriptor = fs.openSync(filePath, "r");
    try {
      if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
        return false;
      }
    } finally {
      fs.closeSync(descriptor);
    }
    return MACH_O_MAGICS.has(header.toString("hex"));
  } catch {
    return false;
  }
}

function runCapture(command, args, options = {}, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(output || `${command} exited with code ${result.status}`);
  }
  return `${result.stdout || ""}`.trim();
}

function getMachOArchitectures(filePath, spawnSyncImpl = spawnSync) {
  if (!isMachOFile(filePath)) {
    throw new Error(`Not a Mach-O file: ${filePath}`);
  }

  const output = runCapture("lipo", ["-archs", filePath], {}, spawnSyncImpl);
  const architectures = output.split(/\s+/).filter(Boolean);
  if (architectures.length === 0) {
    throw new Error(`Unable to determine Mach-O architecture: ${filePath}`);
  }
  return architectures;
}

function getDarwinLinkedLibraries(binaryPath, spawnSyncImpl = spawnSync) {
  const output = runCapture("otool", ["-L", binaryPath], {}, spawnSyncImpl);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/, 1)[0])
    .filter(Boolean);
}

function getBundledDarwinLibraryNames(binaryPath, spawnSyncImpl = spawnSync) {
  return getDarwinLinkedLibraries(binaryPath, spawnSyncImpl)
    .filter(
      (libraryPath) =>
        libraryPath.startsWith("@rpath/") ||
        libraryPath.startsWith("@loader_path/") ||
        libraryPath.startsWith("@executable_path/")
    )
    .map((libraryPath) => path.basename(libraryPath));
}

function canRunDarwinArchitecture(targetArchitecture, hostArchitecture = process.arch) {
  return (
    normalizeDarwinArchitecture(targetArchitecture) ===
    normalizeDarwinArchitecture(hostArchitecture)
  );
}

function validateDarwinLlamaRuntime({
  binaryPath,
  expectedArchitecture,
  libraryDir = path.dirname(binaryPath),
  ownedLibraryNames = [],
  spawnSyncImpl = spawnSync,
}) {
  const expected = normalizeDarwinArchitecture(expectedArchitecture);

  try {
    const binaryArchitectures = getMachOArchitectures(binaryPath, spawnSyncImpl);
    if (!binaryArchitectures.includes(expected)) {
      return {
        ok: false,
        reason: `${path.basename(binaryPath)} is ${binaryArchitectures.join(
          ", "
        )}, expected ${expected}`,
      };
    }

    const linkedLibraries = getBundledDarwinLibraryNames(binaryPath, spawnSyncImpl);

    if (linkedLibraries.length === 0) {
      return {
        ok: false,
        reason: `${path.basename(binaryPath)} has no bundled dynamic-library dependencies`,
      };
    }

    const librariesToCheck = [...new Set([...linkedLibraries, ...ownedLibraryNames])];
    const checkedLibraries = new Set();
    while (librariesToCheck.length > 0) {
      const libraryName = librariesToCheck.shift();
      if (!libraryName || checkedLibraries.has(libraryName)) continue;
      const libraryPath = path.join(libraryDir, libraryName);
      if (!fs.existsSync(libraryPath)) {
        return { ok: false, reason: `Missing llama runtime library: ${libraryName}` };
      }
      const libraryArchitectures = getMachOArchitectures(libraryPath, spawnSyncImpl);
      if (!libraryArchitectures.includes(expected)) {
        return {
          ok: false,
          reason: `${libraryName} is ${libraryArchitectures.join(", ")}, expected ${expected}`,
        };
      }

      checkedLibraries.add(libraryName);
      for (const dependencyName of getBundledDarwinLibraryNames(libraryPath, spawnSyncImpl)) {
        if (!checkedLibraries.has(dependencyName)) librariesToCheck.push(dependencyName);
      }
    }

    return {
      ok: true,
      binaryArchitectures,
      checkedLibraries: [...checkedLibraries],
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function findMachOArchitectureMismatches(
  filePaths,
  expectedArchitectures,
  spawnSyncImpl = spawnSync
) {
  const expected = expectedArchitectures.map(normalizeDarwinArchitecture);
  const mismatches = [];

  for (const filePath of filePaths) {
    if (!isMachOFile(filePath)) continue;
    try {
      const actual = getMachOArchitectures(filePath, spawnSyncImpl);
      const missing = expected.filter((architecture) => !actual.includes(architecture));
      if (missing.length > 0) {
        mismatches.push({ filePath, actual, missing });
      }
    } catch (error) {
      mismatches.push({
        filePath,
        actual: [],
        missing: expected,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return mismatches;
}

function runLlamaServerHelp({
  binaryPath,
  libraryDir = path.dirname(binaryPath),
  timeoutMs = 15000,
  spawnSyncImpl = spawnSync,
}) {
  const result = spawnSyncImpl(binaryPath, ["--help"], {
    cwd: libraryDir,
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH:
        libraryDir + (process.env.DYLD_LIBRARY_PATH ? `:${process.env.DYLD_LIBRARY_PATH}` : ""),
    },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`llama-server --help terminated by signal ${result.signal}`);
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const looksLikeHelp =
    /--help\b/i.test(output) &&
    /(?:usage|common params|server params|--host\b|--port\b)/i.test(output);
  if (!looksLikeHelp) {
    throw new Error(
      `llama-server --help did not produce recognizable help output (exit ${String(
        result.status
      )}): ${output.slice(0, 500) || "no output"}`
    );
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`llama-server --help exited with code ${result.status}`);
  }

  return { exitCode: result.status, output };
}

module.exports = {
  canRunDarwinArchitecture,
  findMachOArchitectureMismatches,
  getBundledDarwinLibraryNames,
  getDarwinLinkedLibraries,
  getMachOArchitectures,
  isMachOFile,
  normalizeDarwinArchitecture,
  runLlamaServerHelp,
  validateDarwinLlamaRuntime,
};
