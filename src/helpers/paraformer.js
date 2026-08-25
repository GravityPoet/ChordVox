const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const debugLogger = require("./debugLogger");
const { createDownloadSignal, cleanupStaleDownloads, checkDiskSpace } = require("./downloadUtils");
const {
  buildDownloadSources,
  defaultMirrorPathFromUrl,
  downloadArtifactFromSources,
  validateDownloadedArtifact,
} = require("./modelDownloadSources");
const ParaformerServerManager = require("./paraformerServer");
const { getModelsDirForService } = require("./modelDirUtils");
const { applyLightPunctuation } = require("./asrPunctuation");
const { addMlPunctuation } = require("./punctuationModel");
const { runSystemTarExtractSafe } = require("./archiveSecurity");
const { resolveInsideDirectory } = require("./pathSecurity");

const modelRegistryData = require("../models/modelRegistryData.json");
const DEFAULT_PARAFORMER_MODEL = "paraformer-large-zh";

function getParaformerModelConfig(modelName) {
  const modelInfo = modelRegistryData.paraformerModels[modelName];
  if (!modelInfo) return null;
  return {
    url: modelInfo.downloadUrl,
    size: modelInfo.expectedSizeBytes || modelInfo.sizeMb * 1_000_000,
    language: modelInfo.language,
    supportedLanguages: modelInfo.supportedLanguages || [],
    archiveFileName: modelInfo.archiveFileName || "",
    archiveSizeBytes: modelInfo.archiveSizeBytes || 0,
    sha256: modelInfo.sha256 || "",
    mirrors: modelInfo.mirrors || [],
    mirrorPath: modelInfo.mirrorPath || "",
    extractDir: modelInfo.extractDir,
    modelFileName: modelInfo.modelFileName || "model.onnx",
    tokensFileName: modelInfo.tokensFileName || "tokens.txt",
    extractedFiles: Array.isArray(modelInfo.extractedFiles) ? modelInfo.extractedFiles : [],
  };
}

function getValidModelNames() {
  return Object.keys(modelRegistryData.paraformerModels || {});
}

function getRequiredModelFiles(modelName) {
  const modelConfig = getParaformerModelConfig(modelName) || {};
  return [modelConfig.modelFileName || "model.onnx", modelConfig.tokensFileName || "tokens.txt"];
}

function getSafeArchiveFileName(value, fallbackName) {
  const basename = path.basename(String(value || "").trim());
  if (!basename || basename === "." || basename === "..") return fallbackName;
  return basename;
}

class ParaformerManager {
  constructor() {
    this.currentDownloadProcess = null;
    this.activeDownloads = new Map();
    this.isInitialized = false;
    this.serverManager = new ParaformerServerManager();
  }

  getModelsDir() {
    return getModelsDirForService("paraformer");
  }

  resolveModelsDir(modelsDir = "") {
    const trimmed = String(modelsDir || "").trim();
    return trimmed ? path.resolve(trimmed) : this.getModelsDir();
  }

  validateModelName(modelName) {
    const validModels = getValidModelNames();
    if (!validModels.includes(modelName)) {
      throw new Error(
        `Invalid Paraformer model: ${modelName}. Valid models: ${validModels.join(", ")}`
      );
    }
    return true;
  }

  getModelPath(modelName) {
    this.validateModelName(modelName);
    return path.join(this.getModelsDir(), modelName);
  }

  getModelPathInDir(modelName, modelsDir) {
    this.validateModelName(modelName);
    return path.join(modelsDir, modelName);
  }

  createScopedProgressCallback(progressCallback, modelsDir) {
    if (!progressCallback) return null;
    return (progressData) => {
      progressCallback({
        ...progressData,
        modelsDir,
      });
    };
  }

  isLikelyCustomModelPath(value) {
    const raw = String(value || "").trim();
    if (!raw) return false;
    return raw.includes("/") || raw.includes("\\");
  }

  resolveModelSelection(modelOrPath = DEFAULT_PARAFORMER_MODEL, explicitModelPath = "") {
    const directPath = String(explicitModelPath || "").trim();
    const raw = String(modelOrPath || "").trim() || DEFAULT_PARAFORMER_MODEL;
    const rawPath = directPath || (this.isLikelyCustomModelPath(raw) ? raw : "");

    if (rawPath) {
      const resolvedPath = path.resolve(rawPath);
      return {
        modelName: null,
        modelPath: resolvedPath,
        modelKey: `path:${resolvedPath.toLowerCase()}`,
        modelLabel: path.basename(resolvedPath),
      };
    }

    this.validateModelName(raw);
    return {
      modelName: raw,
      modelPath: this.getModelPath(raw),
      modelKey: raw,
      modelLabel: raw,
    };
  }

  async initializeAtStartup(settings = {}) {
    const startTime = Date.now();

    try {
      this.isInitialized = true;
      await cleanupStaleDownloads(this.getModelsDir());
      await this.logDependencyStatus();

      const { localTranscriptionProvider, paraformerModel } = settings;
      if (
        localTranscriptionProvider === "paraformer" &&
        paraformerModel &&
        this.serverManager.isAvailable()
      ) {
        const selection = this.resolveModelSelection(paraformerModel);

        if (!selection.modelName) {
          debugLogger.debug("Skipping Paraformer server pre-warm: custom model path configured", {
            modelPath: selection.modelPath,
          });
        } else if (this.serverManager.isModelDownloaded(selection.modelName)) {
          debugLogger.info("Pre-warming Paraformer server", { model: selection.modelLabel });
          try {
            const serverStartTime = Date.now();
            const result = await this.serverManager.startServer(selection.modelName);
            if (!result?.success) {
              throw new Error(result?.reason || "Paraformer server did not become ready");
            }
            debugLogger.info("Paraformer server pre-warmed successfully", {
              model: selection.modelLabel,
              startupTimeMs: Date.now() - serverStartTime,
            });
          } catch (err) {
            debugLogger.warn("Paraformer server pre-warm failed (will start on first use)", {
              error: err.message,
              model: selection.modelLabel,
            });
          }
        } else {
          debugLogger.debug("Skipping Paraformer server pre-warm: model not downloaded", {
            model: selection.modelLabel,
            modelPath: selection.modelPath,
          });
        }
      } else {
        debugLogger.debug("Skipping Paraformer server pre-warm", {
          reason:
            localTranscriptionProvider !== "paraformer"
              ? "provider not paraformer"
              : !paraformerModel
                ? "no model selected"
                : "server binary not available",
        });
      }
    } catch (error) {
      debugLogger.warn("Paraformer initialization error", { error: error.message });
      this.isInitialized = true;
    }

    debugLogger.info("Paraformer initialization complete", {
      totalTimeMs: Date.now() - startTime,
      binaryAvailable: this.serverManager.isAvailable(),
    });
  }

  async logDependencyStatus() {
    const status = {
      sherpaOnnx: {
        available: this.serverManager.isAvailable(),
        path: this.serverManager.getBinaryPath(),
      },
      models: [],
    };

    for (const modelName of getValidModelNames()) {
      const modelPath = this.getModelPath(modelName);
      const modelConfig = getParaformerModelConfig(modelName);
      if (this.serverManager.isModelDownloaded(modelName)) {
        try {
          const modelFilePath = path.join(modelPath, modelConfig.modelFileName);
          const stats = fs.statSync(modelFilePath);
          status.models.push({
            name: modelName,
            size: `${Math.round(stats.size / (1024 * 1024))}MB`,
          });
        } catch {}
      }
    }

    debugLogger.info("Paraformer dependency check", status);
  }

  async checkInstallation() {
    const binaryPath = this.serverManager.getBinaryPath();
    if (!binaryPath) {
      return { installed: false, working: false };
    }

    return {
      installed: true,
      working: this.serverManager.isAvailable(),
      path: binaryPath,
    };
  }

  async startServer(modelName) {
    this.validateModelName(modelName);
    return this.serverManager.startServer(modelName);
  }

  async stopServer() {
    await this.serverManager.stopServer();
  }

  getServerStatus() {
    return this.serverManager.getServerStatus();
  }

  async transcribeLocalParaformer(audioBlob, options = {}) {
    debugLogger.logSTTPipeline("transcribeLocalParaformer - start", {
      options,
      audioBlobType: audioBlob?.constructor?.name,
      audioBlobSize: audioBlob?.byteLength || audioBlob?.size || 0,
      serverAvailable: this.serverManager.isAvailable(),
    });

    if (!this.serverManager.isAvailable()) {
      throw new Error(
        "sherpa-onnx binary not found. Please ensure the app is installed correctly."
      );
    }

    const selection = this.resolveModelSelection(options.model, options.modelPath);
    const modelPath = selection.modelPath;
    const modelLabel = selection.modelLabel;

    if (!this.serverManager.isModelDirectoryValid(modelPath, selection.modelName || undefined)) {
      throw new Error(
        selection.modelName
          ? `Paraformer model "${selection.modelName}" not downloaded. Please download it from Settings.`
          : `Paraformer model directory not found or invalid: ${modelPath}`
      );
    }

    let audioBuffer;
    if (Buffer.isBuffer(audioBlob)) {
      audioBuffer = audioBlob;
    } else if (ArrayBuffer.isView(audioBlob)) {
      audioBuffer = Buffer.from(audioBlob.buffer, audioBlob.byteOffset, audioBlob.byteLength);
    } else if (audioBlob instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(audioBlob);
    } else if (typeof audioBlob === "string") {
      audioBuffer = Buffer.from(audioBlob, "base64");
    } else if (audioBlob && audioBlob.buffer && typeof audioBlob.byteLength === "number") {
      audioBuffer = Buffer.from(audioBlob.buffer, audioBlob.byteOffset || 0, audioBlob.byteLength);
    } else {
      throw new Error(`Unsupported audio data type: ${typeof audioBlob}`);
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Audio buffer is empty - no audio data received");
    }

    debugLogger.logSTTPipeline("transcribeLocalParaformer - processing", {
      bufferSize: audioBuffer.length,
      model: modelLabel,
      modelPath,
    });

    const startTime = Date.now();
    const language = options.language || "zh";
    const result = await this.serverManager.transcribe(audioBuffer, {
      modelName: selection.modelName || DEFAULT_PARAFORMER_MODEL,
      modelPath: selection.modelName ? "" : modelPath,
      language,
      signal: options.signal,
    });
    const elapsed = Date.now() - startTime;

    debugLogger.logSTTPipeline("transcribeLocalParaformer - completed", {
      elapsed,
      textLength: result.text?.length || 0,
    });

    return this.parseParaformerResult(result);
  }

  async transcribeLocalParaformerFile(filePath, options = {}) {
    debugLogger.logSTTPipeline("transcribeLocalParaformerFile - start", {
      options,
      filePath,
      serverAvailable: this.serverManager.isAvailable(),
    });

    if (!this.serverManager.isAvailable()) {
      throw new Error(
        "sherpa-onnx binary not found. Please ensure the app is installed correctly."
      );
    }

    const selection = this.resolveModelSelection(options.model, options.modelPath);
    const modelPath = selection.modelPath;
    const modelLabel = selection.modelLabel;

    if (!this.serverManager.isModelDirectoryValid(modelPath, selection.modelName || undefined)) {
      throw new Error(
        selection.modelName
          ? `Paraformer model "${selection.modelName}" not downloaded. Please download it from Settings.`
          : `Paraformer model directory not found or invalid: ${modelPath}`
      );
    }

    const resolvedFilePath = path.resolve(String(filePath || ""));
    const stats = await fsPromises.stat(resolvedFilePath);
    if (!stats.isFile()) {
      throw new Error("Selected audio path is not a file");
    }

    debugLogger.logSTTPipeline("transcribeLocalParaformerFile - processing", {
      fileSize: stats.size,
      model: modelLabel,
      modelPath,
    });

    const startTime = Date.now();
    const language = options.language || "zh";
    const result = await this.serverManager.transcribeFile(resolvedFilePath, {
      modelName: selection.modelName || DEFAULT_PARAFORMER_MODEL,
      modelPath: selection.modelName ? "" : modelPath,
      language,
      signal: options.signal,
    });
    const elapsed = Date.now() - startTime;

    debugLogger.logSTTPipeline("transcribeLocalParaformerFile - completed", {
      elapsed,
      textLength: result.text?.length || 0,
    });

    return this.parseParaformerResult(result);
  }

  parseParaformerResult(output) {
    debugLogger.debug("parseParaformerResult", {
      hasOutput: !!output,
      hasText: !!output?.text,
      textLength: output?.text?.length || 0,
    });

    if (!output || !output.text) {
      return { success: false, message: "No audio detected" };
    }

    const text = addMlPunctuation(output.text) ?? applyLightPunctuation(output.text);
    if (!text) {
      return { success: false, message: "No audio detected" };
    }

    return { success: true, text };
  }

  async validateExtractedModelFiles(modelPath, modelConfig) {
    if (!Array.isArray(modelConfig.extractedFiles) || modelConfig.extractedFiles.length === 0) {
      return;
    }

    for (const file of modelConfig.extractedFiles) {
      if (!String(file.path || "").trim()) continue;
      const resolvedPath = resolveInsideDirectory(
        modelPath,
        file.path,
        "Paraformer model file path"
      );
      await validateDownloadedArtifact(resolvedPath, {
        expectedSize: Number(file.sizeBytes || 0),
        sha256: file.sha256 || "",
        strictSize: Boolean(file.sizeBytes || file.sha256),
      });
    }
  }

  async downloadParaformerModel(modelName, progressCallback = null, options = {}) {
    this.validateModelName(modelName);
    const modelsDir = this.resolveModelsDir(options.modelsDir);
    const downloadKey = `${modelName}:${path.resolve(modelsDir)}`;

    const existingDownload = this.activeDownloads.get(downloadKey);
    if (existingDownload) {
      debugLogger.info("Joining active Paraformer model download", { modelName, modelsDir });
      return existingDownload;
    }

    const downloadPromise = this._downloadParaformerModel(
      modelName,
      progressCallback,
      options,
      modelsDir
    );
    this.activeDownloads.set(downloadKey, downloadPromise);

    try {
      return await downloadPromise;
    } finally {
      if (this.activeDownloads.get(downloadKey) === downloadPromise) {
        this.activeDownloads.delete(downloadKey);
      }
    }
  }

  async _downloadParaformerModel(modelName, progressCallback = null, options = {}, modelsDir) {
    const modelConfig = getParaformerModelConfig(modelName);
    const modelPath = this.getModelPathInDir(modelName, modelsDir);
    const scopedProgressCallback = this.createScopedProgressCallback(progressCallback, modelsDir);

    await fsPromises.mkdir(modelsDir, { recursive: true });

    if (this.serverManager.isModelDirectoryValid(modelPath, modelName)) {
      try {
        await this.validateExtractedModelFiles(modelPath, modelConfig);
        return { model: modelName, downloaded: true, path: modelPath, success: true };
      } catch (error) {
        debugLogger.warn("Removing invalid Paraformer model before repair download", {
          model: modelName,
          path: modelPath,
          error: error.message,
        });
        scopedProgressCallback?.({ type: "repairing", model: modelName, percentage: 0 });
        await fsPromises.rm(modelPath, { recursive: true, force: true }).catch(() => {});
      }
    }

    const spaceCheck = await checkDiskSpace(modelsDir, modelConfig.size * 2.5);
    if (!spaceCheck.ok) {
      throw new Error(
        `Not enough disk space to download and extract model. Need ~${Math.round((modelConfig.size * 2.5) / 1_000_000)}MB, ` +
          `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
      );
    }

    const archiveFileName = getSafeArchiveFileName(
      modelConfig.archiveFileName,
      `${modelName}.tar.bz2`
    );
    const archivePath = path.join(modelsDir, archiveFileName);
    const { signal, abort } = createDownloadSignal();
    this.currentDownloadProcess = { abort };

    try {
      let archiveReady = false;
      try {
        const stats = await fsPromises.stat(archivePath);
        if (stats.size > 0) {
          try {
            await validateDownloadedArtifact(archivePath, {
              expectedSize: modelConfig.archiveSizeBytes,
              sha256: modelConfig.sha256,
              strictSize: Boolean(modelConfig.archiveSizeBytes || modelConfig.sha256),
            });
            archiveReady = true;
            debugLogger.info("Reusing existing Paraformer archive from previous attempt", {
              archivePath,
              size: stats.size,
            });
          } catch (error) {
            await fsPromises.unlink(archivePath).catch(() => {});
            scopedProgressCallback?.({ type: "repairing", model: modelName, percentage: 0 });
            debugLogger.warn("Discarding invalid Paraformer archive", {
              archivePath,
              size: stats.size,
              expectedSize: modelConfig.archiveSizeBytes,
              error: error.message,
            });
          }
        }
      } catch {}

      if (!archiveReady) {
        await downloadArtifactFromSources({
          artifactLabel: path.basename(archivePath),
          modelId: modelName,
          destination: archivePath,
          sources: buildDownloadSources(
            {
              primaryUrl: modelConfig.url,
              mirrors: modelConfig.mirrors,
              mirrorPath:
                modelConfig.mirrorPath ||
                defaultMirrorPathFromUrl(modelConfig.url, path.basename(archivePath)),
            },
            options
          ),
          expectedSize: modelConfig.archiveSizeBytes || 0,
          sha256: modelConfig.sha256,
          strictSize: Boolean(modelConfig.archiveSizeBytes),
          signal,
          progressCallback: scopedProgressCallback,
        });
      }

      scopedProgressCallback?.({ type: "installing", model: modelName, percentage: 100 });

      const MAX_EXTRACT_RETRIES = 2;
      for (let attempt = 1; attempt <= MAX_EXTRACT_RETRIES; attempt++) {
        try {
          await this._extractModel(archivePath, modelName, modelsDir, signal);
          await this.validateExtractedModelFiles(modelPath, modelConfig);
          break;
        } catch (extractError) {
          if (extractError?.isAbort || signal.aborted) {
            throw extractError;
          }
          debugLogger.warn("Paraformer model extraction failed", {
            attempt,
            maxAttempts: MAX_EXTRACT_RETRIES,
            error: extractError.message,
          });
          if (attempt >= MAX_EXTRACT_RETRIES) {
            const err = new Error(`Model installation failed: ${extractError.message}`);
            err.code = "EXTRACTION_FAILED";
            throw err;
          }
        }
      }

      await fsPromises.unlink(archivePath).catch(() => {});
      scopedProgressCallback?.({ type: "complete", model: modelName, percentage: 100 });

      if (
        this.serverManager.isAvailable() &&
        path.resolve(this.getModelsDir()) === path.resolve(modelsDir)
      ) {
        this.serverManager.startServer(modelName).catch((err) => {
          debugLogger.warn("Post-download Paraformer server pre-warm failed (non-fatal)", {
            error: err.message,
            model: modelName,
          });
        });
      }

      return { model: modelName, downloaded: true, path: modelPath, success: true };
    } catch (error) {
      if (error.isAbort || signal.aborted) {
        throw new Error("Download interrupted by user");
      }
      throw error;
    } finally {
      this.currentDownloadProcess = null;
    }
  }

  async _extractModel(archivePath, modelName, modelsDir = this.getModelsDir(), signal = null) {
    const modelConfig = getParaformerModelConfig(modelName);
    const extractDir = path.join(modelsDir, `temp-extract-${modelName}`);

    try {
      await fsPromises.mkdir(extractDir, { recursive: true });
      debugLogger.info("Extracting Paraformer archive", { archivePath, extractDir });
      await this._runTarExtract(archivePath, extractDir, signal);

      const extractedDir = resolveInsideDirectory(
        extractDir,
        modelConfig.extractDir,
        "Paraformer extract directory"
      );
      const targetDir = this.getModelPathInDir(modelName, modelsDir);

      if (fs.existsSync(extractedDir)) {
        if (fs.existsSync(targetDir)) {
          await fsPromises.rm(targetDir, { recursive: true, force: true });
        }
        await fsPromises.rename(extractedDir, targetDir);
      } else {
        const entries = await fsPromises.readdir(extractDir);
        let modelDir = null;

        for (const entry of entries) {
          const entryPath = path.join(extractDir, entry);
          const stat = await fsPromises.stat(entryPath);
          if (stat.isDirectory() && entry.toLowerCase().includes("paraformer")) {
            modelDir = entry;
            break;
          }
        }

        if (modelDir) {
          if (fs.existsSync(targetDir)) {
            await fsPromises.rm(targetDir, { recursive: true, force: true });
          }
          await fsPromises.rename(
            resolveInsideDirectory(extractDir, modelDir, "Paraformer extracted model directory"),
            targetDir
          );
        } else {
          throw new Error(
            `Could not find model directory in extracted archive. ` +
              `Expected "${modelConfig.extractDir}", found: [${entries.join(", ")}]`
          );
        }
      }

      const missing = [modelConfig.modelFileName, modelConfig.tokensFileName].filter(
        (file) =>
          !fs.existsSync(resolveInsideDirectory(targetDir, file, "Paraformer required file"))
      );
      if (missing.length > 0) {
        throw new Error(`Extracted model is missing required files: ${missing.join(", ")}`);
      }

      if (modelConfig.modelFileName !== "model.int8.onnx") {
        const unusedQuantizedModelPath = resolveInsideDirectory(
          targetDir,
          "model.int8.onnx",
          "Paraformer quantized model file"
        );
        if (fs.existsSync(unusedQuantizedModelPath)) {
          await fsPromises.rm(unusedQuantizedModelPath, { force: true });
          debugLogger.info("Removed unused Paraformer quantized model file", {
            modelName,
            file: "model.int8.onnx",
          });
        }
      }

      await fsPromises.rm(extractDir, { recursive: true, force: true });
      debugLogger.info("Paraformer model extracted", { modelName, targetDir });
    } catch (error) {
      try {
        await fsPromises.rm(extractDir, { recursive: true, force: true });
      } catch {}
      throw error;
    }
  }

  _runTarExtract(archivePath, extractDir, signal = null) {
    return runSystemTarExtractSafe(archivePath, extractDir, ["-xjf"], { signal });
  }

  async cancelDownload() {
    if (this.currentDownloadProcess) {
      this.currentDownloadProcess.abort();
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async checkModelStatus(modelName, explicitModelPath = "") {
    let selection;
    try {
      selection = this.resolveModelSelection(modelName, explicitModelPath);
    } catch {
      return { model: modelName, downloaded: false, success: true };
    }

    const modelPath = selection.modelPath;
    const modelLabel = selection.modelName || selection.modelLabel;
    const modelConfig = getParaformerModelConfig(selection.modelName || DEFAULT_PARAFORMER_MODEL);

    if (this.serverManager.isModelDirectoryValid(modelPath, selection.modelName || undefined)) {
      try {
        const modelFilePath = path.join(modelPath, modelConfig.modelFileName);
        const stats = fs.statSync(modelFilePath);
        return {
          model: modelLabel,
          downloaded: true,
          path: modelPath,
          size_bytes: stats.size,
          size_mb: Math.round(stats.size / (1024 * 1024)),
          success: true,
        };
      } catch {
        return { model: modelLabel, downloaded: false, success: true };
      }
    }

    return { model: modelLabel, downloaded: false, success: true };
  }

  async listParaformerModels() {
    const models = getValidModelNames();
    const modelInfo = [];

    for (const model of models) {
      const status = await this.checkModelStatus(model);
      modelInfo.push(status);
    }

    return {
      models: modelInfo,
      cache_dir: this.getModelsDir(),
      success: true,
    };
  }

  async deleteParaformerModel(modelName) {
    const modelPath = this.getModelPath(modelName);
    const modelConfig = getParaformerModelConfig(modelName);

    if (fs.existsSync(modelPath)) {
      try {
        const modelFilePath = path.join(modelPath, modelConfig.modelFileName);
        let freedBytes = 0;
        if (fs.existsSync(modelFilePath)) {
          const stats = fs.statSync(modelFilePath);
          freedBytes = stats.size;
        }

        fs.rmSync(modelPath, { recursive: true, force: true });

        return {
          model: modelName,
          deleted: true,
          freed_bytes: freedBytes,
          freed_mb: Math.round(freedBytes / (1024 * 1024)),
          success: true,
        };
      } catch (error) {
        return { model: modelName, deleted: false, error: error.message, success: false };
      }
    }

    return { model: modelName, deleted: false, error: "Model not found", success: false };
  }

  async deleteAllParaformerModels() {
    const modelsDir = this.getModelsDir();
    let totalFreed = 0;
    let deletedCount = 0;

    try {
      if (!fs.existsSync(modelsDir)) {
        return { success: true, deleted_count: 0, freed_bytes: 0, freed_mb: 0 };
      }

      const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(modelsDir, entry.name);
          try {
            for (const file of getRequiredModelFiles(entry.name)) {
              const filePath = path.join(dirPath, file);
              if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                totalFreed += stats.size;
              }
            }

            fs.rmSync(dirPath, { recursive: true, force: true });
            deletedCount++;
          } catch {}
        }
      }

      return {
        success: true,
        deleted_count: deletedCount,
        freed_bytes: totalFreed,
        freed_mb: Math.round(totalFreed / (1024 * 1024)),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getDiagnostics() {
    const diagnostics = {
      platform: process.platform,
      arch: process.arch,
      resourcesPath: process.resourcesPath || null,
      isPackaged: !!process.resourcesPath && !process.resourcesPath.includes("node_modules"),
      sherpaOnnx: { available: false, path: null },
      modelsDir: this.getModelsDir(),
      models: [],
    };

    const binaryPath = this.serverManager.getBinaryPath();
    if (binaryPath) {
      diagnostics.sherpaOnnx = { available: true, path: binaryPath };
    }

    try {
      const modelsDir = this.getModelsDir();
      if (fs.existsSync(modelsDir)) {
        const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
        diagnostics.models = entries
          .filter((e) => e.isDirectory() && this.serverManager.isModelDownloaded(e.name))
          .map((e) => e.name);
      }
    } catch {}

    return diagnostics;
  }
}

module.exports = ParaformerManager;
