const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const os = require("os");
const {
  appendBoundedOutput,
  findAvailablePort,
  isPortInUseError,
  resolveBinaryPath,
  gracefulStopProcess,
  summarizeStartupFailure,
} = require("../utils/serverUtils");
const { killProcess } = require("../utils/process");
const { getSafeTempDir } = require("./safeTempDir");

const PORT_RANGE_START = 6006;
const PORT_RANGE_END = 6029;
const DEFAULT_STARTUP_TIMEOUT_MS = 60000;
// Windows ARM reports an ARM processor identifier even to an emulated x64 process.
const WINDOWS_ARM_STARTUP_TIMEOUT_MS = 120000;

function getStartupTimeoutMs({
  platform = process.platform,
  processorIdentifier = process.env.PROCESSOR_IDENTIFIER || "",
} = {}) {
  const isWindowsArmHost =
    platform === "win32" && /\bARM(?:64|v\d+)?\b/i.test(String(processorIdentifier));
  return isWindowsArmHost ? WINDOWS_ARM_STARTUP_TIMEOUT_MS : DEFAULT_STARTUP_TIMEOUT_MS;
}

const STARTUP_TIMEOUT_MS = getStartupTimeoutMs();
const HEALTH_CHECK_INTERVAL_MS = 5000;
// Single segment is capped at 30s of audio and real inference runs 0.5-2.5s;
// 5 minutes only made a dead sidecar look like a frozen window.
const TRANSCRIPTION_TIMEOUT_MS = 30000;
const STARTUP_PORT_RETRY_LIMIT = 3;
const MAX_WS_BUFFERED_AMOUNT_BYTES = 2 * 1024 * 1024;
const ORPHAN_SWEEP_TIMEOUT_MS = 2000;
const ORPHAN_TERM_GRACE_MS = 500;

let staleWsCleanupPromise = null;

function createAbortError(message = "Local transcription startup cancelled") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ERR_LOCAL_TRANSCRIPTION_CANCELLED";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function getWsBinaryName() {
  const platformArch = `${process.platform}-${process.arch}`;
  return process.platform === "win32"
    ? `sherpa-onnx-ws-${platformArch}.exe`
    : `sherpa-onnx-ws-${platformArch}`;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePsLine(line) {
  const match = String(line || "").match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    command: match[3],
  };
}

function isChordVoxSherpaWsCommand(command, binaryName) {
  return (
    command.includes(`/Contents/Resources/bin/${binaryName}`) ||
    command.includes(`/resources/bin/${binaryName}`)
  );
}

function isStaleSherpaWsProcess(entry, binaryName) {
  if (!entry || entry.pid === process.pid || entry.ppid !== 1) return false;
  if (!isChordVoxSherpaWsCommand(entry.command, binaryName)) return false;
  if (!entry.command.includes("--tokens=") || !entry.command.includes("--port=")) return false;
  return entry.command.includes("--paraformer=") || entry.command.includes("--encoder=");
}

function readProcessTable() {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,command="],
      { timeout: ORPHAN_SWEEP_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve("");
          return;
        }
        resolve(stdout || "");
      }
    );
  });
}

async function killStaleProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, ORPHAN_TERM_GRACE_MS);
  });

  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  return !isPidAlive(pid);
}

class ParakeetWsServer {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelName = null;
    this.modelDir = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.transcribing = false;
    this.cachedWsBinaryPath = null;
    this.exitCleanupHandler = () => this._killTrackedProcessOnParentExit();
    process.once("exit", this.exitCleanupHandler);
    this._scheduleStaleProcessCleanup();
  }

  getWsBinaryPath() {
    if (this.cachedWsBinaryPath) return this.cachedWsBinaryPath;

    const binaryName = getWsBinaryName();
    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedWsBinaryPath = resolved;
    return resolved;
  }

  isAvailable() {
    return this.getWsBinaryPath() !== null;
  }

  async start(modelName, modelDir, options = {}) {
    const signal = options.signal || null;
    throwIfAborted(signal);
    if (this.startupPromise) return this.awaitStartupWithAbort(this.startupPromise, signal);
    if (this.ready && this.modelName === modelName) return;
    if (this.process) await this.stop();

    this.startupPromise = this._doStart(modelName, modelDir, options);
    try {
      await this.awaitStartupWithAbort(this.startupPromise, signal);
    } finally {
      this.startupPromise = null;
    }
  }

  awaitStartupWithAbort(promise, signal) {
    if (!signal) return promise;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  async _doStart(modelName, modelDir, options = {}) {
    const signal = options.signal || null;
    throwIfAborted(signal);
    const wsBinary = this.getWsBinaryPath();
    if (!wsBinary) throw new Error("sherpa-onnx WS server binary not found");
    if (!fs.existsSync(modelDir)) throw new Error(`Model directory not found: ${modelDir}`);
    await this._scheduleStaleProcessCleanup();

    const modelType = options.modelType || "parakeet";
    const tokensFileName = options.tokensFileName || "tokens.txt";
    const numThreads = Math.max(1, Math.floor(os.cpus().length * 0.75));
    let nextPortStart = PORT_RANGE_START;
    let lastError = null;

    for (let attempt = 1; attempt <= STARTUP_PORT_RETRY_LIMIT; attempt += 1) {
      throwIfAborted(signal);
      this.port = await findAvailablePort(nextPortStart, PORT_RANGE_END);
      this.modelName = modelName;
      this.modelDir = modelDir;

      const args =
        modelType === "paraformer"
          ? [
              `--tokens=${path.join(modelDir, tokensFileName)}`,
              `--paraformer=${path.join(modelDir, options.modelFileName || "model.onnx")}`,
              "--model-type=paraformer",
              `--port=${this.port}`,
              `--num-threads=${numThreads}`,
            ]
          : [
              `--tokens=${path.join(modelDir, tokensFileName)}`,
              `--encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
              `--decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
              `--joiner=${path.join(modelDir, "joiner.int8.onnx")}`,
              `--port=${this.port}`,
              `--num-threads=${numThreads}`,
            ];

      try {
        await this._spawnAndWaitForReady(wsBinary, args, modelType, modelName, attempt, signal);
        this._startHealthCheck();

        debugLogger.info("parakeet-ws server started successfully", {
          port: this.port,
          model: modelName,
        });

        await this._warmUp(signal);
        return;
      } catch (error) {
        lastError = error;
        const failedPort = this.port;
        await this.stop();

        if (
          !isPortInUseError(error) ||
          failedPort >= PORT_RANGE_END ||
          attempt >= STARTUP_PORT_RETRY_LIMIT
        ) {
          throw error;
        }

        nextPortStart = failedPort + 1;
        debugLogger.warn("parakeet-ws startup port busy; retrying on next port", {
          failedPort,
          nextPortStart,
          attempt,
          modelName,
        });
      }
    }

    throw lastError || new Error("Failed to start local speech service.");
  }

  async _spawnAndWaitForReady(wsBinary, args, modelType, modelName, attempt, signal = null) {
    throwIfAborted(signal);
    debugLogger.debug(`Starting ${modelType} WS server`, {
      port: this.port,
      modelName,
      attempt,
      args,
    });

    const child = spawn(wsBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: getSafeTempDir(),
    });
    this.process = child;

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let exitCode = null;
    let readyResolve = null;
    const readyFromOutput = new Promise((resolve) => {
      readyResolve = resolve;
    });

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdoutBuffer = appendBoundedOutput(stdoutBuffer, text);
      debugLogger.debug("parakeet-ws stdout", { processOutput: text.trim() });
      if (text.includes("Listening on:")) {
        readyResolve(true);
      }
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer = appendBoundedOutput(stderrBuffer, text);
      debugLogger.debug("parakeet-ws stderr", { processOutput: text.trim() });
      if (text.includes("Listening on:")) {
        readyResolve(true);
      }
    });

    child.on("error", (error) => {
      debugLogger.error("parakeet-ws process error", { error: error.message });
      if (this.process === child) this.ready = false;
      readyResolve(false);
    });

    child.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("parakeet-ws process exited", { code });
      // Guard: only clear live state if this child is still the tracked
      // process — a stale exit must not wipe a newer respawn.
      if (this.process === child) {
        this.ready = false;
        this.process = null;
        this.stopHealthCheck();
      }
      readyResolve(false);
    });

    const onAbort = () => {
      try {
        if (!child.killed) child.kill();
      } catch {}
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      await this._waitForReady(
        readyFromOutput,
        () => ({
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          exitCode,
        }),
        signal
      );
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  _scheduleStaleProcessCleanup() {
    if (process.platform === "win32") return Promise.resolve();
    if (!staleWsCleanupPromise) {
      staleWsCleanupPromise = this._cleanupStaleOrphanedWsProcesses()
        .catch((error) => {
          debugLogger.warn("Failed to cleanup stale parakeet-ws processes", {
            error: error.message,
          });
        })
        .finally(() => {
          staleWsCleanupPromise = null;
        });
    }
    return staleWsCleanupPromise;
  }

  async _cleanupStaleOrphanedWsProcesses() {
    const binaryName = getWsBinaryName();
    const stdout = await readProcessTable();
    const staleEntries = stdout
      .split("\n")
      .map(parsePsLine)
      .filter((entry) => isStaleSherpaWsProcess(entry, binaryName));

    if (staleEntries.length === 0) return;

    const results = [];
    for (const entry of staleEntries) {
      const stopped = await killStaleProcess(entry.pid);
      results.push({ pid: entry.pid, stopped });
    }

    debugLogger.warn("Cleaned up stale parakeet-ws processes", {
      processes: results,
    });
  }

  _killTrackedProcessOnParentExit() {
    if (!this.process || !this.process.pid) return;

    try {
      killProcess(this.process, "SIGKILL");
    } catch {}
  }

  async _warmUp(signal = null) {
    try {
      throwIfAborted(signal);
      const sampleRate = 16000;
      const numSamples = sampleRate;
      const silentSamples = Buffer.alloc(numSamples * 4);
      await this.transcribe(silentSamples, sampleRate, signal);
      debugLogger.debug("parakeet-ws warm-up inference complete");
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") {
        throw err;
      }
      debugLogger.warn("parakeet-ws warm-up failed (non-fatal)", {
        error: err.message,
      });
    }
  }

  async _waitForReady(readySignal, getProcessInfo, signal = null) {
    const startTime = Date.now();
    throwIfAborted(signal);

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finishReject(new Error(`parakeet-ws failed to start within ${STARTUP_TIMEOUT_MS}ms`));
      }, STARTUP_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener?.("abort", onAbort);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => finishReject(createAbortError());

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });

      readySignal.then((ready) => {
        if (settled) return;
        if (!ready) {
          const info = getProcessInfo ? getProcessInfo() : {};
          const details =
            summarizeStartupFailure(info) ||
            (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
          finishReject(
            new Error(`parakeet-ws process died during startup${details ? `: ${details}` : ""}`)
          );
          return;
        }
        settled = true;
        cleanup();
        this.ready = true;
        debugLogger.debug("parakeet-ws ready", { startupTimeMs: Date.now() - startTime });
        resolve();
      }, finishReject);
    });
  }

  _isProcessAlive() {
    if (!this.process || this.process.killed) return false;
    try {
      process.kill(this.process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  _startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }
      if (this.transcribing) return;

      if (!this._isProcessAlive()) {
        debugLogger.warn("parakeet-ws health check failed: process not alive");
        this.ready = false;
        this.stopHealthCheck();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  transcribe(samplesBuffer, sampleRate, signal = null) {
    signal?.throwIfAborted?.();
    if (!this.ready || !this.process) {
      throw new Error("parakeet-ws server is not running");
    }

    this.transcribing = true;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let result = "";
      let settled = false;
      let timeout = null;

      const done =
        (fn) =>
        (...args) => {
          if (settled) return;
          settled = true;
          if (timeout) {
            clearTimeout(timeout);
          }
          signal?.removeEventListener?.("abort", onAbort);
          this.transcribing = false;
          fn(...args);
        };

      timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        done(reject)(new Error("parakeet-ws transcription timed out"));
      }, TRANSCRIPTION_TIMEOUT_MS);

      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      ws.on("error", (error) => {
        done(reject)(new Error(`parakeet-ws transcription failed: ${error.message}`));
      });
      const onAbort = () => {
        const error = new Error("Local transcription cancelled");
        error.name = "AbortError";
        try {
          ws.close();
        } catch {}
        done(reject)(error);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });

      ws.on("open", () => {
        // sherpa-onnx offline WS binary protocol:
        // [int32LE sample_rate][int32LE num_audio_bytes][float32 samples...]
        const message = Buffer.alloc(8 + samplesBuffer.length);
        message.writeInt32LE(sampleRate, 0);
        message.writeInt32LE(samplesBuffer.length, 4);
        samplesBuffer.copy(message, 8);

        debugLogger.debug("parakeet-ws sending audio", {
          samplesBytes: samplesBuffer.length,
          sampleRate,
        });

        if (ws.bufferedAmount > MAX_WS_BUFFERED_AMOUNT_BYTES) {
          debugLogger.warn("parakeet-ws WebSocket backpressure before send", {
            bufferedAmount: ws.bufferedAmount,
          });
        }

        ws.send(message, (err) => {
          if (err) {
            debugLogger.error("parakeet-ws send error", { error: err.message });
            done(reject)(new Error(`parakeet-ws send failed: ${err.message}`));
            try {
              ws.close();
            } catch {}
          }
        });
      });

      ws.on("message", (data) => {
        result += data.toString();
        if (ws.bufferedAmount <= MAX_WS_BUFFERED_AMOUNT_BYTES) {
          ws.send("Done", (err) => {
            if (err) {
              debugLogger.warn("parakeet-ws failed to send Done, closing", {
                error: err.message,
              });
              try {
                ws.close();
              } catch {}
            }
          });
        } else {
          debugLogger.warn("parakeet-ws WebSocket backpressure before Done", {
            bufferedAmount: ws.bufferedAmount,
          });
        }
      });

      ws.on("close", (code) => {
        const elapsed = Date.now() - startTime;

        debugLogger.debug("parakeet-ws transcription completed", {
          elapsed,
          code,
          resultLength: result.length,
          resultPreview: result.slice(0, 200),
        });

        try {
          const parsed = JSON.parse(result);
          done(resolve)({ text: (parsed.text || "").trim(), elapsed });
        } catch {
          done(resolve)({ text: result.trim(), elapsed });
        }
      });
    });
  }

  async stop() {
    this.stopHealthCheck();

    const processToStop = this.process;
    // Detach state BEFORE the async kill so a concurrent start() that spawns a
    // fresh process is not wiped out when this stop() finishes afterwards.
    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelName = null;
    this.modelDir = null;

    if (!processToStop) return;

    debugLogger.debug("Stopping parakeet-ws server");

    try {
      await gracefulStopProcess(processToStop);
    } catch (error) {
      debugLogger.error("Error stopping parakeet-ws server", { error: error.message });
    }
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelName: this.modelName,
    };
  }
}

module.exports = ParakeetWsServer;
module.exports.getStartupTimeoutMs = getStartupTimeoutMs;
