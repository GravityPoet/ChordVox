import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  BINARIES,
  findLibrariesInDir,
  getConflictingServerPaths,
  getRuntimeFilesToReplace,
  inspectExistingRuntime,
  stageRuntime,
} = require("../../scripts/download-llama-server");
const {
  canRunDarwinArchitecture,
  findMachOArchitectureMismatches,
  runLlamaServerHelp,
  validateDarwinLlamaRuntime,
} = require("../../scripts/lib/macos-runtime-verification");
const {
  assertLinuxGlibcCompatibility,
  runPortableLlamaServerHelp,
  toAsarLookupPath,
} = require("../../scripts/verify-mac-package");
const { parseArgs: parseNodeRuntimeArgs } = require("../../scripts/download-node-runtime");

const temporaryDirectories = [];

function createTempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-llama-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFakeMachO(directory, name) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, Buffer.from("cffaedfe00000000", "hex"));
  return filePath;
}

function writeFakePortableBinary(directory, name, platform, architecture) {
  const filePath = path.join(directory, name);
  if (platform === "win32") {
    const buffer = Buffer.alloc(128);
    buffer.write("MZ", 0, "ascii");
    buffer.writeUInt32LE(64, 0x3c);
    buffer.write("PE\0\0", 64, "binary");
    buffer.writeUInt16LE(architecture === "arm64" ? 0xaa64 : 0x8664, 68);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  const buffer = Buffer.alloc(64);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01], 0);
  buffer.writeUInt16LE(architecture === "arm64" ? 0xb7 : 0x3e, 18);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function createDarwinToolMock(architecturesByName, linkedLibraries = ["libmtmd.0.dylib"]) {
  return (command, args) => {
    if (command === "lipo") {
      const architecture = architecturesByName[path.basename(args[1])];
      return architecture
        ? { status: 0, stdout: `${architecture}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "unknown fixture" };
    }
    if (command === "otool") {
      return {
        status: 0,
        stdout: `${args[1]}:\n${linkedLibraries
          .map((name) => `\t@rpath/${name} (compatibility version 0.0.0)`)
          .join("\n")}\n`,
        stderr: "",
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("Node runtime target selection", () => {
  it("keeps the requested cross-build architecture when --current is used", () => {
    expect(
      parseNodeRuntimeArgs(
        ["--current"],
        { TARGET_PLATFORM: "darwin", TARGET_ARCH: "x64" },
        "darwin",
        "arm64"
      )
    ).toMatchObject({ platform: "darwin", arch: "x64", all: false });
  });

  it("lets explicit CLI target flags override the build environment", () => {
    expect(
      parseNodeRuntimeArgs(
        ["--current", "--platform", "linux", "--arch", "x64"],
        { TARGET_PLATFORM: "darwin", TARGET_ARCH: "arm64" },
        "darwin",
        "arm64"
      )
    ).toMatchObject({ platform: "linux", arch: "x64", all: false });
  });
});

describe("macOS llama runtime packaging", () => {
  it("uses host-native separators when extracting normalized ASAR entries", () => {
    expect(toAsarLookupPath("/build/electron/main.js", "\\")).toBe("build\\electron\\main.js");
    expect(toAsarLookupPath("\\build\\electron\\main.js", "/")).toBe("build/electron/main.js");
  });

  it("does not reuse an arm64 server when a linked dylib is x86_64", () => {
    const directory = createTempDirectory();
    writeFakeMachO(directory, "llama-server-darwin-arm64");
    writeFakeMachO(directory, "libmtmd.0.dylib");

    const result = inspectExistingRuntime(
      "darwin-arm64",
      BINARIES["darwin-arm64"],
      directory,
      createDarwinToolMock({
        "llama-server-darwin-arm64": "arm64",
        "libmtmd.0.dylib": "x86_64",
      })
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/libmtmd\.0\.dylib.*x86_64.*expected arm64/);
  });

  it("validates stale llama-owned dylibs even when the server does not link them directly", () => {
    const directory = createTempDirectory();
    const binaryPath = writeFakeMachO(directory, "llama-server-darwin-arm64");
    writeFakeMachO(directory, "libmtmd.0.dylib");
    writeFakeMachO(directory, "libggml-stale.dylib");

    const result = validateDarwinLlamaRuntime({
      binaryPath,
      expectedArchitecture: "arm64",
      libraryDir: directory,
      ownedLibraryNames: ["libmtmd.0.dylib", "libggml-stale.dylib"],
      spawnSyncImpl: createDarwinToolMock({
        "llama-server-darwin-arm64": "arm64",
        "libmtmd.0.dylib": "arm64",
        "libggml-stale.dylib": "x86_64",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/libggml-stale\.dylib.*x86_64.*expected arm64/);
  });

  it("rejects a missing transitive bundled dylib", () => {
    const directory = createTempDirectory();
    const binaryPath = writeFakeMachO(directory, "llama-server-darwin-arm64");
    writeFakeMachO(directory, "libllama.0.dylib");

    const result = validateDarwinLlamaRuntime({
      binaryPath,
      expectedArchitecture: "arm64",
      libraryDir: directory,
      spawnSyncImpl: (command, args) => {
        const name = path.basename(args[1]);
        if (command === "lipo") {
          return { status: 0, stdout: "arm64\n", stderr: "" };
        }
        if (command === "otool") {
          const dependency =
            name === "llama-server-darwin-arm64" ? "libllama.0.dylib" : "libggml-missing.dylib";
          return {
            status: 0,
            stdout: `${args[1]}:\n\t@rpath/${dependency} (compatibility version 0.0.0)\n`,
            stderr: "",
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Missing llama runtime library: libggml-missing.dylib");
  });

  it("replaces only llama-owned libraries and the conflicting macOS server", () => {
    const directory = createTempDirectory();
    for (const name of [
      "llama-server-darwin-arm64",
      "llama-server-darwin-x64",
      "libllama.0.dylib",
      "libggml.0.dylib",
      "libmtmd.0.dylib",
      "libsherpa-onnx-c-api.dylib",
      "libonnxruntime.dylib",
    ]) {
      fs.writeFileSync(path.join(directory, name), name);
    }

    const replacementNames = getRuntimeFilesToReplace(
      "darwin-arm64",
      BINARIES["darwin-arm64"],
      directory
    ).map((filePath) => path.basename(filePath));

    expect(replacementNames).toEqual(
      expect.arrayContaining([
        "llama-server-darwin-arm64",
        "llama-server-darwin-x64",
        "libllama.0.dylib",
        "libggml.0.dylib",
        "libmtmd.0.dylib",
      ])
    );
    expect(replacementNames).not.toContain("libsherpa-onnx-c-api.dylib");
    expect(replacementNames).not.toContain("libonnxruntime.dylib");
  });

  it("collects safe dylib symlinks from the downloaded archive", () => {
    const directory = createTempDirectory();
    fs.writeFileSync(path.join(directory, "libllama-common.0.0.9999.dylib"), "fixture");
    fs.symlinkSync(
      "libllama-common.0.0.9999.dylib",
      path.join(directory, "libllama-common.0.dylib")
    );

    expect(
      findLibrariesInDir(directory, "*.dylib").map((filePath) => path.basename(filePath))
    ).toEqual(
      expect.arrayContaining(["libllama-common.0.0.9999.dylib", "libllama-common.0.dylib"])
    );
  });

  it("reports packaged Mach-O files that do not contain the app architecture", () => {
    const directory = createTempDirectory();
    const armFile = writeFakeMachO(directory, "arm-helper");
    const intelFile = writeFakeMachO(directory, "intel-library.dylib");
    fs.writeFileSync(path.join(directory, "readme.txt"), "not Mach-O");

    const mismatches = findMachOArchitectureMismatches(
      [armFile, intelFile, path.join(directory, "readme.txt")],
      ["arm64"],
      createDarwinToolMock({
        "arm-helper": "arm64",
        "intel-library.dylib": "x86_64",
      })
    );

    expect(mismatches).toHaveLength(1);
    expect(path.basename(mismatches[0].filePath)).toBe("intel-library.dylib");
    expect(mismatches[0].missing).toEqual(["arm64"]);
  });

  it("accepts clear help output with exit 1 but rejects a dynamic-loader failure", () => {
    const directory = createTempDirectory();
    const binaryPath = path.join(directory, "llama-server-darwin-arm64");

    expect(
      runLlamaServerHelp({
        binaryPath,
        libraryDir: directory,
        spawnSyncImpl: () => ({
          status: 1,
          signal: null,
          stdout: "usage: llama-server [options]\n  --help\n  --host HOST",
          stderr: "",
        }),
      }).exitCode
    ).toBe(1);

    expect(() =>
      runLlamaServerHelp({
        binaryPath,
        libraryDir: directory,
        spawnSyncImpl: () => ({
          status: 134,
          signal: null,
          stdout: "",
          stderr: "Library not loaded: incompatible architecture",
        }),
      })
    ).toThrow(/did not produce recognizable help output/);
  });

  it("only runs a packaged binary on a matching host architecture", () => {
    expect(canRunDarwinArchitecture("arm64", "arm64")).toBe(true);
    expect(canRunDarwinArchitecture("x86_64", "x64")).toBe(true);
    expect(canRunDarwinArchitecture("arm64", "x64")).toBe(false);
    expect(canRunDarwinArchitecture("x86_64", "arm64")).toBe(false);
  });

  it("does not advertise an impossible all-architectures llama runtime download", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    );
    expect(packageJson.scripts["download:llama-server:all"]).toBeUndefined();
  });
});

describe("portable llama runtime packaging", () => {
  it("starts a Windows llama runtime with its bundled DLL directory on PATH", () => {
    const calls = [];
    const exitCode = runPortableLlamaServerHelp(
      "C:\\ChordVox\\bin\\llama-server-win32-x64.exe",
      "C:\\ChordVox\\bin",
      "win32",
      (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "help", stderr: "", signal: null };
      }
    );

    expect(exitCode).toBe(0);
    expect(calls[0].args).toEqual(["--help"]);
    const pathValue = Object.entries(calls[0].options.env).find(
      ([key]) => key.toLowerCase() === "path"
    )?.[1];
    expect(pathValue.startsWith("C:\\ChordVox\\bin;")).toBe(true);
  });

  it("rejects a portable llama runtime whose help command cannot start", () => {
    expect(() =>
      runPortableLlamaServerHelp("/opt/chordvox/llama-server", "/opt/chordvox", "linux", () => ({
        status: 127,
        stdout: "",
        stderr: "missing shared library",
        signal: null,
      }))
    ).toThrow(/exited with 127.*missing shared library/);
  });

  it("stages only llama-owned libraries from a mixed archive", () => {
    const directory = createTempDirectory();
    fs.writeFileSync(path.join(directory, "llama-server.exe"), "server");
    const archiveDirectory = fs.mkdtempSync(path.join(directory, "archive-"));
    const ownedLibrary = path.join(archiveDirectory, "ggml.dll");
    const serverImplementation = path.join(archiveDirectory, "llama-server-impl.dll");
    const commonLibrary = path.join(archiveDirectory, "llama-common.dll");
    const runtimeLibrary = path.join(archiveDirectory, "libomp140.x86_64.dll");
    const unrelatedLibrary = path.join(archiveDirectory, "onnxruntime.dll");
    fs.writeFileSync(ownedLibrary, "ggml");
    fs.writeFileSync(serverImplementation, "server implementation");
    fs.writeFileSync(commonLibrary, "common");
    fs.writeFileSync(runtimeLibrary, "openmp");
    fs.writeFileSync(unrelatedLibrary, "onnx");

    const staged = stageRuntime(
      path.join(directory, "llama-server.exe"),
      [ownedLibrary, serverImplementation, commonLibrary, runtimeLibrary, unrelatedLibrary],
      BINARIES["win32-x64"],
      directory
    );

    expect(staged.stagedLibraryNames).toEqual([
      "ggml.dll",
      "libomp140.x86_64.dll",
      "llama-common.dll",
      "llama-server-impl.dll",
    ]);
    expect(fs.existsSync(path.join(staged.stageDir, "onnxruntime.dll"))).toBe(false);
  });

  it("never treats the Windows server implementation DLL as a stale server binary", () => {
    const directory = createTempDirectory();
    for (const name of [
      "llama-server-win32-x64.exe",
      "llama-server-win32-arm64.exe",
      "llama-server-impl.dll",
    ]) {
      fs.writeFileSync(path.join(directory, name), name);
    }

    const conflicts = getConflictingServerPaths("win32-x64", BINARIES["win32-x64"], directory).map(
      (filePath) => path.basename(filePath)
    );

    expect(conflicts).toEqual(["llama-server-win32-arm64.exe"]);
    expect(conflicts).not.toContain("llama-server-impl.dll");
  });

  it("removes its staging directory when copying a library fails", () => {
    const directory = createTempDirectory();
    const binaryPath = path.join(directory, "llama-server.exe");
    fs.writeFileSync(binaryPath, "server");
    const missingLibrary = path.join(directory, "missing", "ggml.dll");

    expect(() =>
      stageRuntime(binaryPath, [missingLibrary], BINARIES["win32-x64"], directory)
    ).toThrow();
    expect(fs.readdirSync(directory).some((name) => name.startsWith(".llama-stage-"))).toBe(false);
  });

  it("rejects a Windows runtime whose server architecture is wrong", () => {
    const directory = createTempDirectory();
    writeFakePortableBinary(directory, "llama-server-win32-x64.exe", "win32", "arm64");
    for (const name of BINARIES["win32-x64"].requiredLibraryNames) {
      writeFakePortableBinary(directory, name, "win32", "x64");
    }

    const result = inspectExistingRuntime("win32-x64", BINARIES["win32-x64"], directory);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/llama-server-win32-x64\.exe.*arm64.*expected x64/);
  });

  it("rejects a Windows runtime without the upstream server implementation", () => {
    const directory = createTempDirectory();
    writeFakePortableBinary(directory, "llama-server-win32-x64.exe", "win32", "x64");
    for (const name of BINARIES["win32-x64"].requiredLibraryNames) {
      if (name !== "llama-server-impl.dll") {
        writeFakePortableBinary(directory, name, "win32", "x64");
      }
    }

    const result = inspectExistingRuntime("win32-x64", BINARIES["win32-x64"], directory);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Missing llama runtime library: llama-server-impl.dll");
  });

  it("rejects a Linux runtime when a directly required library is missing", () => {
    const directory = createTempDirectory();
    writeFakePortableBinary(directory, "llama-server-linux-x64", "linux", "x64");
    for (const name of ["libllama.so.0", "libggml.so.0", "libggml-base.so.0"]) {
      writeFakePortableBinary(directory, name, "linux", "x64");
    }

    const result = inspectExistingRuntime("linux-x64", BINARIES["linux-x64"], directory);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Missing llama runtime library: libmtmd.so.0");
  });

  it("accepts a complete same-architecture Linux runtime", () => {
    const directory = createTempDirectory();
    writeFakePortableBinary(directory, "llama-server-linux-x64", "linux", "x64");
    for (const name of ["libllama.so.0", "libggml.so.0", "libggml-base.so.0", "libmtmd.so.0"]) {
      writeFakePortableBinary(directory, name, "linux", "x64");
    }

    const result = inspectExistingRuntime("linux-x64", BINARIES["linux-x64"], directory);

    expect(result.ok).toBe(true);
    expect(result.checkedLibraries).toEqual(
      expect.arrayContaining(["libllama.so.0", "libggml.so.0", "libggml-base.so.0", "libmtmd.so.0"])
    );
  });
});

describe("Linux package compatibility", () => {
  it("rejects a paste helper that requires a newer glibc than Ubuntu 22.04", () => {
    expect(() =>
      assertLinuxGlibcCompatibility("/tmp/linux-fast-paste", "2.35", () => ({
        status: 0,
        signal: null,
        stdout: [
          "Version needs section '.gnu.version_r' contains 2 entries:",
          "  Name: GLIBC_2.34  Flags: none  Version: 3",
          "  Name: GLIBC_2.38  Flags: none  Version: 4",
        ].join("\n"),
        stderr: "",
      }))
    ).toThrow(/requires GLIBC_2\.38.*maximum supported GLIBC_2\.35/);
  });

  it("accepts a paste helper within the Ubuntu 22.04 glibc baseline", () => {
    expect(
      assertLinuxGlibcCompatibility("/tmp/linux-fast-paste", "2.35", () => ({
        status: 0,
        signal: null,
        stdout: [
          "Version needs section '.gnu.version_r' contains 2 entries:",
          "  Name: GLIBC_2.2.5  Flags: none  Version: 2",
          "  Name: GLIBC_2.34  Flags: none  Version: 3",
        ].join("\n"),
        stderr: "",
      }))
    ).toBe("2.34");
  });
});
