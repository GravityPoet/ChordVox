const fs = require("fs");
const net = require("net");
const path = require("path");
const { killProcess } = require("./process");

const GRACEFUL_STOP_TIMEOUT_MS = 5000;
const DEFAULT_CAPTURE_BUFFER_BYTES = 64 * 1024;
const PORT_IN_USE_REGEX =
  /address already in use|EADDRINUSE|asio\.system:48|local speech service port is busy/i;

function isPortAvailable(port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, host);
  });
}

async function findAvailablePort(rangeStart, rangeEnd, host = "0.0.0.0") {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(`No available ports in range ${rangeStart}-${rangeEnd}`);
}

function isPortInUseError(error) {
  return PORT_IN_USE_REGEX.test(String(error?.message || error || ""));
}

function summarizeStartupFailure(info = {}, fallbackLength = 300) {
  const combined = [info.stdout, info.stderr].filter(Boolean).join("\n").trim();
  if (PORT_IN_USE_REGEX.test(combined)) {
    return "Local speech service port is busy.";
  }
  return combined.slice(0, fallbackLength);
}

function appendBoundedOutput(current, chunk, maxBytes = DEFAULT_CAPTURE_BUFFER_BYTES) {
  const next = `${current || ""}${String(chunk || "")}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return next;
  }
  return next.slice(-maxBytes);
}

function resolveBinaryPath(binaryName) {
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bin", binaryName));
  }

  const projectBinDir = path.resolve(__dirname, "..", "..", "resources", "bin");
  candidates.push(path.join(projectBinDir, binaryName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        fs.statSync(candidate);
        return candidate;
      } catch {
        // Can't access binary
      }
    }
  }

  return null;
}

async function gracefulStopProcess(proc) {
  killProcess(proc, "SIGTERM");

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (proc) killProcess(proc, "SIGKILL");
      resolve();
    }, GRACEFUL_STOP_TIMEOUT_MS);

    if (proc) {
      proc.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    } else {
      clearTimeout(timeout);
      resolve();
    }
  });
}

module.exports = {
  appendBoundedOutput,
  findAvailablePort,
  isPortAvailable,
  isPortInUseError,
  resolveBinaryPath,
  gracefulStopProcess,
  summarizeStartupFailure,
};
