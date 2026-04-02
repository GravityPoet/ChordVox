/**
 * SherpaStreamingManager — Local streaming ASR engine using sherpa-onnx-node
 *
 * Manages the lifecycle of OnlineRecognizer + OnlineStream for real-time
 * speech-to-text in the Electron main process.
 *
 * Text management follows Type4me's partial/confirmed pattern:
 *   confirmedText += currentPartial on endpoint detection
 *   display text = confirmedText + currentPartial
 *
 * Models are stored in the default speech model root unless overridden per user.
 */

const path = require("path");
const fs = require("fs");
const fsPromises = require("fs").promises;
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const {
  downloadFile,
  createDownloadSignal,
  cleanupStaleDownloads,
  checkDiskSpace,
  validateFileSize,
} = require("./downloadUtils");
const { convertToWav, wavToFloat32Samples } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const {
  STREAMING_MODELS,
  DEFAULT_STREAMING_MODEL_ID,
} = require("../config/streamingModels");
const { getModelsDirForService } = require("./modelDirUtils");

// Lazy-loaded to avoid crash if the package isn't installed
let sherpa_onnx = null;

function getSherpaOnnx() {
  if (!sherpa_onnx) {
    try {
      sherpa_onnx = require("sherpa-onnx-node");
      debugLogger.debug(
        "sherpa-onnx-node loaded",
        { version: sherpa_onnx.version || "unknown" },
        "sherpa-streaming"
      );
    } catch (e) {
      debugLogger.error(
        "Failed to load sherpa-onnx-node",
        { error: e.message },
        "sherpa-streaming"
      );
      throw new Error(
        `sherpa-onnx-node not available: ${e.message}. ` +
          "Make sure to run: npm install sherpa-onnx-node"
      );
    }
  }
  return sherpa_onnx;
}

/**
 * Default streaming model directory. Renderer can override this per user.
 */
function getStreamingModelsDir(customDir = "") {
  const normalized = String(customDir || "").trim();
  if (normalized) {
    return path.resolve(normalized);
  }

  return getModelsDirForService("streaming");
}

function getStreamingModelConfig(modelId) {
  return STREAMING_MODELS.find((model) => model.id === modelId) || null;
}

function getRequiredFilesForModel(model) {
  if (model.modelType === "paraformer") {
    return ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"];
  }
  return ["model.int8.onnx", "tokens.txt"];
}

function toAudioBuffer(audioBlob) {
  if (Buffer.isBuffer(audioBlob)) {
    return audioBlob;
  }

  if (ArrayBuffer.isView(audioBlob)) {
    return Buffer.from(audioBlob.buffer, audioBlob.byteOffset, audioBlob.byteLength);
  }

  if (audioBlob instanceof ArrayBuffer) {
    return Buffer.from(audioBlob);
  }

  if (typeof audioBlob === "string") {
    return Buffer.from(audioBlob, "base64");
  }

  if (audioBlob && audioBlob.buffer && typeof audioBlob.byteLength === "number") {
    return Buffer.from(audioBlob.buffer, audioBlob.byteOffset || 0, audioBlob.byteLength);
  }

  throw new Error(`Unsupported audio data type: ${typeof audioBlob}`);
}

function getInputExtension(sourceFileName = "", mimeType = "") {
  const normalizedFileName = String(sourceFileName || "").trim();
  const explicitExt = normalizedFileName ? path.extname(normalizedFileName) : "";
  if (explicitExt) {
    return explicitExt;
  }

  switch (String(mimeType || "").trim().toLowerCase()) {
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
      return ".m4a";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
    case "audio/webm":
      return ".webm";
    default:
      return ".bin";
  }
}

const VAD_MODEL_FILE = "silero_vad.int8.onnx";
const VAD_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.int8.onnx";
const VAD_MIN_SILENCE_DURATION = 3.0;
const VAD_MIN_SPEECH_DURATION = 0.25;
const VAD_BUFFER_SIZE_SECONDS = 30;
const EXISTING_PUNCTUATION_REGEX = /[。！？!?…，,；;：:]$/u;
const CJK_CHAR_REGEX = /[\u3400-\u9fff]/u;
const ENGLISH_WORD_REGEX = /[A-Za-z]/;
const CJK_LEADING_COMMA_MARKERS = [
  "所以",
  "因此",
  "然后",
  "接着",
  "但是",
  "不過",
  "不过",
  "另外",
  "还有",
  "其實",
  "其实",
  "現在",
  "现在",
  "首先",
  "最後",
  "最后",
  "例如",
  "比如",
  "總之",
  "总之",
];
const CJK_MID_COMMA_MARKERS = [
  "但是",
  "不過",
  "不过",
  "所以",
  "因此",
  "然后",
  "接着",
  "另外",
  "而且",
  "並且",
  "并且",
  "可是",
  "只是",
];
const EN_LEADING_COMMA_MARKERS = [
  "however",
  "therefore",
  "meanwhile",
  "actually",
  "basically",
  "frankly",
  "honestly",
  "anyway",
  "overall",
  "first",
  "next",
  "finally",
  "for example",
  "for instance",
  "by the way",
  "in fact",
];
const EN_MID_COMMA_MARKERS = ["but", "so", "however", "therefore", "instead", "otherwise"];

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class SherpaStreamingManager {
  constructor() {
    this.recognizer = null;
    this.stream = null;
    this.currentModelId = null;
    this.currentModelsDir = null;
    this.isActive = false;

    // Text management (Type4me pattern)
    this.confirmedText = "";
    this.currentPartial = "";

    // 400ms skip (Type4me pattern): skip first 6400 samples at 16kHz
    this.samplesReceived = 0;
    this.SKIP_SAMPLES = 6400; // 16000 * 0.4

    this.currentDownload = null;
    this.vad = null;
    this.vadModelDownloadPromise = null;
    this.vadAutoStopTriggered = false;
    this.vadObservedSpeech = false;

    // Callbacks (set by IPC handler)
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onAutoStopRequested = null;
  }

  getModelsDir(customDir = "") {
    return getStreamingModelsDir(customDir);
  }

  async ensureModelsDirExists(customDir = "") {
    const modelsDir = this.getModelsDir(customDir);
    await fsPromises.mkdir(modelsDir, { recursive: true });
    await cleanupStaleDownloads(modelsDir);
    return modelsDir;
  }

  getModelDir(modelId, customDir = "") {
    const model = getStreamingModelConfig(modelId);
    if (!model) return null;
    return path.join(this.getModelsDir(customDir), model.dirName);
  }

  getArchivePath(modelId, customDir = "") {
    const model = getStreamingModelConfig(modelId);
    if (!model) return null;
    return path.join(this.getModelsDir(customDir), `${model.id}.tar.bz2`);
  }

  getVadDir(customDir = "") {
    return path.join(this.getModelsDir(customDir), "_vad");
  }

  getVadModelPath(customDir = "") {
    return path.join(this.getVadDir(customDir), VAD_MODEL_FILE);
  }

  isModelDirectoryValid(modelDir, model) {
    if (!modelDir || !model || !fs.existsSync(modelDir)) {
      return false;
    }

    return getRequiredFilesForModel(model).every((file) =>
      fs.existsSync(path.join(modelDir, file))
    );
  }

  async ensureVadModelAvailable(customDir = "") {
    const vadModelPath = this.getVadModelPath(customDir);
    if (fs.existsSync(vadModelPath)) {
      return vadModelPath;
    }

    if (this.vadModelDownloadPromise) {
      return this.vadModelDownloadPromise;
    }

    this.vadModelDownloadPromise = (async () => {
      const vadDir = this.getVadDir(customDir);
      await fsPromises.mkdir(vadDir, { recursive: true });
      await downloadFile(VAD_MODEL_URL, vadModelPath, {
        timeout: 120000,
      });
      return vadModelPath;
    })();

    try {
      return await this.vadModelDownloadPromise;
    } finally {
      this.vadModelDownloadPromise = null;
    }
  }

  async initializeVad(customDir = "") {
    if (this.vad) {
      this.resetVadState();
      return true;
    }

    const sherpa = getSherpaOnnx();
    const vadModelPath = await this.ensureVadModelAvailable(customDir);
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: vadModelPath,
          threshold: 0.5,
          minSilenceDuration: VAD_MIN_SILENCE_DURATION,
          minSpeechDuration: VAD_MIN_SPEECH_DURATION,
        },
        sampleRate: 16000,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      VAD_BUFFER_SIZE_SECONDS
    );

    this.resetVadState();
    debugLogger.info(
      "Streaming VAD initialized",
      { vadModelPath, minSilenceDuration: VAD_MIN_SILENCE_DURATION },
      "sherpa-streaming"
    );
    return true;
  }

  resetVadState() {
    this.vadAutoStopTriggered = false;
    this.vadObservedSpeech = false;

    if (this.vad) {
      try {
        this.vad.reset();
      } catch (error) {
        debugLogger.warn(
          "Failed to reset streaming VAD",
          { error: error.message },
          "sherpa-streaming"
        );
      }
    }
  }

  /**
   * Get the list of available streaming models with their download status
   */
  async getAvailableModels(customDir = "") {
    const modelsDir = await this.ensureModelsDirExists(customDir);
    const models = STREAMING_MODELS.map((model) => {
      const modelDir = path.join(modelsDir, model.dirName);
      const isDownloaded = this.isModelDirectoryValid(modelDir, model);
      return { ...model, isDownloaded, modelDir };
    });
    return models;
  }

  /**
   * Check if a specific model is downloaded and ready
   */
  isModelReady(modelId, customDir = "") {
    const model = getStreamingModelConfig(modelId);
    if (!model) return false;
    const modelDir = this.getModelDir(modelId, customDir);
    return this.isModelDirectoryValid(modelDir, model);
  }

  /**
   * Build the sherpa-onnx config for a given model
   */
  _buildConfig(model, modelDir) {
    const config = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        tokens: path.join(modelDir, "tokens.txt"),
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    };

    if (model.modelType === "zipformer2Ctc") {
      config.modelConfig.zipformer2Ctc = {
        model: path.join(modelDir, "model.int8.onnx"),
      };
    } else if (model.modelType === "paraformer") {
      config.modelConfig.paraformer = {
        encoder: path.join(modelDir, "encoder.int8.onnx"),
        decoder: path.join(modelDir, "decoder.int8.onnx"),
      };
    }

    return config;
  }

  /**
   * Load a model and create the OnlineRecognizer.
   * Reuses the existing recognizer if the same model is already loaded.
   */
  async loadModel(modelId, customDir = "") {
    const normalizedModelsDir = this.getModelsDir(customDir);

    // Reuse if same model
    if (
      this.recognizer &&
      this.currentModelId === modelId &&
      this.currentModelsDir === normalizedModelsDir
    ) {
      debugLogger.debug(
        "Reusing existing recognizer",
        { modelId, modelsDir: normalizedModelsDir },
        "sherpa-streaming"
      );
      return true;
    }

    // Clean up old recognizer
    this._releaseRecognizer();

    const model = getStreamingModelConfig(modelId);
    if (!model) {
      throw new Error(`Unknown streaming model: ${modelId}`);
    }

    const modelDir = this.getModelDir(modelId, customDir);
    if (!this.isModelDirectoryValid(modelDir, model)) {
      throw new Error(
        `Model not downloaded: ${model.name}. Please download it first from Settings.`
      );
    }

    const sherpa = getSherpaOnnx();
    const config = this._buildConfig(model, modelDir);

    debugLogger.debug("Creating OnlineRecognizer", { modelId, modelDir }, "sherpa-streaming");
    const t0 = Date.now();

    try {
      this.recognizer = new sherpa.OnlineRecognizer(config);
      this.currentModelId = modelId;
      this.currentModelsDir = normalizedModelsDir;
      debugLogger.info(
        "OnlineRecognizer created",
        { modelId, loadTimeMs: Date.now() - t0, modelsDir: normalizedModelsDir },
        "sherpa-streaming"
      );
      return true;
    } catch (e) {
      debugLogger.error(
        "Failed to create OnlineRecognizer",
        { modelId, error: e.message },
        "sherpa-streaming"
      );
      throw e;
    }
  }

  async transcribeFile(audioBlob, options = {}) {
    if (this.isActive) {
      throw new Error("Local streaming is busy with a live session. Please stop dictation first.");
    }

    const audioBuffer = toAudioBuffer(audioBlob);
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Audio buffer is empty - no audio data received");
    }

    const modelId = options.modelId || DEFAULT_STREAMING_MODEL_ID;
    const modelsDir = options.modelsDir || "";
    const tempDir = getSafeTempDir();
    const tempSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputExt = getInputExtension(options.sourceFileName, options.mimeType);
    const inputPath = path.join(tempDir, `sherpa-streaming-input-${tempSuffix}${inputExt}`);
    const wavPath = path.join(tempDir, `sherpa-streaming-input-${tempSuffix}.wav`);
    const previousVad = this.vad;

    try {
      await fsPromises.writeFile(inputPath, audioBuffer);
      await convertToWav(inputPath, wavPath, { sampleRate: 16000, channels: 1 });

      const wavBuffer = await fsPromises.readFile(wavPath);
      const float32Buffer = wavToFloat32Samples(wavBuffer);
      const totalSamples = Math.floor(float32Buffer.length / 4);

      if (!totalSamples) {
        return { success: false, message: "No audio detected" };
      }

      await this.loadModel(modelId, modelsDir);

      this.stream = this.recognizer.createStream();
      this.isActive = true;
      this.confirmedText = "";
      this.currentPartial = "";
      this.samplesReceived = this.SKIP_SAMPLES;
      this.vad = null;
      this.vadAutoStopTriggered = false;
      this.vadObservedSpeech = false;

      const samples = new Float32Array(
        float32Buffer.buffer,
        float32Buffer.byteOffset,
        totalSamples
      );
      const chunkSize = 1600;

      for (let index = 0; index < samples.length; index += chunkSize) {
        const chunk = samples.subarray(index, Math.min(index + chunkSize, samples.length));
        this.stream.acceptWaveform({ sampleRate: 16000, samples: chunk });

        while (this.recognizer.isReady(this.stream)) {
          this.recognizer.decode(this.stream);
        }

        const result = this.recognizer.getResult(this.stream);
        const text = result.text ? result.text.trim() : "";

        if (this.recognizer.isEndpoint(this.stream)) {
          if (text) {
            this._appendConfirmedSegment(text);
            this.currentPartial = "";
          }
          this.recognizer.reset(this.stream);
        } else {
          this.currentPartial = text;
        }
      }

      const stopResult = this.stopStream();
      const finalText = String(stopResult?.text || "").trim();

      if (!finalText) {
        return { success: false, message: "No audio detected" };
      }

      return {
        success: true,
        text: finalText,
        modelId,
      };
    } catch (error) {
      if (this.isActive) {
        try {
          this.stopStream();
        } catch (stopError) {
          debugLogger.warn(
            "Failed to cleanup streaming recognizer after file transcription error",
            { error: stopError.message },
            "sherpa-streaming"
          );
        }
      }
      throw error;
    } finally {
      this.vad = previousVad;
      this.resetVadState();

      await fsPromises.unlink(inputPath).catch(() => {});
      await fsPromises.unlink(wavPath).catch(() => {});
    }
  }

  async downloadModel(modelId, progressCallback = null, customDir = "") {
    const model = getStreamingModelConfig(modelId);
    if (!model) {
      const error = new Error(`Unknown streaming model: ${modelId}`);
      error.code = "MODEL_NOT_FOUND";
      throw error;
    }

    if (this.currentDownload) {
      const error = new Error("A streaming model download is already in progress");
      error.code = "DOWNLOAD_IN_PROGRESS";
      throw error;
    }

    const modelsDir = await this.ensureModelsDirExists(customDir);
    const targetDir = this.getModelDir(modelId, customDir);
    if (this.isModelDirectoryValid(targetDir, model)) {
      return { success: true, model: modelId, downloaded: true, path: targetDir };
    }

    const requiredBytes = model.sizeBytes || 0;
    if (requiredBytes > 0) {
      const spaceCheck = await checkDiskSpace(modelsDir, requiredBytes * 2.5);
      if (!spaceCheck.ok) {
        const error = new Error(
          `Not enough disk space to download and extract model. Need ~${Math.round((requiredBytes * 2.5) / 1_000_000)}MB, ` +
            `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
        error.code = "INSUFFICIENT_DISK_SPACE";
        throw error;
      }
    }

    const archivePath = this.getArchivePath(modelId, customDir);
    const { signal, abort } = createDownloadSignal();
    this.currentDownload = { modelId, abort };

    try {
      let archiveReady = false;
      try {
        await validateFileSize(archivePath, model.sizeBytes, 35);
        archiveReady = true;
        debugLogger.info("Reusing streaming model archive from previous attempt", {
          modelId,
          archivePath,
        });
      } catch {
        archiveReady = false;
      }

      if (!archiveReady) {
        await downloadFile(model.downloadUrl, archivePath, {
          timeout: 600000,
          signal,
          expectedSize: model.sizeBytes,
          onProgress: (downloadedBytes, totalBytes) => {
            progressCallback?.({
              type: "progress",
              model: modelId,
              downloaded_bytes: downloadedBytes,
              total_bytes: totalBytes,
              percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
            });
          },
        });
      }

      progressCallback?.({
        type: "installing",
        model: modelId,
        percentage: 100,
      });

      await this.extractModelArchive(archivePath, model, customDir);
      await fsPromises.unlink(archivePath).catch(() => {});

      progressCallback?.({
        type: "complete",
        model: modelId,
        percentage: 100,
      });

      return { success: true, model: modelId, downloaded: true, path: targetDir };
    } catch (error) {
      if (error?.isAbort) {
        const cancelled = new Error("Download cancelled by user");
        cancelled.code = "DOWNLOAD_CANCELLED";
        throw cancelled;
      }
      throw error;
    } finally {
      this.currentDownload = null;
    }
  }

  async extractModelArchive(archivePath, model, customDir = "") {
    const modelsDir = this.getModelsDir(customDir);
    const extractDir = path.join(modelsDir, `temp-extract-${model.id}`);
    const targetDir = this.getModelDir(model.id, customDir);

    try {
      await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      await fsPromises.mkdir(extractDir, { recursive: true });
      await this.runTarExtract(archivePath, extractDir);

      const entries = await fsPromises.readdir(extractDir, { withFileTypes: true });
      const extractedDir =
        (this.isModelDirectoryValid(extractDir, model) && extractDir) ||
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(extractDir, entry.name))
          .find((entryPath) => this.isModelDirectoryValid(entryPath, model)) ||
        path.join(extractDir, model.dirName);

      if (!this.isModelDirectoryValid(extractedDir, model)) {
        const names = entries.map((entry) => entry.name);
        const error = new Error(
          `Could not find a valid model directory in extracted archive. Found: [${names.join(", ")}]`
        );
        error.code = "EXTRACTION_FAILED";
        throw error;
      }

      await fsPromises.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      await fsPromises.rename(extractedDir, targetDir);

      if (!this.isModelDirectoryValid(targetDir, model)) {
        const error = new Error("Extracted model is missing required files");
        error.code = "EXTRACTION_FAILED";
        throw error;
      }
    } catch (error) {
      if (!error.code) {
        error.code = "EXTRACTION_FAILED";
      }
      throw error;
    } finally {
      await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  runTarExtract(archivePath, extractDir) {
    return new Promise((resolve, reject) => {
      const tarProcess = spawn("tar", ["-xjf", archivePath, "-C", extractDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";

      tarProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      tarProcess.on("error", (error) => {
        reject(new Error(`Failed to start tar process: ${error.message}`));
      });

      tarProcess.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`tar extraction failed with code ${code}: ${stderr}`));
      });
    });
  }

  cancelDownload() {
    if (!this.currentDownload) {
      return { success: false, error: "No active download to cancel" };
    }

    this.currentDownload.abort();
    return { success: true, message: "Download cancelled" };
  }

  async deleteModel(modelId, customDir = "") {
    const model = getStreamingModelConfig(modelId);
    if (!model) {
      return { success: false, model: modelId, deleted: false, error: "Model not found" };
    }

    if (
      this.currentModelId === modelId &&
      this.currentModelsDir === this.getModelsDir(customDir)
    ) {
      this.stopStream();
      this._releaseRecognizer();
    }

    const modelDir = this.getModelDir(modelId, customDir);
    const archivePath = this.getArchivePath(modelId, customDir);

    await fsPromises.rm(modelDir, { recursive: true, force: true }).catch(() => {});
    await fsPromises.unlink(archivePath).catch(() => {});

    return { success: true, model: modelId, deleted: true, path: modelDir };
  }

  async deleteAllModels(customDir = "") {
    const modelsDir = await this.ensureModelsDirExists(customDir);
    this.stopStream();
    this._releaseRecognizer();
    await fsPromises.rm(modelsDir, { recursive: true, force: true }).catch(() => {});
    await fsPromises.mkdir(modelsDir, { recursive: true });
    return { success: true };
  }

  /**
   * Start a new streaming session.
   * Creates a fresh OnlineStream and resets text state.
   */
  async startStream(modelId, customDir = "") {
    if (this.isActive) {
      debugLogger.warn("Stream already active, stopping first", {}, "sherpa-streaming");
      this.stopStream();
    }

    await this.loadModel(modelId, customDir);
    try {
      await this.initializeVad(customDir);
    } catch (error) {
      this.vad = null;
      debugLogger.warn(
        "Streaming VAD unavailable; continuing without auto-stop",
        { error: error.message, modelsDir: this.getModelsDir(customDir) },
        "sherpa-streaming"
      );
    }

    this.stream = this.recognizer.createStream();
    this.isActive = true;
    this.confirmedText = "";
    this.currentPartial = "";
    this.samplesReceived = 0;
    this.resetVadState();

    debugLogger.debug("Streaming session started", { modelId }, "sherpa-streaming");
    return true;
  }

  /**
   * Feed a PCM audio chunk (Int16 ArrayBuffer from AudioWorklet via IPC).
   *
   * This is the hot path — called ~every 50ms during recording.
   * Returns the display text (confirmed + partial) after decoding.
   */
  feedAudioChunk(audioBuffer) {
    if (!this.isActive || !this.stream || !this.recognizer) return null;

    // Convert Int16 ArrayBuffer to Float32 (sherpa-onnx expects Float32)
    const int16 = new Int16Array(audioBuffer);

    // 400ms skip: discard initial samples to avoid recording start sound
    if (this.samplesReceived < this.SKIP_SAMPLES) {
      const remaining = this.SKIP_SAMPLES - this.samplesReceived;
      this.samplesReceived += int16.length;
      if (int16.length <= remaining) {
        return null; // Skip entire chunk
      }
      // Partial skip: only keep the samples after the skip threshold
      const startIdx = remaining;
      const partialInt16 = int16.subarray(startIdx);
      return this._processChunk(partialInt16);
    }

    this.samplesReceived += int16.length;
    return this._processChunk(int16);
  }

  /**
   * Internal: process a single chunk through the recognizer
   */
  _processChunk(int16Data) {
    // Convert Int16 → Float32 (sherpa-onnx expects normalized float samples)
    const float32 = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
      float32[i] = int16Data[i] / 32768.0;
    }

    this._processVad(float32);

    // Feed to recognizer
    this.stream.acceptWaveform({ sampleRate: 16000, samples: float32 });

    // Decode available frames
    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream);
    }

    // Get current partial result
    const result = this.recognizer.getResult(this.stream);
    const text = result.text ? result.text.trim() : "";

    // Check for endpoint (sentence boundary)
    if (this.recognizer.isEndpoint(this.stream)) {
      if (text) {
        this.vadObservedSpeech = true;
        this._appendConfirmedSegment(text);
        this.currentPartial = "";

        // Notify final transcript for this segment
        this.onFinalTranscript?.(this.confirmedText);
      }
      // Reset stream for next sentence
      this.recognizer.reset(this.stream);
    } else if (text !== this.currentPartial) {
      // Partial result changed
      this.currentPartial = text;
      if (text) {
        this.vadObservedSpeech = true;
      }
      this.onPartialTranscript?.(this._composeDisplayText(this.currentPartial));
    }

    return this._composeDisplayText(this.currentPartial);
  }

  _appendConfirmedSegment(text) {
    const punctuatedText = this._applyLightPunctuation(text);
    if (!punctuatedText) {
      return;
    }

    if (!this.confirmedText) {
      this.confirmedText = punctuatedText;
      return;
    }

    const needsSpace = this._shouldInsertSpace(this.confirmedText, punctuatedText);

    this.confirmedText += needsSpace ? ` ${punctuatedText}` : punctuatedText;
  }

  _composeDisplayText(partialText = "") {
    if (!partialText) {
      return this.confirmedText;
    }

    if (!this.confirmedText) {
      return partialText;
    }

    return this._shouldInsertSpace(this.confirmedText, partialText)
      ? `${this.confirmedText} ${partialText}`
      : this.confirmedText + partialText;
  }

  _shouldInsertSpace(leftText, rightText) {
    const leftChar = String(leftText || "").slice(-1);
    const rightChar = String(rightText || "").slice(0, 1);

    if (!leftChar || !rightChar) {
      return false;
    }

    if (/[.?!,:;\])}]/.test(leftChar) && /[A-Za-z0-9("']/.test(rightChar)) {
      return true;
    }

    if (/[A-Za-z0-9)]/.test(leftChar) && /[A-Za-z0-9("'`]/.test(rightChar)) {
      return true;
    }

    return false;
  }

  _applyLightPunctuation(rawText) {
    const text = String(rawText || "").trim();
    if (!text) {
      return "";
    }

    const explicitReplacement = this._replaceExplicitSpokenPunctuation(text);
    const withLightPauses = this._insertLightPauses(explicitReplacement);
    if (EXISTING_PUNCTUATION_REGEX.test(withLightPauses)) {
      return withLightPauses;
    }

    const punctuation = this._selectTerminalPunctuation(withLightPauses);
    return `${withLightPauses}${punctuation}`;
  }

  _replaceExplicitSpokenPunctuation(text) {
    const usesCjk = CJK_CHAR_REGEX.test(text);
    const replacements = [
      {
        pattern: /(句号|句點|period)$/iu,
        replacement: usesCjk ? "。" : ".",
      },
      {
        pattern: /(问号|問號|疑问号|疑問號|question mark)$/iu,
        replacement: usesCjk ? "？" : "?",
      },
      {
        pattern: /(感叹号|感嘆號|惊叹号|驚嘆號|exclamation mark)$/iu,
        replacement: usesCjk ? "！" : "!",
      },
      {
        pattern: /(逗号|逗號|comma)$/iu,
        replacement: usesCjk ? "，" : ",",
      },
    ];

    for (const { pattern, replacement } of replacements) {
      if (pattern.test(text)) {
        return text.replace(pattern, replacement).replace(/\s+([,.;:?!，。？！；：])/g, "$1").trim();
      }
    }

    return text;
  }

  _insertLightPauses(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      return "";
    }

    if (CJK_CHAR_REGEX.test(trimmed)) {
      return this._insertCjkPauses(trimmed);
    }

    if (ENGLISH_WORD_REGEX.test(trimmed)) {
      return this._insertEnglishPauses(trimmed);
    }

    return trimmed;
  }

  _insertCjkPauses(text) {
    let result = text;

    for (const marker of CJK_LEADING_COMMA_MARKERS) {
      const pattern = new RegExp(`^(${escapeRegExp(marker)})(?![，。！？；：])(.{4,})$`, "u");
      result = result.replace(pattern, (_match, lead, rest) => `${lead}，${rest}`);
    }

    for (const marker of CJK_MID_COMMA_MARKERS) {
      const pattern = new RegExp(
        `([^，。！？；：]{4,})(${escapeRegExp(marker)})([^，。！？；：]{4,})`,
        "gu"
      );
      result = result.replace(pattern, (_match, left, middle, right) => {
        return `${left}，${middle}${right}`;
      });
    }

    return result;
  }

  _insertEnglishPauses(text) {
    let result = text;

    for (const marker of EN_LEADING_COMMA_MARKERS) {
      const pattern = new RegExp(
        `^(${escapeRegExp(marker)})(?![,.!?;:])\\b\\s+(.{6,})$`,
        "i"
      );
      result = result.replace(pattern, (_match, lead, rest) => {
        return `${lead}, ${String(rest || "").trimStart()}`;
      });
    }

    for (const marker of EN_MID_COMMA_MARKERS) {
      const pattern = new RegExp(
        `([A-Za-z0-9)"'\\]](?:[^,.!?;:]{6,}?))\\s+(${escapeRegExp(marker)})\\s+([^,.!?;:]{4,})`,
        "gi"
      );
      result = result.replace(pattern, (_match, left, middle, right) => {
        return `${String(left || "").trimEnd()}, ${middle} ${String(right || "").trimStart()}`;
      });
    }

    return result;
  }

  _selectTerminalPunctuation(text) {
    if (this._looksLikeQuestion(text)) {
      return CJK_CHAR_REGEX.test(text) ? "？" : "?";
    }

    if (this._looksLikeExclamation(text)) {
      return CJK_CHAR_REGEX.test(text) ? "！" : "!";
    }

    return CJK_CHAR_REGEX.test(text) ? "。" : ".";
  }

  _looksLikeQuestion(text) {
    const normalized = text.trim().toLowerCase();

    if (
      /[吗麼么呢？?]$/u.test(normalized) ||
      /^(请问|請問|谁|誰|什么|什麼|怎么|怎麼|为何|為何|为什么|為什麼|哪|哪里|哪裡|几|幾|多少|是否|是不是|有没有|有沒有|能不能|可不可以|要不要)/u.test(
        normalized
      )
    ) {
      return true;
    }

    return /^(who|what|when|where|why|how|is|are|am|do|does|did|can|could|would|should|will|have|has|had)\b/i.test(
      normalized
    );
  }

  _looksLikeExclamation(text) {
    return /(太好了|真棒|真好|太棒了|厉害|厲害|awesome|amazing|great)$/iu.test(text.trim());
  }

  _processVad(float32Data) {
    if (!this.vad || this.vadAutoStopTriggered || !this.isActive) {
      return;
    }

    try {
      this.vad.acceptWaveform(float32Data);

      if (this.vad.isDetected()) {
        this.vadObservedSpeech = true;
      }

      // sherpa-onnx only guarantees front()/pop() are safe when the completed
      // speech-segment queue is non-empty. isDetected() merely means speech is
      // currently being observed, which can happen before any segment is ready.
      while (!this.vad.isEmpty()) {
        const segment = this.vad.front();
        this.vad.pop();
        this.vadObservedSpeech = true;

        debugLogger.debug(
          "Streaming VAD detected completed speech segment",
          { samples: segment?.samples?.length || 0 },
          "sherpa-streaming"
        );

        if (!this.vadAutoStopTriggered) {
          this.vadAutoStopTriggered = true;
          this.onAutoStopRequested?.({
            reason: "vad-silence",
            minSilenceDuration: VAD_MIN_SILENCE_DURATION,
            observedSpeech: this.vadObservedSpeech,
          });
        }
      }
    } catch (error) {
      debugLogger.warn(
        "Streaming VAD processing failed; disabling auto-stop for this session",
        { error: error.message },
        "sherpa-streaming"
      );
      this.vad = null;
    }
  }

  /**
   * Stop the streaming session and return the final text.
   */
  stopStream() {
    if (!this.isActive) {
      return { text: this.confirmedText || "" };
    }

    let finalText = this.confirmedText;

    // Flush remaining audio with tail padding
    if (this.stream && this.recognizer) {
      try {
        // Add 400ms of silence to flush the recognizer
        const tailPadding = new Float32Array(16000 * 0.4);
        this.stream.acceptWaveform({ samples: tailPadding, sampleRate: 16000 });

        while (this.recognizer.isReady(this.stream)) {
          this.recognizer.decode(this.stream);
        }

        const result = this.recognizer.getResult(this.stream);
        const lastText = result.text ? result.text.trim() : "";
        if (lastText) {
          const punctuatedLastText = this._applyLightPunctuation(lastText);
          if (punctuatedLastText) {
            const needsSpace = this._shouldInsertSpace(finalText, punctuatedLastText);
            finalText += needsSpace ? ` ${punctuatedLastText}` : punctuatedLastText;
          }
        }
      } catch (e) {
        debugLogger.error("Error during stream flush", { error: e.message }, "sherpa-streaming");
      }
    }

    // Clean up stream (but keep recognizer for reuse)
    this.stream = null;
    this.isActive = false;
    this.confirmedText = "";
    this.currentPartial = "";
    this.samplesReceived = 0;
    this.resetVadState();

    debugLogger.debug(
      "Streaming session stopped",
      { textLength: finalText.length },
      "sherpa-streaming"
    );

    return { text: finalText };
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      isActive: this.isActive,
      currentModelId: this.currentModelId,
      hasRecognizer: !!this.recognizer,
      confirmedTextLength: this.confirmedText.length,
      partialTextLength: this.currentPartial.length,
    };
  }

  /**
   * Release the recognizer (free native resources)
   */
  _releaseRecognizer() {
    if (this.stream) {
      this.stream = null;
    }
    if (this.recognizer) {
      this.recognizer = null;
      this.currentModelId = null;
      this.currentModelsDir = null;
    }
    this.isActive = false;
  }

  /**
   * Full cleanup
   */
  cleanup() {
    this.stopStream();
    this._releaseRecognizer();
    if (this.currentDownload) {
      this.currentDownload.abort();
      this.currentDownload = null;
    }
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onAutoStopRequested = null;
  }
}

module.exports = SherpaStreamingManager;
module.exports.STREAMING_MODELS = STREAMING_MODELS;
module.exports.getStreamingModelsDir = getStreamingModelsDir;
module.exports.DEFAULT_STREAMING_MODEL_ID = DEFAULT_STREAMING_MODEL_ID;
