const fs = require("fs");
const fsPromises = require("fs").promises;
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const { getSafeTempDir } = require("./safeTempDir");
const { convertToWav } = require("./ffmpegUtils");
const { killProcess } = require("../utils/process");
const {
  downloadFile,
  createDownloadSignal,
  validateFileSize,
  cleanupStaleDownloads,
  checkDiskSpace,
} = require("./downloadUtils");
const { getModelsDirForService } = require("./modelDirUtils");
const modelRegistryData = require("../models/modelRegistryData.json");

const DEFAULT_TIMEOUT_MS = 300000;

function getSenseVoiceModelConfig(modelName) {
  const modelInfo = modelRegistryData.senseVoiceModels?.[modelName];
  if (!modelInfo) return null;
  return {
    url: modelInfo.downloadUrl,
    size: modelInfo.expectedSizeBytes || modelInfo.sizeMb * 1_000_000,
    fileName: modelInfo.fileName,
    runtimeSupported: modelInfo.runtimeSupported !== false,
    runtimeKind: modelInfo.runtimeKind || "sensevoice",
    customRelativeDir: modelInfo.customRelativeDir || "",
    additionalFiles: Array.isArray(modelInfo.additionalFiles) ? modelInfo.additionalFiles : [],
  };
}

function getValidSenseVoiceModelNames() {
  return Object.keys(modelRegistryData.senseVoiceModels || {});
}

function normalizeLanguage(language) {
  const value = String(language || "auto").trim().toLowerCase();
  const supported = new Set(["auto", "zh", "en", "yue", "ja", "ko"]);
  return supported.has(value) ? value : "auto";
}

function normalizeTranscript(text) {
  if (!text) return "";
  return text
    .replace(/<\|[^>]+?\|>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeErrorSnippet(text, maxLength = 300) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

function fileExists(filePath) {
  try {
    return !!filePath && fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function ensureExecutable(filePath) {
  if (!fileExists(filePath)) return false;
  if (process.platform === "win32") return true;

  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    try {
      fs.chmodSync(filePath, 0o755);
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
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

class SenseVoiceManager {
  constructor() {
    this.cachedBinaryPath = null;
    this.currentDownloadProcess = null;
  }

  getModelsDir(modelName = "") {
    const config =
      modelName && getValidSenseVoiceModelNames().includes(modelName)
        ? getSenseVoiceModelConfig(modelName)
        : null;

    if (config?.customRelativeDir) {
      return path.join(os.homedir(), config.customRelativeDir);
    }

    return getModelsDirForService("sensevoice");
  }

  getManagedModelDirs() {
    const dirs = new Set([this.getModelsDir()]);
    for (const modelName of getValidSenseVoiceModelNames()) {
      dirs.add(this.getModelsDir(modelName));
    }
    return Array.from(dirs);
  }

  validateModelName(modelName) {
    const validModels = getValidSenseVoiceModelNames();
    if (!validModels.includes(modelName)) {
      throw new Error(
        `Invalid SenseVoice model: ${modelName}. Valid models: ${validModels.join(", ")}`
      );
    }
    return true;
  }

  getModelPath(modelName) {
    this.validateModelName(modelName);
    const config = getSenseVoiceModelConfig(modelName);
    return path.join(this.getModelsDir(modelName), config.fileName);
  }

  getRequiredFiles(modelName) {
    this.validateModelName(modelName);
    const config = getSenseVoiceModelConfig(modelName);
    const baseDir = this.getModelsDir(modelName);
    return [
      {
        fileName: config.fileName,
        url: config.url,
        expectedSizeBytes: config.size,
        path: path.join(baseDir, config.fileName),
      },
      ...config.additionalFiles.map((fileInfo) => ({
        fileName: fileInfo.fileName,
        url: fileInfo.downloadUrl,
        expectedSizeBytes: fileInfo.expectedSizeBytes || 0,
        path: path.join(baseDir, fileInfo.fileName),
      })),
    ];
  }

  _getBinaryName() {
    return process.platform === "win32" ? "sense-voice-main.exe" : "sense-voice-main";
  }

  _findBinaryInPath(binaryName) {
    const pathEnv = process.env.PATH || "";
    const separator = process.platform === "win32" ? ";" : ":";
    const candidates = pathEnv.split(separator).filter(Boolean);

    for (const dir of candidates) {
      const cleanDir = dir.replace(/^"|"$/g, "");
      const candidate = path.join(cleanDir, binaryName);
      if (ensureExecutable(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  _resolveBinaryPath(customPath) {
    if (this.cachedBinaryPath && !customPath) {
      return this.cachedBinaryPath;
    }

    const binaryName = this._getBinaryName();
    const candidates = [];

    if (customPath && String(customPath).trim()) {
      candidates.push(String(customPath).trim());
    }
    if (process.env.SENSEVOICE_BINARY_PATH) {
      candidates.push(process.env.SENSEVOICE_BINARY_PATH);
    }

    const home = os.homedir();
    candidates.push(
      path.join(home, "Tools", "本地语音大模型", "SenseVoice.cpp", "build", "bin", binaryName),
      path.join(home, "Tools", "SenseVoice.cpp", "build", "bin", binaryName),
      path.join(home, "SenseVoice.cpp", "build", "bin", binaryName)
    );

    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "bin", binaryName)
      );
    }

    for (const candidate of candidates) {
      if (ensureExecutable(candidate)) {
        if (!customPath) {
          this.cachedBinaryPath = candidate;
        }
        return candidate;
      }
    }

    const fromPath = this._findBinaryInPath(binaryName);
    if (fromPath) {
      if (!customPath) {
        this.cachedBinaryPath = fromPath;
      }
      return fromPath;
    }

    throw new Error(
      "SenseVoice binary not found. Configure sense-voice-main path in settings."
    );
  }

  _resolveModelTarget(modelPath) {
    const resolved = String(modelPath || process.env.SENSEVOICE_MODEL_PATH || "").trim();
    if (!resolved) {
      throw new Error(
        "Others model path is empty. Please select a local model file or downloaded model."
      );
    }

    if (getValidSenseVoiceModelNames().includes(resolved)) {
      const config = getSenseVoiceModelConfig(resolved);
      const byNamePath = this.getModelPath(resolved);
      if (!fileExists(byNamePath)) {
        throw new Error(`Others model file not found: ${byNamePath}`);
      }
      return {
        runtimeKind: config.runtimeKind || "sensevoice",
        modelPath: byNamePath,
        modelName: resolved,
      };
    }

    if (fileExists(resolved) && fs.statSync(resolved).isDirectory()) {
      throw new Error(`Others model directory not supported: ${resolved}`);
    }

    const fileName = path.basename(resolved).toLowerCase();
    if (fileName === "model.pth.tar") {
      throw new Error(
        "FireRedASR2-AED has been removed from Others. Please switch to a SenseVoice Small model."
      );
    }

    if (!fileExists(resolved)) {
      throw new Error(`Others model file not found: ${resolved}`);
    }

    if (fileName === "config.json") {
      throw new Error(
        "Qwen3-ASR has been removed from Others. Please switch to a SenseVoice Small model."
      );
    }

    return {
      runtimeKind: "sensevoice",
      modelPath: resolved,
    };
  }

  _extractText(output) {
    const lines = String(output || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) return "";

    const segmentTexts = [];
    for (const line of lines) {
      const segmentMatch = line.match(/^\[\s*\d+(?:\.\d+)?-\d+(?:\.\d+)?\]\s+(.+)$/);
      if (segmentMatch?.[1]) {
        segmentTexts.push(segmentMatch[1].trim());
      }
    }

    if (segmentTexts.length > 0) {
      return normalizeTranscript(segmentTexts.join(" "));
    }

    const noisePrefixes = [
      "sense_voice_",
      "ggml_",
      "main:",
      "system_info:",
      "usage:",
      "error:",
      "warning:",
    ];

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      const lower = line.toLowerCase();
      if (noisePrefixes.some((prefix) => lower.startsWith(prefix))) {
        continue;
      }
      const normalized = normalizeTranscript(line);
      if (normalized) {
        return normalized;
      }
    }

    return "";
  }

  async checkInstallation(binaryPath = "") {
    try {
      const resolved = this._resolveBinaryPath(binaryPath);
      return { installed: true, working: true, path: resolved };
    } catch (error) {
      return { installed: false, working: false, error: error.message };
    }
  }

  async initializeAtStartup() {
    for (const dir of this.getManagedModelDirs()) {
      try {
        await cleanupStaleDownloads(dir);
      } catch (error) {
        debugLogger.warn("SenseVoice initialization warning", {
          dir,
          error: error.message,
        });
      }
    }
  }

  async checkModelStatus(modelPathOrName = "") {
    const input = String(modelPathOrName || "").trim();
    if (!input) {
      return { success: true, modelPath: "", downloaded: false, runtimeKind: "sensevoice" };
    }

    if (getValidSenseVoiceModelNames().includes(input)) {
      const config = getSenseVoiceModelConfig(input);
      const resolvedPath = this.getModelPath(input);
      const requiredFiles = this.getRequiredFiles(input);
      const allPresent = requiredFiles.every((fileInfo) => fileExists(fileInfo.path));
      if (!allPresent) {
        return {
          success: true,
          model: input,
          modelPath: resolvedPath,
          downloaded: false,
          runtimeKind: config.runtimeKind || "sensevoice",
        };
      }

      try {
        const totalBytes = requiredFiles.reduce((sum, fileInfo) => {
          try {
            const stats = fs.statSync(fileInfo.path);
            return stats.isFile() ? sum + stats.size : sum;
          } catch {
            return sum;
          }
        }, 0);
        return {
          success: true,
          model: input,
          modelPath: resolvedPath,
          downloaded: totalBytes > 0,
          size_mb: Math.round(totalBytes / (1024 * 1024)),
          runtimeKind: config.runtimeKind || "sensevoice",
        };
      } catch {
        return {
          success: true,
          model: input,
          modelPath: resolvedPath,
          downloaded: false,
          runtimeKind: config.runtimeKind || "sensevoice",
        };
      }
    }

    if (!fileExists(input)) {
      return { success: true, modelPath: input, downloaded: false, runtimeKind: "sensevoice" };
    }

    try {
      if (fs.statSync(input).isDirectory()) {
        return { success: true, modelPath: input, downloaded: false, runtimeKind: "sensevoice" };
      }

      const fileName = path.basename(input).toLowerCase();
      if (fileName === "model.pth.tar") {
        return { success: true, modelPath: input, downloaded: false, runtimeKind: "sensevoice" };
      }
      const stats = fs.statSync(input);
      return {
        success: true,
        modelPath: input,
        downloaded: stats.isFile() && fileName !== "config.json",
        size_mb: Math.round(stats.size / (1024 * 1024)),
        runtimeKind: "sensevoice",
      };
    } catch {
      return { success: true, modelPath: input, downloaded: false, runtimeKind: "sensevoice" };
    }
  }

  async listSenseVoiceModels() {
    const models = getValidSenseVoiceModelNames();
    const modelInfo = [];

    for (const model of models) {
      const status = await this.checkModelStatus(model);
      modelInfo.push({
        ...status,
        model,
      });
    }

    return {
      models: modelInfo,
      cache_dir: this.getModelsDir(),
      success: true,
    };
  }

  async downloadSenseVoiceModel(modelName, progressCallback = null) {
    this.validateModelName(modelName);
    const modelConfig = getSenseVoiceModelConfig(modelName);
    const modelPath = this.getModelPath(modelName);
    const modelsDir = this.getModelsDir(modelName);
    const requiredFiles = this.getRequiredFiles(modelName);

    await fsPromises.mkdir(modelsDir, { recursive: true });

    if (requiredFiles.every((fileInfo) => fs.existsSync(fileInfo.path))) {
      const totalBytes = (
        await Promise.all(
          requiredFiles.map(async (fileInfo) => {
            const stats = await fsPromises.stat(fileInfo.path);
            return stats.isFile() ? stats.size : 0;
          })
        )
      ).reduce((sum, value) => sum + value, 0);

      return {
        model: modelName,
        downloaded: true,
        path: modelPath,
        size_bytes: totalBytes,
        size_mb: Math.round(totalBytes / (1024 * 1024)),
        runtimeKind: modelConfig.runtimeKind || "sensevoice",
        success: true,
      };
    }

    const totalExpectedBytes = requiredFiles.reduce(
      (sum, fileInfo) => sum + (fileInfo.expectedSizeBytes || 0),
      0
    );
    const spaceCheck = await checkDiskSpace(modelsDir, totalExpectedBytes * 1.2 || modelConfig.size * 1.2);
    if (!spaceCheck.ok) {
      throw new Error(
        `Not enough disk space to download model. Need ~${Math.round(((totalExpectedBytes || modelConfig.size) * 1.2) / 1_000_000)}MB, ` +
          `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
      );
    }

    const { signal, abort } = createDownloadSignal();
    this.currentDownloadProcess = { abort };

    try {
      let completedBytes = 0;

      for (const fileInfo of requiredFiles) {
        if (fs.existsSync(fileInfo.path)) {
          const stats = await fsPromises.stat(fileInfo.path);
          const expected = fileInfo.expectedSizeBytes || stats.size;
          completedBytes += expected;
          continue;
        }

        await downloadFile(fileInfo.url, fileInfo.path, {
          timeout: 600000,
          signal,
          expectedSize: fileInfo.expectedSizeBytes || 0,
          onProgress: (downloadedBytes) => {
            if (!progressCallback) return;
            const downloadedTotal = completedBytes + downloadedBytes;
            const totalBytes = totalExpectedBytes || 0;
            progressCallback({
              type: "progress",
              model: modelName,
              downloaded_bytes: downloadedTotal,
              total_bytes: totalBytes,
              percentage: totalBytes > 0 ? Math.min(100, Math.round((downloadedTotal / totalBytes) * 100)) : 0,
            });
          },
        });

        if (fileInfo.expectedSizeBytes > 0) {
          await validateFileSize(fileInfo.path, fileInfo.expectedSizeBytes);
          completedBytes += fileInfo.expectedSizeBytes;
        } else {
          const stats = await fsPromises.stat(fileInfo.path);
          completedBytes += stats.size;
        }
      }

      const totalBytes = (
        await Promise.all(
          requiredFiles.map(async (fileInfo) => {
            const stats = await fsPromises.stat(fileInfo.path);
            return stats.isFile() ? stats.size : 0;
          })
        )
      ).reduce((sum, value) => sum + value, 0);

      if (progressCallback) {
        progressCallback({ type: "complete", model: modelName, percentage: 100 });
      }

      return {
        model: modelName,
        downloaded: true,
        path: modelPath,
        size_bytes: totalBytes,
        size_mb: Math.round(totalBytes / (1024 * 1024)),
        runtimeKind: modelConfig.runtimeKind || "sensevoice",
        success: true,
      };
    } catch (error) {
      if (error.isAbort) {
        throw new Error("Download interrupted by user");
      }
      throw error;
    } finally {
      this.currentDownloadProcess = null;
    }
  }

  async cancelDownload() {
    if (this.currentDownloadProcess) {
      this.currentDownloadProcess.abort();
      this.currentDownloadProcess = null;
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async deleteSenseVoiceModel(modelName) {
    const requiredFiles = this.getRequiredFiles(modelName);
    const primaryFile = requiredFiles[0];

    if (primaryFile && fs.existsSync(primaryFile.path)) {
      let totalFreed = 0;
      for (const fileInfo of requiredFiles) {
        if (!fs.existsSync(fileInfo.path)) continue;
        const stats = await fsPromises.stat(fileInfo.path);
        if (stats.isFile()) {
          await fsPromises.unlink(fileInfo.path);
          totalFreed += stats.size;
        }
      }
      return {
        model: modelName,
        deleted: true,
        freed_bytes: totalFreed,
        freed_mb: Math.round(totalFreed / (1024 * 1024)),
        success: true,
      };
    }

    return { model: modelName, deleted: false, error: "Model not found", success: false };
  }

  async deleteAllSenseVoiceModels() {
    let totalFreed = 0;
    let deletedCount = 0;

    try {
      for (const modelName of getValidSenseVoiceModelNames()) {
        const requiredFiles = this.getRequiredFiles(modelName);
        let modelDeleted = false;
        for (const fileInfo of requiredFiles) {
          if (!fs.existsSync(fileInfo.path)) continue;
          try {
            const stats = await fsPromises.stat(fileInfo.path);
            await fsPromises.unlink(fileInfo.path);
            totalFreed += stats.size;
            modelDeleted = true;
          } catch {
            // Continue with other files if one fails
          }
        }
        if (modelDeleted) deletedCount++;
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

  async transcribeLocalSenseVoice(audioBlob, options = {}) {
    const modelTarget = this._resolveModelTarget(options.modelPath);
    const language = normalizeLanguage(options.language);
    const threads = Number.isFinite(Number(options.threads))
      ? Math.max(1, Math.floor(Number(options.threads)))
      : null;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;

    const modelPath = modelTarget.modelPath;
    const binaryPath = this._resolveBinaryPath(options.binaryPath);

    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const inputPath = path.join(tempDir, `sensevoice-input-${timestamp}.webm`);
    const wavPath = path.join(tempDir, `sensevoice-input-${timestamp}.wav`);

    const cleanup = () => {
      for (const filePath of [inputPath, wavPath]) {
        try {
          if (fileExists(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (err) {
          debugLogger.warn("Failed to cleanup SenseVoice temp file", {
            path: filePath,
            error: err.message,
          });
        }
      }
    };

    try {
      const audioBuffer = toAudioBuffer(audioBlob);
      if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error("Audio buffer is empty - no audio data received");
      }

      fs.writeFileSync(inputPath, audioBuffer);
      await convertToWav(inputPath, wavPath, { sampleRate: 16000, channels: 1 });

      const args = ["-m", modelPath, "-l", language, "-itn"];
      if (threads) {
        args.push("-t", String(threads));
      }
      if (options.noGpu === true) {
        args.push("-ng");
      }
      args.push(wavPath);

      debugLogger.debug("Starting SenseVoice CLI", {
        binaryPath,
        args,
        modelPath,
        language,
      });

      const spawnEnv = { ...process.env };
      const pathSeparator = process.platform === "win32" ? ";" : ":";
      const binaryDir = path.dirname(binaryPath);
      const candidateLibDir = path.resolve(binaryDir, "..", "lib");
      if (fileExists(candidateLibDir)) {
        if (process.platform === "darwin") {
          const current = spawnEnv.DYLD_LIBRARY_PATH || "";
          spawnEnv.DYLD_LIBRARY_PATH = current
            ? `${candidateLibDir}${pathSeparator}${current}`
            : candidateLibDir;
        } else if (process.platform === "linux") {
          const current = spawnEnv.LD_LIBRARY_PATH || "";
          spawnEnv.LD_LIBRARY_PATH = current
            ? `${candidateLibDir}${pathSeparator}${current}`
            : candidateLibDir;
        } else if (process.platform === "win32") {
          const current = spawnEnv.PATH || "";
          spawnEnv.PATH = `${candidateLibDir}${pathSeparator}${current}`;
        }
      }

      const { stdout, stderr, code } = await new Promise((resolve, reject) => {
        const proc = spawn(binaryPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: spawnEnv,
          cwd: path.dirname(binaryPath),
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          killProcess(proc, "SIGTERM");
          setTimeout(() => killProcess(proc, "SIGKILL"), 3000);
          reject(new Error(`SenseVoice timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });

        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        proc.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to run sense-voice-main: ${error.message}`));
        });

        proc.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({ stdout, stderr, code });
        });
      });

      const mergedOutput = `${stdout || ""}\n${stderr || ""}`.trim();
      if (code !== 0) {
        throw new Error(
          `SenseVoice process failed (code ${code}): ${sanitizeErrorSnippet(stderr || stdout)}`
        );
      }

      const text = this._extractText(mergedOutput);

      const fatalHints = /(dyld|no such file|library not loaded|segmentation fault|abort trap)/i;
      if (!text && fatalHints.test(mergedOutput)) {
        throw new Error(`SenseVoice failed: ${sanitizeErrorSnippet(mergedOutput)}`);
      }

      if (!text) {
        return { success: false, message: "No audio detected" };
      }

      return { success: true, text };
    } finally {
      cleanup();
    }
  }
}

module.exports = SenseVoiceManager;
