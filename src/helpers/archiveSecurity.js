const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const tar = require("tar");
const { isPathInside } = require("./pathSecurity");

const SAFE_TAR_ENTRY_TYPES = new Set([
  "",
  "directory",
  "file",
  "oldfile",
  "contiguousfile",
  "contiguous-file",
]);
const SYSTEM_TAR_STDERR_LIMIT_BYTES = 64 * 1024;

function validateArchiveEntryPath(entryPath, extractDir) {
  const rawPath = String(entryPath || "");
  if (!rawPath || rawPath.includes("\0")) {
    throw new Error("Archive contains an invalid empty path.");
  }

  const normalizedPath = rawPath.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalizedPath) || normalizedPath.split("/").includes("..")) {
    throw new Error(`Archive contains unsafe path: ${rawPath}`);
  }

  const resolvedPath = path.resolve(extractDir, normalizedPath);
  if (!isPathInside(extractDir, resolvedPath)) {
    throw new Error(`Archive entry escapes extraction directory: ${rawPath}`);
  }

  return resolvedPath;
}

function normalizeTarEntryType(type) {
  return String(type || "")
    .toLowerCase()
    .replace(/[\s_]/g, "-");
}

function assertTarEntrySafe(entry, extractDir) {
  const entryPath = typeof entry === "string" ? entry : entry?.path;
  validateArchiveEntryPath(entryPath, extractDir);

  const type = normalizeTarEntryType(entry?.type);
  if (entry?.linkpath || type === "symboliclink" || type === "link") {
    throw new Error(`Archive contains unsupported link entry: ${entryPath}`);
  }
  if (!SAFE_TAR_ENTRY_TYPES.has(type)) {
    throw new Error(`Archive contains unsupported special entry (${entry?.type}): ${entryPath}`);
  }
}

function createArchiveAbortError() {
  return Object.assign(new Error("Archive extraction cancelled"), {
    code: "DOWNLOAD_CANCELLED",
    isAbort: true,
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createArchiveAbortError();
  }
}

async function validateTarArchiveEntries(archivePath, extractDir, options = {}) {
  const { signal } = options;
  throwIfAborted(signal);
  let validationError = null;
  await tar.t({
    file: archivePath,
    onentry: (entry) => {
      if (signal?.aborted) {
        validationError = createArchiveAbortError();
        return;
      }
      if (validationError) {
        return;
      }
      try {
        assertTarEntrySafe(entry, extractDir);
      } catch (error) {
        validationError = error;
      }
    },
  });
  if (validationError) {
    throw validationError;
  }
  throwIfAborted(signal);
}

async function extractTarArchiveSafe(archivePath, extractDir, options = {}) {
  const { signal } = options;
  throwIfAborted(signal);
  await tar.x({
    file: archivePath,
    cwd: extractDir,
    filter: (entryPath, entry) => {
      throwIfAborted(signal);
      assertTarEntrySafe(entry || entryPath, extractDir);
      return true;
    },
  });
  throwIfAborted(signal);
}

async function runSystemTarExtractSafe(archivePath, extractDir, args = ["-xjf"], options = {}) {
  const { signal } = options;
  await validateTarArchiveEntries(archivePath, extractDir, { signal });
  throwIfAborted(signal);

  await new Promise((resolve, reject) => {
    const tarProcess = spawn("tar", [...args, archivePath, "-C", extractDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stderrBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let aborted = false;
    let forceKillTimer = null;
    const supportsAbortEvents = typeof signal?.addEventListener === "function";

    const clearAbortHandler = () => {
      if (supportsAbortEvents) {
        signal.removeEventListener("abort", handleAbort);
      }
      if (signal?.onAbort === handleAbort) {
        signal.onAbort = null;
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    };

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearAbortHandler();
      callback();
    };

    function handleAbort() {
      if (settled || aborted) return;
      aborted = true;
      tarProcess.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) tarProcess.kill("SIGKILL");
      }, 2000);
      forceKillTimer.unref?.();
    }

    if (signal) {
      if (signal.aborted) {
        handleAbort();
      } else if (supportsAbortEvents) {
        signal.addEventListener("abort", handleAbort, { once: true });
      } else {
        signal.onAbort = handleAbort;
      }
    }

    tarProcess.stderr.on("data", (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      const remaining = SYSTEM_TAR_STDERR_LIMIT_BYTES - stderrBytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        stderr += kept.toString();
        stderrBytes += kept.length;
      }
      if (chunk.length > remaining) {
        stderrTruncated = true;
      }
    });

    tarProcess.on("error", (error) => {
      finish(() =>
        reject(
          aborted
            ? createArchiveAbortError()
            : new Error(`Failed to start tar process: ${error.message}`)
        )
      );
    });

    tarProcess.on("close", (code) => {
      if (aborted || signal?.aborted) {
        finish(() => reject(createArchiveAbortError()));
        return;
      }
      if (code === 0) {
        finish(resolve);
        return;
      }
      const suffix = stderrTruncated ? " [stderr truncated]" : "";
      finish(() =>
        reject(new Error(`tar extraction failed with code ${code}: ${stderr}${suffix}`))
      );
    });
  });
  throwIfAborted(signal);
  await assertExtractedTreeSafe(extractDir);
}

async function assertExtractedTreeSafe(rootDir) {
  const root = path.resolve(rootDir);
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (!isPathInside(root, entryPath)) {
        throw new Error(`Extracted entry escaped target directory: ${entryPath}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Archive extracted unsupported symlink: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Archive extracted unsupported special entry: ${entryPath}`);
      }
    }
  }
}

module.exports = {
  assertExtractedTreeSafe,
  extractTarArchiveSafe,
  runSystemTarExtractSafe,
  validateArchiveEntryPath,
  validateTarArchiveEntries,
};
