const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
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
const { convertToWav } = require("./ffmpegUtils");

const PORT_RANGE_START = 8178;
const PORT_RANGE_END = 8199;
const SERVER_HOST = "127.0.0.1";

// High-pass at 70Hz strips sub-vocal rumble (HVAC, 50/60Hz mains hum, desk and
// handling noise) below the human vocal fundamental before whisper sees the
// audio, raising SNR on noisy rooms and low-quality mics. The filter is ~-3dB
// at 70Hz and only ~-1dB at 100Hz, so speech is untouched (intelligibility
// lives in 300-3400Hz). It cannot remove or clip speech the way silence-trimming
// would, so there is no dropped-word risk. Set to null to disable.
const WHISPER_AUDIO_FILTERS = "highpass=f=70";
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STARTUP_PORT_RETRY_LIMIT = 3;

function createAbortError(message = "Whisper server startup cancelled") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ERR_LOCAL_TRANSCRIPTION_CANCELLED";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function awaitWithAbort(promise, signal) {
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

class WhisperServerManager {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelPath = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedServerBinaryPath = null;
    this.cachedFFmpegPath = null;
    this.canConvert = false;
  }

  getFFmpegPath() {
    if (this.cachedFFmpegPath) return this.cachedFFmpegPath;

    try {
      let ffmpegPath = require("ffmpeg-static");
      ffmpegPath = path.normalize(ffmpegPath);

      if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
        ffmpegPath += ".exe";
      }

      // Try unpacked ASAR path first (production builds unpack ffmpeg-static)
      const unpackedPath = ffmpegPath.includes("app.asar")
        ? ffmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
        : null;

      if (unpackedPath && fs.existsSync(unpackedPath)) {
        // Ensure executable permissions on non-Windows
        if (process.platform !== "win32") {
          try {
            fs.accessSync(unpackedPath, fs.constants.X_OK);
          } catch {
            try {
              fs.chmodSync(unpackedPath, 0o755);
            } catch (chmodErr) {
              debugLogger.warn("Failed to chmod FFmpeg", { error: chmodErr.message });
            }
          }
        }
        this.cachedFFmpegPath = unpackedPath;
        return unpackedPath;
      }

      // Try original path (development or if not in ASAR)
      if (fs.existsSync(ffmpegPath)) {
        if (process.platform !== "win32") {
          try {
            fs.accessSync(ffmpegPath, fs.constants.X_OK);
          } catch {
            // Not executable, fall through to system candidates
            debugLogger.debug("FFmpeg exists but not executable", { ffmpegPath });
            throw new Error("Not executable");
          }
        }
        this.cachedFFmpegPath = ffmpegPath;
        return ffmpegPath;
      }
    } catch (err) {
      debugLogger.debug("Bundled FFmpeg not available", { error: err.message });
    }

    // Try system FFmpeg locations
    const systemCandidates =
      process.platform === "darwin"
        ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
        : process.platform === "win32"
          ? ["C:\\ffmpeg\\bin\\ffmpeg.exe"]
          : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

    for (const candidate of systemCandidates) {
      if (fs.existsSync(candidate)) {
        this.cachedFFmpegPath = candidate;
        return candidate;
      }
    }

    const pathEnv = process.env.PATH || "";
    const pathSep = process.platform === "win32" ? ";" : ":";
    const pathDirs = pathEnv.split(pathSep).map((entry) => entry.replace(/^"|"$/g, ""));
    const pathBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = path.join(dir, pathBinary);
      if (!fs.existsSync(candidate)) continue;
      if (process.platform !== "win32") {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      this.cachedFFmpegPath = candidate;
      return candidate;
    }

    debugLogger.debug("FFmpeg not found");
    return null;
  }

  getServerBinaryPath() {
    if (this.cachedServerBinaryPath) return this.cachedServerBinaryPath;

    const platform = process.platform;
    const arch = process.arch;
    const platformArch = `${platform}-${arch}`;
    const binaryName =
      platform === "win32"
        ? `whisper-server-${platformArch}.exe`
        : `whisper-server-${platformArch}`;
    const genericName = platform === "win32" ? "whisper-server.exe" : "whisper-server";

    const candidates = [];

    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "bin", genericName)
      );
    }

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
    const signal = options.signal || null;
    throwIfAborted(signal);
    if (this.startupPromise) return awaitWithAbort(this.startupPromise, signal);

    if (this.ready && this.modelPath === modelPath) return;

    if (this.process) {
      await this.stop();
    }

    this.startupPromise = this._doStart(modelPath, options);
    try {
      await awaitWithAbort(this.startupPromise, signal);
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelPath, options = {}) {
    const signal = options.signal || null;
    throwIfAborted(signal);
    const serverBinary = this.getServerBinaryPath();
    if (!serverBinary) throw new Error("whisper-server binary not found");
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);

    // Check for FFmpeg first - only use --convert flag if FFmpeg is available
    const ffmpegPath = this.getFFmpegPath();
    const spawnEnv = { ...process.env };
    const pathSep = process.platform === "win32" ? ";" : ":";

    if (process.platform === "win32") {
      const safeTmp = getSafeTempDir();
      spawnEnv.TEMP = safeTmp;
      spawnEnv.TMP = safeTmp;
    }

    // Add the whisper-server directory to PATH so any companion DLLs are found
    const serverBinaryDir = path.dirname(serverBinary);
    spawnEnv.PATH = serverBinaryDir + pathSep + (process.env.PATH || "");

    // FFmpeg is required for pre-converting audio to 16kHz mono WAV
    this.canConvert = !!ffmpegPath;
    if (ffmpegPath) {
      const ffmpegDir = path.dirname(ffmpegPath);
      spawnEnv.PATH = ffmpegDir + pathSep + spawnEnv.PATH;
    } else {
      debugLogger.warn("FFmpeg not found - whisper-server will only accept 16kHz mono WAV");
    }

    let nextPortStart = PORT_RANGE_START;
    let lastError = null;

    for (let attempt = 1; attempt <= STARTUP_PORT_RETRY_LIMIT; attempt += 1) {
      throwIfAborted(signal);
      this.port = await findAvailablePort(nextPortStart, PORT_RANGE_END, SERVER_HOST);
      this.modelPath = modelPath;

      const args = ["--model", modelPath, "--host", SERVER_HOST, "--port", String(this.port)];

      // Latency-optimized defaults: greedy decoding (beam=1, best-of=1) gives a
      // 2-3x speedup over whisper.cpp defaults at a small accuracy cost, and
      // max-context=0 avoids cross-request prompt carryover so the first request
      // after pre-warm is not slower. The bundled whisper-server v0.0.6 does not
      // support the older --no-context flag.
      const threads = options.threads || Math.max(2, Math.min(8, os.cpus().length));
      args.push("--threads", String(threads));
      const beamSize = options.beamSize ?? 1;
      args.push("--beam-size", String(beamSize));
      const bestOf = options.bestOf ?? 1;
      args.push("--best-of", String(bestOf));
      if (options.noContext !== false) {
        args.push("--max-context", "0");
      }
      // whisper.cpp defaults to English when --language is omitted;
      // explicitly pass "auto" to enable language auto-detection
      args.push("--language", options.language || "auto");

      try {
        await this._spawnAndWaitForReady(
          serverBinary,
          args,
          serverBinaryDir,
          spawnEnv,
          modelPath,
          attempt,
          signal
        );
        this.startHealthCheck();

        debugLogger.info("whisper-server started successfully", {
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
        debugLogger.warn("whisper-server startup port busy; retrying on next port", {
          failedPort,
          nextPortStart,
          attempt,
          model: path.basename(modelPath),
        });
      }
    }

    throw lastError || new Error("Failed to start local whisper service.");
  }

  async _spawnAndWaitForReady(
    serverBinary,
    args,
    serverBinaryDir,
    spawnEnv,
    modelPath,
    attempt,
    signal = null
  ) {
    throwIfAborted(signal);
    debugLogger.debug("Starting whisper-server", {
      port: this.port,
      modelPath,
      attempt,
      args,
      cwd: serverBinaryDir,
    });

    this.process = spawn(serverBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: spawnEnv,
      cwd: serverBinaryDir,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let exitCode = null;

    this.process.stdout.on("data", (data) => {
      const text = data.toString();
      stdoutBuffer = appendBoundedOutput(stdoutBuffer, text);
      debugLogger.debug("whisper-server stdout", { processOutput: text.trim() });
    });

    this.process.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer = appendBoundedOutput(stderrBuffer, text);
      debugLogger.debug("whisper-server stderr", { processOutput: text.trim() });
    });

    this.process.on("error", (error) => {
      debugLogger.error("whisper-server process error", { error: error.message });
      this.ready = false;
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("whisper-server process exited", { code });
      this.ready = false;
      this.process = null;
      this.stopHealthCheck();
    });

    const onAbort = () => {
      if (this.process && !this.process.killed) {
        try {
          this.process.kill();
        } catch {}
      }
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      await this.waitForReady(
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

  async waitForReady(getProcessInfo, signal = null) {
    const startTime = Date.now();
    let pollCount = 0;

    // Poll every 100ms during startup (faster than ongoing health checks at 5000ms)
    // This saves 0-400ms average vs 500ms polling
    const STARTUP_POLL_INTERVAL_MS = 100;

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      throwIfAborted(signal);
      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : {};
        const details =
          summarizeStartupFailure(info, 200) ||
          (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(
          `whisper-server process died during startup${details ? `: ${details}` : ""}`
        );
      }

      pollCount++;
      if (await this.checkHealth()) {
        this.ready = true;
        debugLogger.debug("whisper-server ready", {
          startupTimeMs: Date.now() - startTime,
          pollCount,
        });
        return;
      }

      await awaitWithAbort(
        new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS)),
        signal
      );
    }

    throw new Error(`whisper-server failed to start within ${STARTUP_TIMEOUT_MS}ms`);
  }

  checkHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(true);
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
    this.healthCheckInterval = setInterval(async () => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }
      if (!(await this.checkHealth())) {
        debugLogger.warn("whisper-server health check failed");
        this.ready = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async transcribe(audioBuffer, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("whisper-server is not running");
    }

    // Debug: Log audio buffer info
    debugLogger.debug("whisper-server transcribe called", {
      bufferLength: audioBuffer?.length || 0,
      bufferType: audioBuffer?.constructor?.name,
      firstBytes:
        audioBuffer?.length >= 16
          ? Array.from(audioBuffer.slice(0, 16))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ")
          : "too short",
    });

    const { language, initialPrompt, alreadyWav = false, signal = null } = options;
    signal?.throwIfAborted?.();

    // Always convert to 16kHz mono WAV - whisper.cpp requires this exact format
    let finalBuffer = audioBuffer;
    if (!this.canConvert) {
      throw new Error("FFmpeg not found - required for audio conversion");
    }
    finalBuffer = alreadyWav ? audioBuffer : await this._convertToWav(audioBuffer, signal);

    const boundary = `----WhisperBoundary${Date.now()}`;
    const parts = [];
    const fileName = "audio.wav";
    const contentType = "audio/wav";

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    );
    parts.push(finalBuffer);
    parts.push("\r\n");

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${language || "auto"}\r\n`
    );

    // Add initial prompt for custom dictionary words
    if (initialPrompt) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
          `${initialPrompt}\r\n`
      );
      debugLogger.info("Using custom dictionary prompt", { prompt: initialPrompt });
    }

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`
    );
    parts.push(`--${boundary}--\r\n`);

    const bodyParts = parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part));
    const body = Buffer.concat(bodyParts);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/inference",
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
          timeout: 300000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            signal?.removeEventListener?.("abort", onAbort);
            debugLogger.debug("whisper-server transcription completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
              responseLength: data.length,
              responsePreview: data.slice(0, 500),
            });

            if (res.statusCode !== 200) {
              reject(new Error(`whisper-server returned status ${res.statusCode}: ${data}`));
              return;
            }

            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse whisper-server response: ${e.message}`));
            }
          });
        }
      );

      const onAbort = () => {
        const error = new Error("Whisper transcription cancelled");
        error.name = "AbortError";
        req.destroy(error);
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener?.("abort", onAbort, { once: true });
      }

      req.on("error", (error) => {
        signal?.removeEventListener?.("abort", onAbort);
        if (error?.name === "AbortError" || signal?.aborted) {
          error.name = "AbortError";
          reject(error);
          return;
        }
        reject(new Error(`whisper-server request failed: ${error.message}`));
      });
      req.on("timeout", () => {
        signal?.removeEventListener?.("abort", onAbort);
        req.destroy();
        reject(new Error("whisper-server request timed out"));
      });

      req.write(body);
      req.end();
    });
  }

  async transcribeFile(inputPath, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("whisper-server is not running");
    }

    if (!this.canConvert) {
      throw new Error("FFmpeg not found - required for audio conversion");
    }

    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const tempWavPath = path.join(tempDir, `whisper-output-${timestamp}.wav`);

    try {
      await convertToWav(inputPath, tempWavPath, {
        sampleRate: 16000,
        channels: 1,
        audioFilters: WHISPER_AUDIO_FILTERS,
        signal: options.signal,
      });
      const wavBuffer = await fs.promises.readFile(tempWavPath, { signal: options.signal });
      return await this.transcribe(wavBuffer, { ...options, alreadyWav: true });
    } finally {
      try {
        await fs.promises.unlink(tempWavPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          debugLogger.warn("Failed to cleanup temp WAV file", {
            path: tempWavPath,
            error: error.message,
          });
        }
      }
    }
  }

  async _convertToWav(audioBuffer, signal = null) {
    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const tempInputPath = path.join(tempDir, `whisper-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `whisper-output-${timestamp}.wav`);

    try {
      await fs.promises.writeFile(tempInputPath, audioBuffer, { signal });
      await convertToWav(tempInputPath, tempWavPath, {
        sampleRate: 16000,
        channels: 1,
        audioFilters: WHISPER_AUDIO_FILTERS,
        signal,
      });
      return await fs.promises.readFile(tempWavPath, { signal });
    } finally {
      for (const f of [tempInputPath, tempWavPath]) {
        try {
          await fs.promises.unlink(f);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            debugLogger.warn("Failed to cleanup temp audio file", {
              path: f,
              error: error.message,
            });
          }
        }
      }
    }
  }

  async stop() {
    this.stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      this.port = null;
      this.modelPath = null;
      return;
    }

    debugLogger.debug("Stopping whisper-server");

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
      debugLogger.error("Error stopping whisper-server", { error: error.message });
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
      modelName: this.modelPath ? path.basename(this.modelPath, ".bin").replace("ggml-", "") : null,
    };
  }
}

module.exports = WhisperServerManager;
