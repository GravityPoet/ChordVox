const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const debugLogger = require("./debugLogger");
const { killProcess } = require("../utils/process");
const {
  appendBoundedOutput,
  findAvailablePort,
  isPortInUseError,
  summarizeStartupFailure,
} = require("../utils/serverUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { buildLlamaChatCompletionsBody } = require("./reasoningRequestBodies");

const PORT_RANGE_START = 8200;
const PORT_RANGE_END = 8220;
const SERVER_HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STARTUP_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_FAILURE_THRESHOLD = 3;
const STARTUP_PORT_RETRY_LIMIT = 3;

class LlamaServerManager {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelPath = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.healthCheckFailures = 0;
    this.cachedServerBinaryPath = null;
  }

  getServerBinaryPath() {
    if (this.cachedServerBinaryPath) return this.cachedServerBinaryPath;

    const platform = process.platform;
    const arch = process.arch;
    const platformArch = `${platform}-${arch}`;
    const binaryName =
      platform === "win32" ? `llama-server-${platformArch}.exe` : `llama-server-${platformArch}`;
    const genericName = platform === "win32" ? "llama-server.exe" : "llama-server";

    const candidates = [];

    // Production: check resourcesPath
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "bin", genericName)
      );
    }

    // Development: check relative to this file
    candidates.push(
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", "bin", genericName)
    );

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          fs.statSync(candidate);
          this.cachedServerBinaryPath = candidate;
          return candidate;
        } catch {
          // Can't access binary
        }
      }
    }

    return null;
  }

  isAvailable() {
    return this.getServerBinaryPath() !== null;
  }

  async start(modelPath, options = {}) {
    if (this.startupPromise) return this.startupPromise;

    // Already running with same model
    if (this.ready && this.modelPath === modelPath) return;

    // Stop existing server if running
    if (this.process) {
      await this.stop();
    }

    this.startupPromise = this._doStart(modelPath, options);
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelPath, options = {}) {
    const serverBinary = this.getServerBinaryPath();
    if (!serverBinary) throw new Error("llama-server binary not found");
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);

    // Set library path for dynamic library loading
    const binDir = path.dirname(serverBinary);
    const env = { ...process.env };

    if (process.platform === "darwin") {
      // macOS: Set DYLD_LIBRARY_PATH to find .dylib files
      env.DYLD_LIBRARY_PATH = binDir + (env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : "");
    } else if (process.platform === "linux") {
      // Linux: Set LD_LIBRARY_PATH to find .so files
      env.LD_LIBRARY_PATH = binDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
    }

    let nextPortStart = PORT_RANGE_START;
    let lastError = null;

    for (let attempt = 1; attempt <= STARTUP_PORT_RETRY_LIMIT; attempt += 1) {
      this.port = await findAvailablePort(nextPortStart, PORT_RANGE_END, SERVER_HOST);
      this.modelPath = modelPath;

      const args = [
        "--model",
        modelPath,
        "--host",
        SERVER_HOST,
        "--port",
        String(this.port),
        "--ctx-size",
        String(options.contextSize || 4096),
        "--threads",
        String(options.threads || 4),
      ];

      // Add GPU layers if specified
      if (options.gpuLayers) {
        args.push("--n-gpu-layers", String(options.gpuLayers));
      }

      try {
        await this._spawnAndWaitForReady(serverBinary, args, env, modelPath, attempt);
        this.startHealthCheck();

        debugLogger.info("llama-server started successfully", {
          port: this.port,
          model: path.basename(modelPath),
        });
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
        debugLogger.warn("llama-server startup port busy; retrying on next port", {
          failedPort,
          nextPortStart,
          attempt,
          model: path.basename(modelPath),
        });
      }
    }

    throw lastError || new Error("Failed to start local llama service.");
  }

  async _spawnAndWaitForReady(serverBinary, args, env, modelPath, attempt) {
    debugLogger.debug("Starting llama-server", { port: this.port, modelPath, attempt, args });

    this.process = spawn(serverBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: getSafeTempDir(),
      env,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let exitCode = null;

    this.process.stdout.on("data", (data) => {
      const text = data.toString();
      stdoutBuffer = appendBoundedOutput(stdoutBuffer, text);
      debugLogger.debug("llama-server stdout", { processOutput: text.trim() });
    });

    this.process.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer = appendBoundedOutput(stderrBuffer, text);
      debugLogger.debug("llama-server stderr", { processOutput: text.trim() });
    });

    this.process.on("error", (error) => {
      debugLogger.error("llama-server process error", { error: error.message });
      this.ready = false;
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("llama-server process exited", { code });
      this.ready = false;
      this.process = null;
      this.stopHealthCheck();
    });

    await this.waitForReady(() => ({
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      exitCode,
    }));
  }

  async waitForReady(getProcessInfo) {
    const startTime = Date.now();
    let pollCount = 0;

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : {};
        const details =
          summarizeStartupFailure(info, 500) ||
          (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(`llama-server process died during startup${details ? `: ${details}` : ""}`);
      }

      pollCount++;
      if (await this.checkHealth()) {
        this.ready = true;
        debugLogger.debug("llama-server ready", {
          startupTimeMs: Date.now() - startTime,
          pollCount,
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
    }

    throw new Error(`llama-server failed to start within ${STARTUP_TIMEOUT_MS}ms`);
  }

  checkHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/health",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckFailures = 0;
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (!this.process) {
          this.stopHealthCheck();
          return;
        }
        if (await this.checkHealth()) {
          this.healthCheckFailures = 0;
        } else {
          this.healthCheckFailures++;
          if (this.healthCheckFailures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
            debugLogger.warn("llama-server health check failed", {
              consecutiveFailures: this.healthCheckFailures,
            });
            this.ready = false;
          }
        }
      } catch (err) {
        debugLogger.error("Health check error", { error: err.message });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async inference(messages, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("llama-server is not running");
    }

    const body = JSON.stringify(buildLlamaChatCompletionsBody(messages, options));

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener?.("abort", onAbort);
        callback(value);
      };
      const onAbort = () => {
        req.destroy();
        const error = new Error("Local reasoning was cancelled");
        error.name = "AbortError";
        finish(reject, error);
      };

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 300000, // 5 minute timeout for inference
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            debugLogger.debug("llama-server inference completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
            });

            if (res.statusCode !== 200) {
              finish(reject, new Error(`llama-server returned status ${res.statusCode}: ${data}`));
              return;
            }

            try {
              const response = JSON.parse(data);
              // Extract text from OpenAI-compatible response
              const text = response.choices?.[0]?.message?.content || "";
              finish(resolve, text.trim());
            } catch (e) {
              finish(reject, new Error(`Failed to parse llama-server response: ${e.message}`));
            }
          });
        }
      );

      req.on("error", (error) => {
        finish(reject, new Error(`llama-server request failed: ${error.message}`));
      });
      req.on("timeout", () => {
        req.destroy();
        finish(reject, new Error("llama-server request timed out"));
      });

      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener?.("abort", onAbort, { once: true });

      req.write(body);
      req.end();
    });
  }

  async stop() {
    this.stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      this.port = null;
      this.modelPath = null;
      return;
    }

    debugLogger.debug("Stopping llama-server");

    try {
      killProcess(this.process, "SIGTERM");

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            killProcess(this.process, "SIGKILL");
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error stopping llama-server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelPath = null;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelPath: this.modelPath,
      modelName: this.modelPath ? path.basename(this.modelPath, ".gguf") : null,
    };
  }
}

module.exports = LlamaServerManager;
