const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const { getSafeTempDir } = require("./safeTempDir");
const { convertToWav } = require("./ffmpegUtils");
const { killProcess } = require("../utils/process");

const DEFAULT_TIMEOUT_MS = 300000;

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

  _resolveModelPath(modelPath) {
    const resolved = String(modelPath || process.env.SENSEVOICE_MODEL_PATH || "").trim();
    if (!resolved) {
      throw new Error("SenseVoice model path is empty. Please select a local GGUF model file.");
    }
    if (!fileExists(resolved)) {
      throw new Error(`SenseVoice model file not found: ${resolved}`);
    }
    return resolved;
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

  async checkModelStatus(modelPath = "") {
    const resolvedPath = String(modelPath || "").trim();
    if (!resolvedPath) {
      return { success: true, modelPath: "", downloaded: false };
    }

    if (!fileExists(resolvedPath)) {
      return { success: true, modelPath: resolvedPath, downloaded: false };
    }

    try {
      const stats = fs.statSync(resolvedPath);
      return {
        success: true,
        modelPath: resolvedPath,
        downloaded: stats.isFile(),
        size_mb: Math.round(stats.size / (1024 * 1024)),
      };
    } catch {
      return { success: true, modelPath: resolvedPath, downloaded: false };
    }
  }

  async transcribeLocalSenseVoice(audioBlob, options = {}) {
    const modelPath = this._resolveModelPath(options.modelPath);
    const binaryPath = this._resolveBinaryPath(options.binaryPath);
    const language = normalizeLanguage(options.language);
    const threads = Number.isFinite(Number(options.threads))
      ? Math.max(1, Math.floor(Number(options.threads)))
      : null;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;

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
