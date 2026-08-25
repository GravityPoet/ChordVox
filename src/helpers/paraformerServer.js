const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const {
  getFFmpegPath,
  isWavFormat,
  convertToWav,
  wavToFloat32Samples,
  computeFloat32RMS,
} = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const ParakeetWsServer = require("./parakeetWsServer");

const modelRegistryData = require("../models/modelRegistryData.json");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4;
const MAX_SEGMENT_SECONDS = 30;
const MAX_SEGMENT_BYTES = MAX_SEGMENT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SILENCE_RMS_THRESHOLD = 0.001;

function getParaformerModelInfo(modelName) {
  return modelRegistryData.paraformerModels[modelName] || null;
}

function getRequiredModelFiles(modelName) {
  const modelInfo = getParaformerModelInfo(modelName);
  return [modelInfo?.modelFileName || "model.onnx", modelInfo?.tokensFileName || "tokens.txt"];
}

class ParaformerServerManager {
  constructor() {
    this.wsServer = new ParakeetWsServer();
  }

  getBinaryPath() {
    return this.wsServer.getWsBinaryPath();
  }

  isAvailable() {
    return this.wsServer.isAvailable();
  }

  getModelsDir() {
    return getModelsDirForService("paraformer");
  }

  isModelDirectoryValid(modelDir, modelName = "") {
    if (!modelDir || !fs.existsSync(modelDir)) return false;
    return getRequiredModelFiles(modelName).every((file) =>
      fs.existsSync(path.join(modelDir, file))
    );
  }

  isModelDownloaded(modelName) {
    const modelDir = path.join(this.getModelsDir(), modelName);
    return this.isModelDirectoryValid(modelDir, modelName);
  }

  async _ensureWav(audioBuffer, signal = null) {
    if (isWavFormat(audioBuffer)) return { wavBuffer: audioBuffer, filesToCleanup: [] };

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      throw new Error(
        "FFmpeg not found - required for audio conversion. Please ensure FFmpeg is installed."
      );
    }

    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const tempInputPath = path.join(tempDir, `paraformer-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `paraformer-${timestamp}.wav`);

    await fs.promises.writeFile(tempInputPath, audioBuffer, { signal });
    await convertToWav(tempInputPath, tempWavPath, {
      sampleRate: SAMPLE_RATE,
      channels: 1,
      signal,
    });

    const wavBuffer = await fs.promises.readFile(tempWavPath, { signal });
    return { wavBuffer, filesToCleanup: [tempInputPath, tempWavPath] };
  }

  async _ensureWavFromFile(inputPath, signal = null) {
    const resolvedInputPath = path.resolve(inputPath);
    const tempDir = getSafeTempDir();
    const timestamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempWavPath = path.join(tempDir, `paraformer-file-${timestamp}.wav`);

    await convertToWav(resolvedInputPath, tempWavPath, {
      sampleRate: SAMPLE_RATE,
      channels: 1,
      signal,
    });

    const wavBuffer = await fs.promises.readFile(tempWavPath, { signal });
    return { wavBuffer, filesToCleanup: [tempWavPath] };
  }

  async _transcribeWavBuffer(
    wavBuffer,
    { modelKey, resolvedModelDir, modelInfo, language, signal }
  ) {
    if (!this.wsServer.ready || this.wsServer.modelName !== modelKey) {
      await this.wsServer.start(modelKey, resolvedModelDir, {
        modelType: "paraformer",
        modelFileName: modelInfo.modelFileName || "model.onnx",
        tokensFileName: modelInfo.tokensFileName || "tokens.txt",
        signal,
      });
    }

    const samples = wavToFloat32Samples(wavBuffer);
    const durationSeconds = samples.length / BYTES_PER_SAMPLE / SAMPLE_RATE;
    const rms = computeFloat32RMS(samples);
    debugLogger.debug("Paraformer audio analysis", { durationSeconds, rms });

    if (rms < SILENCE_RMS_THRESHOLD) {
      return { text: "", elapsed: 0, language };
    }

    if (samples.length <= MAX_SEGMENT_BYTES) {
      const result = await this.wsServer.transcribe(samples, SAMPLE_RATE, signal);
      return { ...result, language };
    }

    debugLogger.debug("Paraformer segmenting long audio", {
      durationSeconds,
      segmentCount: Math.ceil(samples.length / MAX_SEGMENT_BYTES),
    });

    const texts = [];
    let totalElapsed = 0;

    for (let offset = 0; offset < samples.length; offset += MAX_SEGMENT_BYTES) {
      signal?.throwIfAborted?.();
      const end = Math.min(offset + MAX_SEGMENT_BYTES, samples.length);
      const segment = samples.subarray(offset, end);
      const result = await this.wsServer.transcribe(segment, SAMPLE_RATE, signal);
      totalElapsed += result.elapsed || 0;
      if (result.text) texts.push(result.text);
    }

    return { text: texts.join(" "), elapsed: totalElapsed, language };
  }

  async transcribe(audioBuffer, options = {}) {
    const {
      modelName = "paraformer-large-zh",
      modelPath = "",
      language = "zh",
      signal = null,
    } = options;
    const resolvedModelDir = modelPath
      ? path.resolve(modelPath)
      : path.join(this.getModelsDir(), modelName);
    const modelKey = modelPath ? `path:${resolvedModelDir.toLowerCase()}` : modelName;
    const modelInfo = getParaformerModelInfo(modelName) || {};

    if (!this.isModelDirectoryValid(resolvedModelDir, modelName)) {
      throw new Error(`Paraformer model directory not found or invalid: ${resolvedModelDir}`);
    }

    debugLogger.debug("Paraformer transcription request", {
      modelName,
      modelPath: modelPath || null,
      language,
      audioSize: audioBuffer?.length || 0,
      isWavFormat: isWavFormat(audioBuffer),
    });

    const { wavBuffer, filesToCleanup } = await this._ensureWav(audioBuffer, signal);
    try {
      return await this._transcribeWavBuffer(wavBuffer, {
        modelKey,
        resolvedModelDir,
        modelInfo,
        language,
        signal,
      });
    } finally {
      await this._cleanupFiles(filesToCleanup);
    }
  }

  async transcribeFile(inputPath, options = {}) {
    const {
      modelName = "paraformer-large-zh",
      modelPath = "",
      language = "zh",
      signal = null,
    } = options;
    const resolvedInputPath = path.resolve(inputPath);
    const resolvedModelDir = modelPath
      ? path.resolve(modelPath)
      : path.join(this.getModelsDir(), modelName);
    const modelKey = modelPath ? `path:${resolvedModelDir.toLowerCase()}` : modelName;
    const modelInfo = getParaformerModelInfo(modelName) || {};

    if (!this.isModelDirectoryValid(resolvedModelDir, modelName)) {
      throw new Error(`Paraformer model directory not found or invalid: ${resolvedModelDir}`);
    }

    debugLogger.debug("Paraformer file transcription request", {
      modelName,
      modelPath: modelPath || null,
      language,
      inputPath: resolvedInputPath,
    });

    const { wavBuffer, filesToCleanup } = await this._ensureWavFromFile(resolvedInputPath, signal);
    try {
      return await this._transcribeWavBuffer(wavBuffer, {
        modelKey,
        resolvedModelDir,
        modelInfo,
        language,
        signal,
      });
    } finally {
      await this._cleanupFiles(filesToCleanup);
    }
  }

  async _cleanupFiles(filePaths) {
    for (const filePath of filePaths) {
      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        if (err?.code !== "ENOENT") {
          debugLogger.warn("Failed to cleanup temp audio file", {
            path: filePath,
            error: err.message,
          });
        }
      }
    }
  }

  async startServer(modelName) {
    if (!this.wsServer.isAvailable()) {
      return { success: false, reason: "paraformer WS server binary not found" };
    }

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    const modelInfo = getParaformerModelInfo(modelName) || {};
    try {
      await this.wsServer.start(modelName, modelDir, {
        modelType: "paraformer",
        modelFileName: modelInfo.modelFileName || "model.onnx",
        tokensFileName: modelInfo.tokensFileName || "tokens.txt",
      });
      return { success: true, port: this.wsServer.port };
    } catch (error) {
      debugLogger.warn("Paraformer WS server did not start", { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  async stopServer() {
    await this.wsServer.stop();
  }

  getServerStatus() {
    return this.wsServer.getStatus();
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      binaryPath: this.getBinaryPath(),
      modelsDir: this.getModelsDir(),
    };
  }
}

module.exports = ParaformerServerManager;
