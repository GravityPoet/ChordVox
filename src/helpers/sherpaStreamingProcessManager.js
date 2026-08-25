/* global __CHORDVOX_STREAMING_WORKER_SHA256__ */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { fork, spawnSync } = require("child_process");
const debugLogger = require("./debugLogger");
const SherpaStreamingMetadataManager = require("./sherpaStreamingManager");
const {
  STREAMING_MODELS,
  DEFAULT_STREAMING_MODEL_ID,
  getStreamingModelsDir,
} = require("./sherpaStreamingManager");

const REQUEST_TIMEOUT_MS = 120000;
const FILE_TRANSCRIPTION_TIMEOUT_MS = 600000;
const WORKER_EXIT_MESSAGE =
  "Local streaming engine stopped unexpectedly. Please try again; the app itself is still running.";
const EXTERNAL_NODE_REQUIRED_MESSAGE =
  "This FP16 streaming model needs the isolated local runtime. Falling back to local batch transcription.";
const EMBEDDED_WORKER_SHA256 =
  typeof __CHORDVOX_STREAMING_WORKER_SHA256__ === "string"
    ? __CHORDVOX_STREAMING_WORKER_SHA256__
    : "";
const MODEL_IDS_REQUIRING_EXTERNAL_NODE = new Set(
  STREAMING_MODELS.filter((model) => model.requiresExternalNodeRuntime).map((model) => model.id)
);

function isAsarPath(targetPath) {
  return String(targetPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .includes("app.asar");
}

function getUnpackedAsarPath(targetPath) {
  return String(targetPath || "").replace(/app\.asar(?=\/|\\)/, "app.asar.unpacked");
}

function verifyUnpackedWorkerIntegrity(workerPath) {
  const normalized = String(workerPath || "").replace(/\\/g, "/");
  if (!normalized.includes("/app.asar.unpacked/")) {
    return true;
  }

  if (!EMBEDDED_WORKER_SHA256) {
    const error = new Error("Packaged local streaming worker has no embedded integrity record.");
    error.code = "LOCAL_STREAMING_WORKER_INTEGRITY_MISSING";
    throw error;
  }

  const actualSha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(workerPath))
    .digest("hex");
  const expected = Buffer.from(EMBEDDED_WORKER_SHA256, "hex");
  const actual = Buffer.from(actualSha256, "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    const error = new Error("Packaged local streaming worker failed its integrity check.");
    error.code = "LOCAL_STREAMING_WORKER_INTEGRITY_FAILED";
    throw error;
  }

  return true;
}

function getWorkerCwd(workerPath) {
  if (isAsarPath(workerPath)) {
    return process.resourcesPath || path.dirname(process.execPath);
  }

  if (
    String(workerPath || "")
      .replace(/\\/g, "/")
      .includes("app.asar.unpacked")
  ) {
    return process.resourcesPath || path.resolve(path.dirname(workerPath), "..", "..");
  }

  return path.resolve(__dirname, "..", "..");
}

function isExecutableFile(targetPath) {
  if (!targetPath) return false;
  try {
    fs.accessSync(targetPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function resolveCommand(command) {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) return "";
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function getNodeRuntimeCandidates() {
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  const resourcesPath = process.resourcesPath || "";
  const envNode = process.env.CHORDVOX_NODE_RUNTIME || "";
  const candidates = [
    envNode,
    resourcesPath ? path.join(resourcesPath, "bin", executableName) : "",
    resourcesPath
      ? path.join(
          resourcesPath,
          "bin",
          "node-runtime",
          `${process.platform}-${process.arch}`,
          executableName
        )
      : "",
    resourcesPath
      ? path.join(
          resourcesPath,
          "bin",
          "node-runtime",
          `${process.platform}-${process.arch}`,
          "bin",
          executableName
        )
      : "",
    resourcesPath ? path.join(resourcesPath, "runtime", "node", executableName) : "",
    resourcesPath ? path.join(resourcesPath, "runtime", "node", "bin", executableName) : "",
    resourcesPath
      ? path.join(
          resourcesPath,
          "runtime",
          `node-${process.platform}-${process.arch}`,
          executableName
        )
      : "",
    resourcesPath
      ? path.join(
          resourcesPath,
          "runtime",
          `node-${process.platform}-${process.arch}`,
          "bin",
          executableName
        )
      : "",
    !process.versions?.electron ? process.execPath : "",
    resolveCommand("node"),
  ];

  if (process.platform === "darwin") {
    candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  } else if (process.platform === "linux") {
    candidates.push("/usr/bin/node", "/usr/local/bin/node");
  } else if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    candidates.push(path.join(programFiles, "nodejs", "node.exe"));
  }

  return uniqueNonEmpty(candidates);
}

function getModelConfig(modelId) {
  return STREAMING_MODELS.find((model) => model.id === modelId) || null;
}

function modelRequiresExternalNode(modelId) {
  return MODEL_IDS_REQUIRING_EXTERNAL_NODE.has(modelId);
}

function prependPathEnv(existingValue, nextPath) {
  if (!nextPath) return existingValue || "";
  if (!existingValue) return nextPath;
  return `${nextPath}${path.delimiter}${existingValue}`;
}

function buildExternalNodeEnv(workerPath) {
  const normalizedWorkerPath = String(workerPath || "");
  const marker = `app.asar.unpacked${path.sep}`;
  const markerIndex = normalizedWorkerPath.indexOf(marker);
  if (markerIndex === -1) return {};

  const unpackedRoot = normalizedWorkerPath.slice(0, markerIndex + "app.asar.unpacked".length);
  const sherpaPlatform = process.platform === "win32" ? "win" : process.platform;
  const nativeLibDir = path.join(
    unpackedRoot,
    "node_modules",
    `sherpa-onnx-${sherpaPlatform}-${process.arch}`
  );

  if (!fs.existsSync(nativeLibDir)) return {};

  return {
    DYLD_LIBRARY_PATH: prependPathEnv(process.env.DYLD_LIBRARY_PATH, nativeLibDir),
    LD_LIBRARY_PATH: prependPathEnv(process.env.LD_LIBRARY_PATH, nativeLibDir),
    PATH: prependPathEnv(process.env.PATH, nativeLibDir),
  };
}

class SherpaStreamingProcessManager {
  constructor() {
    this.metadata = new SherpaStreamingMetadataManager();
    this.worker = null;
    this.workerReady = false;
    this.workerStartPromise = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.isActive = false;
    this.currentModelId = null;
    this.stoppingWorker = false;
    this.expectedWorkerExit = false;
    this.workerRuntimeKind = null;
    this.workerExecPath = null;
    this.workerPath = null;

    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onAutoStopRequested = null;

    process.once("exit", () => {
      this._killWorker();
    });
  }

  getModelsDir(customDir = "") {
    return this.metadata.getModelsDir(customDir);
  }

  ensureModelsDirExists(customDir = "") {
    return this.metadata.ensureModelsDirExists(customDir);
  }

  getModelDir(modelId, customDir = "") {
    return this.metadata.getModelDir(modelId, customDir);
  }

  getArchivePath(modelId, customDir = "") {
    return this.metadata.getArchivePath(modelId, customDir);
  }

  isModelReady(modelId, customDir = "") {
    return this.metadata.isModelReady(modelId, customDir);
  }

  getAvailableModels(customDir = "") {
    return this.metadata.getAvailableModels(customDir);
  }

  downloadModel(modelId, progressCallback = null, customDir = "", options = {}) {
    return this.metadata.downloadModel(modelId, progressCallback, customDir, options);
  }

  cancelDownload() {
    return this.metadata.cancelDownload();
  }

  async deleteModel(modelId, customDir = "") {
    await this.stopStream().catch(() => {});
    await this._stopWorker().catch(() => {});
    return this.metadata.deleteModel(modelId, customDir);
  }

  async deleteAllModels(customDir = "") {
    await this.stopStream().catch(() => {});
    await this._stopWorker().catch(() => {});
    return this.metadata.deleteAllModels(customDir);
  }

  async transcribeFile(audioBlob, options = {}) {
    const audioBuffer = this._toBuffer(audioBlob);
    const result = await this._request(
      "transcribeFile",
      { audioBuffer, options },
      FILE_TRANSCRIPTION_TIMEOUT_MS
    );
    return result;
  }

  async transcribeFilePath(filePath, options = {}) {
    const result = await this._request(
      "transcribeFilePath",
      { filePath, options },
      FILE_TRANSCRIPTION_TIMEOUT_MS
    );
    return result;
  }

  async cancelFileTranscription() {
    if (!this.worker) {
      return { success: false, error: "No active file transcription to cancel" };
    }
    await this._stopWorker();
    return { success: true, message: "File transcription cancelled" };
  }

  async startStream(modelId, customDir = "", options = {}) {
    if (this.isActive) {
      await this.stopStream().catch(() => {});
    }

    const result = await this._request("startStream", {
      modelId: modelId || DEFAULT_STREAMING_MODEL_ID,
      modelsDir: customDir || "",
      options,
    });

    this.isActive = true;
    this.currentModelId = modelId || DEFAULT_STREAMING_MODEL_ID;
    return result?.success !== false;
  }

  async warmupModel(modelId, customDir = "", options = {}) {
    if (this.isActive) {
      return { success: false, alreadyActive: true, modelId: this.currentModelId };
    }

    const targetModelId = modelId || DEFAULT_STREAMING_MODEL_ID;
    const result = await this._request("warmupModel", {
      modelId: targetModelId,
      modelsDir: customDir || "",
      options,
    });

    if (result?.success !== false) {
      this.currentModelId = result?.modelId || targetModelId;
    }

    return result || { success: true, modelId: targetModelId };
  }

  feedAudioChunk(audioBuffer) {
    if (!this.isActive || !this.worker || !this.worker.connected) return null;

    try {
      this.worker.send({
        kind: "request",
        type: "feedAudioChunk",
        payload: { audioBuffer: this._toBuffer(audioBuffer) },
      });
    } catch (error) {
      debugLogger.warn(
        "Failed to send audio chunk to local streaming worker",
        { error: error.message },
        "sherpa-streaming"
      );
    }

    return null;
  }

  async stopStream() {
    if (!this.worker || !this.worker.connected) {
      this.isActive = false;
      return { text: "" };
    }

    try {
      const result = await this._request("stopStream", {}, 30000);
      this.isActive = false;
      return result || { text: "" };
    } catch (error) {
      this.isActive = false;
      throw error;
    }
  }

  async getStatus() {
    if (!this.worker || !this.worker.connected) {
      return {
        isActive: false,
        currentModelId: this.currentModelId,
        currentDownloadModelId: this.metadata.currentDownload?.modelId || null,
        hasRecognizer: false,
        confirmedTextLength: 0,
        partialTextLength: 0,
        isolatedWorker: true,
        workerRunning: false,
      };
    }

    try {
      const status = await this._request("getStatus", {}, 10000);
      return {
        ...status,
        currentDownloadModelId: this.metadata.currentDownload?.modelId || null,
        isolatedWorker: true,
        workerRunning: true,
      };
    } catch (error) {
      return {
        isActive: this.isActive,
        currentModelId: this.currentModelId,
        currentDownloadModelId: this.metadata.currentDownload?.modelId || null,
        hasRecognizer: false,
        confirmedTextLength: 0,
        partialTextLength: 0,
        isolatedWorker: true,
        workerRunning: false,
        error: error.message,
      };
    }
  }

  cleanup() {
    this.metadata.cleanup();
    this._stopWorker().catch(() => {});
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onAutoStopRequested = null;
  }

  async _request(type, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const requestedModelId =
      type === "startStream" || type === "warmupModel"
        ? payload.modelId
        : type === "transcribeFile" || type === "transcribeFilePath"
          ? payload.options?.modelId
          : this.currentModelId;
    await this._ensureWorker(requestedModelId);

    if (!this.worker || !this.worker.connected) {
      throw new Error("Local streaming worker is not running");
    }

    const id = String(this.nextRequestId++);
    const request = { kind: "request", id, type, payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Local streaming worker request timed out: ${type}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout, type });

      try {
        this.worker.send(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  resolveWorkerLaunch(modelId = "") {
    const workerPath = path.join(__dirname, "sherpaStreamingWorker.js");
    const normalizedWorkerPath = isAsarPath(workerPath)
      ? getUnpackedAsarPath(workerPath)
      : workerPath;
    const canUseUnpackedWorker = !isAsarPath(workerPath) || fs.existsSync(normalizedWorkerPath);
    const requiresExternalNode = modelRequiresExternalNode(modelId);

    if (canUseUnpackedWorker) {
      const externalNodePath = getNodeRuntimeCandidates().find((candidate) =>
        isExecutableFile(candidate)
      );
      if (externalNodePath) {
        verifyUnpackedWorkerIntegrity(normalizedWorkerPath);
        return {
          kind: "external-node",
          execPath: externalNodePath,
          workerPath: normalizedWorkerPath,
          env: buildExternalNodeEnv(normalizedWorkerPath),
          requiresExternalNode,
        };
      }
    }

    if (requiresExternalNode && process.versions?.electron) {
      const model = getModelConfig(modelId);
      const error = new Error(EXTERNAL_NODE_REQUIRED_MESSAGE);
      error.code = "LOCAL_STREAMING_EXTERNAL_NODE_REQUIRED";
      error.modelId = modelId;
      error.modelName = model?.name || modelId;
      error.unpackedWorkerAvailable = canUseUnpackedWorker;
      throw error;
    }

    return {
      kind: process.versions?.electron ? "electron-node" : "node",
      execPath: process.execPath,
      workerPath,
      env: process.versions?.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      requiresExternalNode,
    };
  }

  isCurrentWorkerCompatible(launchPlan) {
    return (
      this.worker &&
      this.worker.connected &&
      this.workerReady &&
      this.workerRuntimeKind === launchPlan.kind &&
      this.workerExecPath === launchPlan.execPath &&
      this.workerPath === launchPlan.workerPath
    );
  }

  resetWorkerRuntimeState() {
    this.workerRuntimeKind = null;
    this.workerExecPath = null;
    this.workerPath = null;
  }

  forceStopWorkerForRuntimeSwitch() {
    if (!this.worker) return;
    this.expectedWorkerExit = true;
    try {
      this.worker.kill("SIGTERM");
    } catch {
      // ignore cleanup errors
    }
    this.worker = null;
    this.workerReady = false;
    this.isActive = false;
    this.resetWorkerRuntimeState();
  }

  async _ensureWorker(modelId = "") {
    const launchPlan = this.resolveWorkerLaunch(modelId);

    if (this.isCurrentWorkerCompatible(launchPlan)) {
      return;
    }

    if (this.worker) {
      this.forceStopWorkerForRuntimeSwitch();
    }

    if (this.workerStartPromise) {
      return this.workerStartPromise;
    }

    this.workerStartPromise = new Promise((resolve, reject) => {
      const workerPath = launchPlan.workerPath;
      const workerCwd = getWorkerCwd(workerPath);
      debugLogger.info(
        "Starting local streaming worker",
        {
          workerPath,
          cwd: workerCwd,
          packaged: isAsarPath(path.join(__dirname, "sherpaStreamingWorker.js")),
          runtimeKind: launchPlan.kind,
          execPath: launchPlan.execPath,
          requiresExternalNode: launchPlan.requiresExternalNode,
        },
        "sherpa-streaming"
      );
      const child = fork(workerPath, [], {
        cwd: workerCwd,
        execPath: launchPlan.execPath,
        env: {
          ...process.env,
          ...launchPlan.env,
          CHORDVOX_LOG_LEVEL: process.env.CHORDVOX_WORKER_LOG_LEVEL || "info",
        },
        execArgv: [],
        serialization: "advanced",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });

      this.worker = child;
      this.workerReady = false;
      this.stoppingWorker = false;
      this.workerRuntimeKind = launchPlan.kind;
      this.workerExecPath = launchPlan.execPath;
      this.workerPath = workerPath;

      const readyTimeout = setTimeout(() => {
        reject(new Error("Local streaming worker failed to become ready"));
        this._killWorker();
      }, 30000);

      child.stdout?.on("data", (data) => {
        debugLogger.debug(
          "local streaming worker stdout",
          { processOutput: data.toString().trim() },
          "sherpa-streaming"
        );
      });

      child.stderr?.on("data", (data) => {
        debugLogger.warn(
          "local streaming worker stderr",
          { processOutput: data.toString().trim() },
          "sherpa-streaming"
        );
      });

      child.on("message", (message) => {
        if (message?.kind === "ready") {
          clearTimeout(readyTimeout);
          this.workerReady = true;
          debugLogger.info("Local streaming worker ready", { pid: child.pid }, "sherpa-streaming");
          resolve();
          return;
        }

        this._handleWorkerMessage(message);
      });

      child.on("error", (error) => {
        clearTimeout(readyTimeout);
        if (!this.workerReady) {
          reject(error);
        }
        this._handleWorkerExit(error.message);
      });

      child.on("exit", (code, signal) => {
        clearTimeout(readyTimeout);
        if (!this.workerReady) {
          reject(new Error(`Local streaming worker exited during startup: ${code || signal}`));
        }
        this._handleWorkerExit(`exit code ${code ?? "null"} signal ${signal ?? "null"}`);
      });
    }).finally(() => {
      this.workerStartPromise = null;
    });

    return this.workerStartPromise;
  }

  _handleWorkerMessage(message) {
    if (message?.kind === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);

      if (message.ok) {
        pending.resolve(message.result);
        return;
      }

      const error = new Error(message.error?.message || "Local streaming worker request failed");
      error.code = message.error?.code || "LOCAL_STREAMING_WORKER_ERROR";
      pending.reject(error);
      return;
    }

    if (message?.kind === "event") {
      if (message.event === "partial") {
        this.onPartialTranscript?.(message.payload || "");
      } else if (message.event === "final") {
        this.onFinalTranscript?.(message.payload || "");
      } else if (message.event === "error") {
        this.onError?.(message.payload?.message || message.payload || "Local streaming error");
      } else if (message.event === "autoStop") {
        this.onAutoStopRequested?.(message.payload || {});
      }
      return;
    }

    if (message?.kind === "fatal") {
      this._handleWorkerExit(message.error?.message || WORKER_EXIT_MESSAGE);
    }
  }

  _handleWorkerExit(reason) {
    const wasActive = this.isActive;
    const wasStopping = this.stoppingWorker || this.expectedWorkerExit;

    const logMeta = { reason, wasActive, wasStopping };
    if (wasStopping) {
      debugLogger.debug("Local streaming worker exited", logMeta, "sherpa-streaming");
    } else {
      debugLogger.warn("Local streaming worker exited", logMeta, "sherpa-streaming");
    }

    this.worker = null;
    this.workerReady = false;
    this.workerStartPromise = null;
    this.isActive = false;
    this.expectedWorkerExit = false;
    this.resetWorkerRuntimeState();

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      const error = new Error(`${WORKER_EXIT_MESSAGE} (${reason})`);
      error.code = "LOCAL_STREAMING_WORKER_EXIT";
      error.reason = reason;
      pending.reject(error);
      this.pending.delete(id);
    }

    if (wasActive && !wasStopping) {
      this.onError?.(WORKER_EXIT_MESSAGE);
      this.onAutoStopRequested?.({
        reason: "local-streaming-worker-exit",
        message: WORKER_EXIT_MESSAGE,
      });
    }
  }

  async _stopWorker() {
    if (!this.worker) return;

    this.stoppingWorker = true;
    this.expectedWorkerExit = true;
    try {
      if (this.worker.connected) {
        await this._request("cleanup", {}, 10000).catch(() => {});
        this.worker.disconnect();
      }
    } finally {
      this._killWorker();
      this.worker = null;
      this.workerReady = false;
      this.isActive = false;
      this.resetWorkerRuntimeState();
      this.stoppingWorker = false;
    }
  }

  _killWorker() {
    if (!this.worker) return;
    try {
      this.expectedWorkerExit = true;
      this.worker.kill("SIGTERM");
    } catch {
      // ignore cleanup errors
    }
  }

  _toBuffer(audioData) {
    if (Buffer.isBuffer(audioData)) {
      return audioData;
    }

    if (audioData instanceof ArrayBuffer) {
      return Buffer.from(audioData);
    }

    if (ArrayBuffer.isView(audioData)) {
      return Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength);
    }

    if (audioData?.type === "Buffer" && Array.isArray(audioData.data)) {
      return Buffer.from(audioData.data);
    }

    return Buffer.from(audioData || []);
  }
}

module.exports = SherpaStreamingProcessManager;
module.exports.STREAMING_MODELS = STREAMING_MODELS;
module.exports.getStreamingModelsDir = getStreamingModelsDir;
module.exports.DEFAULT_STREAMING_MODEL_ID = DEFAULT_STREAMING_MODEL_ID;
module.exports.verifyUnpackedWorkerIntegrity = verifyUnpackedWorkerIntegrity;
