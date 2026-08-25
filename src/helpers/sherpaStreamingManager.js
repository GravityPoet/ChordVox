/**
 * SherpaStreamingManager — Local streaming ASR engine using sherpa-onnx-node
 *
 * Manages the lifecycle of OnlineRecognizer + OnlineStream for real-time
 * speech-to-text inside the isolated local streaming worker.
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
const debugLogger = require("./debugLogger");
const {
  downloadFile,
  createDownloadSignal,
  cleanupStaleDownloads,
  checkDiskSpace,
  validateFileSize,
  validateFileSha256,
} = require("./downloadUtils");
const { convertToWav, wavToFloat32Samples } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { runSystemTarExtractSafe } = require("./archiveSecurity");
const {
  STREAMING_MODELS,
  DEFAULT_STREAMING_MODEL_ID,
  resolveStreamingModelId,
} = require("../config/streamingModels");
const { resolveModelsDirForService } = require("./modelDirUtils");
const { applyLightPunctuation, shouldInsertSpace } = require("./asrPunctuation");
const { addMlPunctuation } = require("./punctuationModel");

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
  return resolveModelsDirForService("streaming", customDir);
}

function getStreamingModelConfigByExactId(modelId) {
  const exactModelId = String(modelId || "").trim();
  return STREAMING_MODELS.find((model) => model.id === exactModelId) || null;
}

function getStreamingModelConfig(modelId) {
  const resolvedModelId = resolveStreamingModelId(modelId);
  return STREAMING_MODELS.find((model) => model.id === resolvedModelId) || null;
}

function getRequiredFilesForModel(model) {
  if (model.modelType === "paraformer" || model.modelType === "transducer") {
    return [
      model.encoderFileName || "encoder.int8.onnx",
      model.decoderFileName || "decoder.int8.onnx",
      ...(model.modelType === "transducer" ? [model.joinerFileName || "joiner.int8.onnx"] : []),
      "tokens.txt",
    ];
  }
  return [model.modelFileName || "model.int8.onnx", "tokens.txt"];
}

function getModelFileSpecs(model) {
  return Array.isArray(model.files) ? model.files.filter((file) => file?.path && file?.url) : [];
}

function normalizeProtocol(url = "") {
  try {
    return new URL(String(url)).protocol;
  } catch {
    return "";
  }
}

function assertDownloadSourceAllowed(source, sha256 = "") {
  const normalizedSha256 = normalizeSha256(sha256);
  const protocol = normalizeProtocol(source?.url || "");
  const kind = String(source?.kind || inferSourceKind(source?.url || ""))
    .trim()
    .toLowerCase();
  const official =
    kind === "official" || kind === "github" || kind === "huggingface" || kind === "hf";

  if ((protocol !== "https:" || !official) && !normalizedSha256) {
    const error = new Error("Untrusted streaming model downloads require a sha256 checksum.");
    error.code = "ERR_DOWNLOAD_CHECKSUM_REQUIRED";
    throw error;
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

  if (audioBlob?.type === "Buffer" && Array.isArray(audioBlob.data)) {
    return Buffer.from(audioBlob.data);
  }

  if (audioBlob && audioBlob.buffer && typeof audioBlob.byteLength === "number") {
    return Buffer.from(audioBlob.buffer, audioBlob.byteOffset || 0, audioBlob.byteLength);
  }

  throw new Error(`Unsupported audio data type: ${typeof audioBlob}`);
}

function bytesToInt16Pcm(bytes) {
  const byteLength = bytes.byteLength - (bytes.byteLength % 2);
  if (byteLength <= 0) {
    return new Int16Array(0);
  }

  const view = byteLength === bytes.byteLength ? bytes : bytes.subarray(0, byteLength);
  if (view.byteOffset % Int16Array.BYTES_PER_ELEMENT === 0) {
    return new Int16Array(view.buffer, view.byteOffset, byteLength / Int16Array.BYTES_PER_ELEMENT);
  }

  return new Int16Array(view.buffer.slice(view.byteOffset, view.byteOffset + byteLength));
}

function toPcmInt16Array(audioChunk) {
  if (!audioChunk) {
    return new Int16Array(0);
  }

  if (audioChunk instanceof Int16Array) {
    return audioChunk;
  }

  if (audioChunk instanceof ArrayBuffer) {
    return bytesToInt16Pcm(new Uint8Array(audioChunk));
  }

  if (Buffer.isBuffer(audioChunk) || ArrayBuffer.isView(audioChunk)) {
    return bytesToInt16Pcm(
      new Uint8Array(audioChunk.buffer, audioChunk.byteOffset, audioChunk.byteLength)
    );
  }

  if (audioChunk?.type === "Buffer" && Array.isArray(audioChunk.data)) {
    return bytesToInt16Pcm(Buffer.from(audioChunk.data));
  }

  if (Array.isArray(audioChunk)) {
    return Int16Array.from(audioChunk);
  }

  throw new Error(`Unsupported PCM chunk type: ${typeof audioChunk}`);
}

function getInputExtension(sourceFileName = "", mimeType = "") {
  const normalizedFileName = String(sourceFileName || "").trim();
  const explicitExt = normalizedFileName ? path.extname(normalizedFileName) : "";
  if (explicitExt) {
    return explicitExt;
  }

  switch (
    String(mimeType || "")
      .trim()
      .toLowerCase()
  ) {
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
const VAD_MODEL_SPEC = {
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.int8.onnx",
  mirrorPath: VAD_MODEL_FILE,
  sizeBytes: 212860,
  sha256: "c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20",
};
const MODEL_MIRROR_BASE_ENV_GROUPS = [
  {
    kind: "cdn",
    keys: [
      "CHORDVOX_MODEL_CDN_BASE_URLS",
      "CHORDVOX_MODEL_CDN_BASE_URL",
      "CHORDVOX_MODEL_CN_CDN_BASE_URLS",
      "CHORDVOX_MODEL_CN_CDN_BASE_URL",
      "VITE_CHORDVOX_MODEL_CDN_BASE_URLS",
      "VITE_CHORDVOX_MODEL_CDN_BASE_URL",
      "VITE_CHORDVOX_MODEL_CN_CDN_BASE_URLS",
      "VITE_CHORDVOX_MODEL_CN_CDN_BASE_URL",
    ],
  },
  {
    kind: "r2",
    keys: [
      "CHORDVOX_MODEL_R2_BASE_URLS",
      "CHORDVOX_MODEL_R2_BASE_URL",
      "VITE_CHORDVOX_MODEL_R2_BASE_URLS",
      "VITE_CHORDVOX_MODEL_R2_BASE_URL",
    ],
  },
  {
    kind: "cos",
    keys: [
      "CHORDVOX_MODEL_COS_BASE_URLS",
      "CHORDVOX_MODEL_COS_BASE_URL",
      "VITE_CHORDVOX_MODEL_COS_BASE_URLS",
      "VITE_CHORDVOX_MODEL_COS_BASE_URL",
    ],
  },
  {
    kind: "oss",
    keys: [
      "CHORDVOX_MODEL_OSS_BASE_URLS",
      "CHORDVOX_MODEL_OSS_BASE_URL",
      "VITE_CHORDVOX_MODEL_OSS_BASE_URLS",
      "VITE_CHORDVOX_MODEL_OSS_BASE_URL",
    ],
  },
  {
    kind: "mirror",
    keys: [
      "CHORDVOX_MODEL_MIRROR_BASE_URLS",
      "CHORDVOX_MODEL_MIRROR_BASE_URL",
      "VITE_CHORDVOX_MODEL_MIRROR_BASE_URLS",
      "VITE_CHORDVOX_MODEL_MIRROR_BASE_URL",
    ],
  },
];
const SOURCE_CONNECT_TIMEOUT_MS = 10000;
const VAD_MIN_SILENCE_DURATION = 3.0;
const VAD_MIN_SPEECH_DURATION = 0.25;
const VAD_BUFFER_SIZE_SECONDS = 30;

function normalizeSha256(value = "") {
  return String(value || "")
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
}

function getDownloadLocale(options = {}) {
  return String(
    options.uiLanguage || options.locale || process.env.UI_LANGUAGE || process.env.LANG || ""
  ).toLowerCase();
}

function isChineseLocale(options = {}) {
  const locale = getDownloadLocale(options);
  return locale.startsWith("zh") || locale.includes("zh_cn") || locale.includes("zh-cn");
}

function normalizeMirrorBaseUrl(value = "") {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function parseMirrorBaseSources() {
  const sources = [];
  const seen = new Set();

  for (const group of MODEL_MIRROR_BASE_ENV_GROUPS) {
    for (const key of group.keys) {
      const raw = process.env[key];
      if (!raw) continue;

      for (const value of String(raw).split(/[,\n]/)) {
        const baseUrl = normalizeMirrorBaseUrl(value);
        if (!baseUrl || seen.has(baseUrl)) continue;
        seen.add(baseUrl);
        sources.push({ baseUrl, kind: group.kind });
      }
    }
  }

  return sources;
}

function joinUrlPath(baseUrl, relativePath) {
  const base = normalizeMirrorBaseUrl(baseUrl);
  const pathPart = String(relativePath || "").replace(/^\/+/, "");
  return `${base}/${pathPart}`;
}

function inferSourceKind(url = "", fallback = "mirror") {
  const normalized = String(url || "").toLowerCase();
  if (normalized.includes("github.com/")) return "official";
  if (normalized.includes("huggingface.co/")) return "huggingface";
  if (normalized.includes("r2.cloudflarestorage.com")) return "r2";
  if (normalized.includes("myqcloud.com") || normalized.includes(".cos.")) return "cos";
  if (normalized.includes("aliyuncs.com") || normalized.includes(".oss-")) return "oss";
  if (normalized.includes("cdn")) return "cdn";
  return fallback;
}

function isOfficialSource(source) {
  const kind = String(source?.kind || inferSourceKind(source?.url || ""))
    .trim()
    .toLowerCase();
  return kind === "official" || kind === "github" || kind === "huggingface" || kind === "hf";
}

function normalizeSource(input, fallbackKind = "mirror") {
  if (!input) return null;
  if (typeof input === "string") {
    return { url: input, kind: inferSourceKind(input, fallbackKind) };
  }

  const url = String(input.url || "").trim();
  if (!url) return null;
  return {
    url,
    kind: input.kind || input.type || inferSourceKind(url, fallbackKind),
    label: input.label || input.name || "",
  };
}

function sourcePriority(kind, options = {}) {
  const normalized = String(kind || "mirror").toLowerCase();
  const official = normalized === "official" || normalized === "github";
  const huggingface = normalized === "huggingface" || normalized === "hf";
  const cdn =
    normalized === "cdn" ||
    normalized === "cn-cdn" ||
    normalized === "domestic-cdn" ||
    normalized === "china-cdn";
  const objectStorage =
    normalized === "r2" ||
    normalized === "cloudflare-r2" ||
    normalized === "cos" ||
    normalized === "tencent-cos" ||
    normalized === "oss" ||
    normalized === "aliyun-oss" ||
    normalized === "object-storage";

  if (isChineseLocale(options)) {
    if (cdn) return 0;
    if (objectStorage || (!official && !huggingface)) return 1;
    if (official) return 2;
    return 3;
  }

  if (official) return 0;
  if (huggingface) return 1;
  return 2;
}

function shouldUseAsPreferredArchiveSource(source, options = {}) {
  if (isChineseLocale(options)) {
    return sourcePriority(source.kind, options) < sourcePriority("official", options);
  }

  return sourcePriority(source.kind, options) === 0;
}

function isHuggingFaceSource(source) {
  const kind = String(source?.kind || inferSourceKind(source?.url || ""))
    .trim()
    .toLowerCase();
  return kind === "huggingface" || kind === "hf";
}

function buildDownloadSources(
  { primaryUrl, mirrors = [], mirrorPath = "", includeHuggingFace = true },
  options = {}
) {
  const sources = [];

  for (const { baseUrl, kind } of parseMirrorBaseSources()) {
    if (mirrorPath) {
      sources.push({ url: joinUrlPath(baseUrl, mirrorPath), kind, label: kind });
    }
  }

  for (const mirror of mirrors) {
    const source = normalizeSource(mirror, "mirror");
    if (source) sources.push(source);
  }

  const primary = normalizeSource(primaryUrl, "official");
  if (primary) sources.push(primary);

  const seen = new Set();
  const hasOfficialSource = sources.some(
    (source) =>
      String(source.kind || "")
        .trim()
        .toLowerCase() === "official" ||
      String(source.kind || "")
        .trim()
        .toLowerCase() === "github"
  );
  return sources
    .filter((source) => {
      if (!includeHuggingFace && isHuggingFaceSource(source)) return false;
      if (isChineseLocale(options) && hasOfficialSource && isHuggingFaceSource(source)) {
        return false;
      }
      if (seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    })
    .sort((a, b) => sourcePriority(a.kind, options) - sourcePriority(b.kind, options));
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

  async validateDownloadedArtifact(
    filePath,
    { expectedSize = 0, sha256 = "", strictSize = false }
  ) {
    const normalizedSha256 = normalizeSha256(sha256);
    if (strictSize && expectedSize > 0) {
      await validateFileSize(filePath, expectedSize, 0);
    } else if (expectedSize > 0) {
      await validateFileSize(filePath, expectedSize, normalizedSha256 ? 0 : 35);
    }

    if (normalizedSha256) {
      await validateFileSha256(filePath, normalizedSha256);
    }
  }

  async downloadArtifactFromSources({
    artifactLabel,
    modelId,
    destination,
    sources,
    expectedSize = 0,
    sha256 = "",
    strictSize = false,
    progressCallback = null,
    signal = null,
    completedBytes = 0,
    totalBytes = 0,
  }) {
    const availableSources = Array.isArray(sources) ? sources.filter((source) => source?.url) : [];
    if (!availableSources.length) {
      const error = new Error("No download source is configured for this model.");
      error.code = "NO_DOWNLOAD_SOURCE";
      throw error;
    }

    let lastError = null;
    const resolvedTotalBytes = totalBytes || expectedSize || 0;
    const attemptedSources = availableSources.map((source) => ({
      url: source.url,
      kind: source.kind || "unknown",
    }));

    for (let index = 0; index < availableSources.length; index++) {
      const source = availableSources[index];
      const hasNextSource = index < availableSources.length - 1;
      progressCallback?.({
        type: index === 0 ? "source-connect" : "source-switch",
        model: modelId,
        source_index: index + 1,
        source_count: availableSources.length,
        source_kind: source.kind || "mirror",
        percentage:
          resolvedTotalBytes > 0 ? Math.round((completedBytes / resolvedTotalBytes) * 100) : 0,
      });

      try {
        assertDownloadSourceAllowed(source, sha256);
        await downloadFile(source.url, destination, {
          timeout: SOURCE_CONNECT_TIMEOUT_MS,
          maxRetries: 0,
          signal,
          expectedSize,
          strictSize: strictSize || Boolean(expectedSize && sha256),
          sha256,
          onVerifying: () => {
            progressCallback?.({
              type: "verifying",
              model: modelId,
              source_index: index + 1,
              source_count: availableSources.length,
              percentage:
                resolvedTotalBytes > 0
                  ? Math.round((completedBytes / resolvedTotalBytes) * 100)
                  : 0,
            });
          },
          onProgress: (downloadedBytes, sourceTotalBytes) => {
            const effectiveTotal = resolvedTotalBytes || sourceTotalBytes || 0;
            const effectiveDownloaded = completedBytes + downloadedBytes;
            progressCallback?.({
              type: "progress",
              model: modelId,
              downloaded_bytes: effectiveDownloaded,
              total_bytes: effectiveTotal,
              percentage:
                effectiveTotal > 0
                  ? Math.min(99, Math.round((effectiveDownloaded / effectiveTotal) * 100))
                  : 0,
            });
          },
        });

        debugLogger.info(
          "Streaming model artifact downloaded",
          { modelId, artifactLabel, sourceKind: source.kind || "unknown" },
          "sherpa-streaming"
        );
        return source;
      } catch (error) {
        lastError = error;
        if (error?.isAbort || signal?.aborted) {
          throw error;
        }

        debugLogger.warn(
          hasNextSource
            ? "Streaming model download source failed; trying next source"
            : "Streaming model download source failed; no more sources",
          {
            modelId,
            artifactLabel,
            sourceIndex: index + 1,
            sourceCount: availableSources.length,
            sourceKind: source.kind || "unknown",
            code: error.code,
            statusCode: error.statusCode,
            error: error.message,
          },
          "sherpa-streaming"
        );
      }
    }

    const error = new Error(
      "Download nodes are temporarily unavailable. Please try again later or import the model package manually."
    );
    error.code = "DOWNLOAD_SOURCES_EXHAUSTED";
    error.cause = lastError;
    error.sources = attemptedSources;
    error.manualDownloadUrl =
      availableSources.find((source) => isOfficialSource(source))?.url || availableSources[0]?.url;
    throw error;
  }

  async ensureVadModelAvailable(customDir = "", options = {}) {
    const vadModelPath = this.getVadModelPath(customDir);
    if (fs.existsSync(vadModelPath)) {
      try {
        await this.validateDownloadedArtifact(vadModelPath, {
          expectedSize: VAD_MODEL_SPEC.sizeBytes,
          sha256: VAD_MODEL_SPEC.sha256,
          strictSize: true,
        });
        return vadModelPath;
      } catch {
        await fsPromises.unlink(vadModelPath).catch(() => {});
      }
    }

    if (this.vadModelDownloadPromise) {
      return this.vadModelDownloadPromise;
    }

    this.vadModelDownloadPromise = (async () => {
      const vadDir = this.getVadDir(customDir);
      await fsPromises.mkdir(vadDir, { recursive: true });
      await this.downloadArtifactFromSources({
        artifactLabel: VAD_MODEL_FILE,
        modelId: "_vad",
        destination: vadModelPath,
        sources: buildDownloadSources(
          {
            primaryUrl: VAD_MODEL_SPEC.url,
            mirrors: VAD_MODEL_SPEC.mirrors,
            mirrorPath: VAD_MODEL_SPEC.mirrorPath,
          },
          options
        ),
        expectedSize: VAD_MODEL_SPEC.sizeBytes,
        sha256: VAD_MODEL_SPEC.sha256,
        strictSize: true,
        signal: options.signal || null,
      });
      return vadModelPath;
    })();

    try {
      return await this.vadModelDownloadPromise;
    } finally {
      this.vadModelDownloadPromise = null;
    }
  }

  async initializeVad(customDir = "", options = {}) {
    if (this.vad) {
      this.resetVadState();
      return true;
    }

    const sherpa = getSherpaOnnx();
    const vadModelPath = await this.ensureVadModelAvailable(customDir, options);
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
    const normalizedModelId = resolveStreamingModelId(modelId);
    const model = getStreamingModelConfig(normalizedModelId);
    if (!model) return false;
    const modelDir = this.getModelDir(normalizedModelId, customDir);
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
        model: path.join(modelDir, model.modelFileName || "model.int8.onnx"),
      };
    } else if (model.modelType === "paraformer") {
      config.modelConfig.paraformer = {
        encoder: path.join(modelDir, model.encoderFileName || "encoder.int8.onnx"),
        decoder: path.join(modelDir, model.decoderFileName || "decoder.int8.onnx"),
      };
    } else if (model.modelType === "transducer") {
      config.modelConfig.transducer = {
        encoder: path.join(modelDir, model.encoderFileName || "encoder.int8.onnx"),
        decoder: path.join(modelDir, model.decoderFileName || "decoder.int8.onnx"),
        joiner: path.join(modelDir, model.joinerFileName || "joiner.int8.onnx"),
      };
    }

    return config;
  }

  /**
   * Load a model and create the OnlineRecognizer.
   * Reuses the existing recognizer if the same model is already loaded.
   */
  async loadModel(modelId, customDir = "") {
    const normalizedModelId = resolveStreamingModelId(modelId);
    const normalizedModelsDir = this.getModelsDir(customDir);

    // Reuse if same model
    if (
      this.recognizer &&
      this.currentModelId === normalizedModelId &&
      this.currentModelsDir === normalizedModelsDir
    ) {
      debugLogger.debug(
        "Reusing existing recognizer",
        { modelId: normalizedModelId, requestedModelId: modelId, modelsDir: normalizedModelsDir },
        "sherpa-streaming"
      );
      return true;
    }

    // Clean up old recognizer
    this._releaseRecognizer();

    const model = getStreamingModelConfig(normalizedModelId);
    if (!model) {
      throw new Error(`Unknown streaming model: ${modelId}`);
    }

    const modelDir = this.getModelDir(normalizedModelId, customDir);
    if (!this.isModelDirectoryValid(modelDir, model)) {
      throw new Error(
        `Model not downloaded: ${model.name}. Please download it first from Settings.`
      );
    }

    const sherpa = getSherpaOnnx();
    const config = this._buildConfig(model, modelDir);

    debugLogger.debug(
      "Creating OnlineRecognizer",
      { modelId: normalizedModelId, requestedModelId: modelId, modelDir },
      "sherpa-streaming"
    );
    const t0 = Date.now();

    try {
      this.recognizer = new sherpa.OnlineRecognizer(config);
      this.currentModelId = normalizedModelId;
      this.currentModelsDir = normalizedModelsDir;
      debugLogger.info(
        "OnlineRecognizer created",
        { modelId: normalizedModelId, loadTimeMs: Date.now() - t0, modelsDir: normalizedModelsDir },
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

    const modelId = resolveStreamingModelId(options.modelId || DEFAULT_STREAMING_MODEL_ID);
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

  async transcribeFilePath(filePath, options = {}) {
    if (this.isActive) {
      throw new Error("Local streaming is busy with a live session. Please stop dictation first.");
    }

    const modelId = resolveStreamingModelId(options.modelId || DEFAULT_STREAMING_MODEL_ID);
    const modelsDir = options.modelsDir || "";
    const tempDir = getSafeTempDir();
    const tempSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const wavPath = path.join(tempDir, `sherpa-streaming-input-${tempSuffix}.wav`);
    const previousVad = this.vad;

    try {
      await convertToWav(filePath, wavPath, { sampleRate: 16000, channels: 1 });

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

      await fsPromises.unlink(wavPath).catch(() => {});
    }
  }

  async installArchiveModelFromSources({
    model,
    normalizedModelId,
    archivePath,
    customDir,
    sources,
    progressCallback,
    signal,
  }) {
    const archiveSize = Number(model.archiveSizeBytes || model.downloadSizeBytes || 0);

    await this.downloadArtifactFromSources({
      artifactLabel: path.basename(archivePath),
      modelId: normalizedModelId,
      destination: archivePath,
      sources,
      expectedSize: archiveSize,
      sha256: model.sha256,
      strictSize: Boolean(archiveSize && model.sha256),
      progressCallback,
      signal,
      totalBytes: archiveSize,
    });

    progressCallback?.({
      type: "installing",
      model: normalizedModelId,
      percentage: 100,
    });

    await this.extractModelArchive(archivePath, model, customDir, signal);
    await fsPromises.unlink(archivePath).catch(() => {});
  }

  async downloadModel(modelId, progressCallback = null, customDir = "", options = {}) {
    const normalizedModelId = resolveStreamingModelId(modelId);
    const model = getStreamingModelConfig(normalizedModelId);
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
    const targetDir = this.getModelDir(normalizedModelId, customDir);
    const scopedProgressCallback = progressCallback
      ? (progressData) => {
          progressCallback({
            ...progressData,
            modelsDir,
          });
        }
      : null;

    if (this.isModelDirectoryValid(targetDir, model)) {
      return { success: true, model: normalizedModelId, downloaded: true, path: targetDir };
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

    const { signal, abort } = createDownloadSignal();
    this.currentDownload = { modelId: normalizedModelId, abort };

    try {
      const hasArchiveSource = Boolean(model.downloadUrl);
      const hasFileSources = getModelFileSpecs(model).length > 0;
      let lastDownloadError = null;

      if (hasArchiveSource) {
        const archivePath = this.getArchivePath(normalizedModelId, customDir);
        const archiveSize = Number(model.archiveSizeBytes || model.downloadSizeBytes || 0);
        const archiveSources = buildDownloadSources(
          {
            primaryUrl: model.downloadUrl,
            mirrors: model.mirrors,
            mirrorPath:
              model.mirrorPath || model.archiveMirrorPath || path.basename(model.downloadUrl),
          },
          options
        );
        const firstArchiveSources = archiveSources.filter((source) =>
          shouldUseAsPreferredArchiveSource(source, options)
        );
        const deferredArchiveSources = archiveSources.filter(
          (source) => !shouldUseAsPreferredArchiveSource(source, options)
        );
        let archiveReady = false;
        try {
          await this.validateDownloadedArtifact(archivePath, {
            expectedSize: archiveSize,
            sha256: model.sha256,
            strictSize: Boolean(archiveSize && model.sha256),
          });
          archiveReady = true;
          debugLogger.info("Reusing streaming model archive from previous attempt", {
            modelId: normalizedModelId,
            archivePath,
          });
        } catch {
          archiveReady = false;
        }

        try {
          if (archiveReady) {
            scopedProgressCallback?.({
              type: "installing",
              model: normalizedModelId,
              percentage: 100,
            });

            await this.extractModelArchive(archivePath, model, customDir, signal);
            await fsPromises.unlink(archivePath).catch(() => {});
          } else if (firstArchiveSources.length > 0) {
            await this.installArchiveModelFromSources({
              model,
              normalizedModelId,
              archivePath,
              customDir,
              sources: firstArchiveSources,
              progressCallback: scopedProgressCallback,
              signal,
            });
          } else if (!hasFileSources && deferredArchiveSources.length > 0) {
            await this.installArchiveModelFromSources({
              model,
              normalizedModelId,
              archivePath,
              customDir,
              sources: deferredArchiveSources,
              progressCallback: scopedProgressCallback,
              signal,
            });
          } else {
            throw Object.assign(new Error("No preferred archive source is available."), {
              code: "NO_PREFERRED_ARCHIVE_SOURCE",
            });
          }

          scopedProgressCallback?.({
            type: "complete",
            model: normalizedModelId,
            percentage: 100,
          });

          return { success: true, model: normalizedModelId, downloaded: true, path: targetDir };
        } catch (error) {
          lastDownloadError = error;
          if (error?.isAbort) {
            throw error;
          }
          if (!hasFileSources) {
            throw error;
          }
          scopedProgressCallback?.({
            type: "source-switch",
            model: normalizedModelId,
            percentage: 0,
          });
          debugLogger.warn(
            "Archive download/install failed; falling back to per-file streaming model download",
            { modelId: normalizedModelId, code: error.code, error: error.message },
            "sherpa-streaming"
          );
        }
      }

      if (hasFileSources) {
        try {
          await this.downloadModelFiles(model, scopedProgressCallback, customDir, signal, options);
          scopedProgressCallback?.({
            type: "complete",
            model: normalizedModelId,
            percentage: 100,
          });
          return { success: true, model: normalizedModelId, downloaded: true, path: targetDir };
        } catch (error) {
          lastDownloadError = error;
          if (error?.isAbort || !hasArchiveSource) {
            throw error;
          }

          const archivePath = this.getArchivePath(normalizedModelId, customDir);
          const deferredArchiveSources = buildDownloadSources(
            {
              primaryUrl: model.downloadUrl,
              mirrors: model.mirrors,
              mirrorPath:
                model.mirrorPath || model.archiveMirrorPath || path.basename(model.downloadUrl),
            },
            options
          ).filter((source) => !shouldUseAsPreferredArchiveSource(source, options));

          if (!deferredArchiveSources.length) {
            throw error;
          }

          await this.installArchiveModelFromSources({
            model,
            normalizedModelId,
            archivePath,
            customDir,
            sources: deferredArchiveSources,
            progressCallback: scopedProgressCallback,
            signal,
          });

          scopedProgressCallback?.({
            type: "complete",
            model: normalizedModelId,
            percentage: 100,
          });
          return { success: true, model: normalizedModelId, downloaded: true, path: targetDir };
        }
      }

      throw (
        lastDownloadError ||
        Object.assign(new Error("No download source is configured."), {
          code: "NO_DOWNLOAD_SOURCE",
        })
      );
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

  async downloadModelFiles(
    model,
    progressCallback = null,
    customDir = "",
    signal = null,
    options = {}
  ) {
    const modelsDir = await this.ensureModelsDirExists(customDir);
    const tempDir = path.join(modelsDir, `temp-download-${model.id}`);
    const targetDir = this.getModelDir(model.id, customDir);
    const fileSpecs = getModelFileSpecs(model);
    const totalBytes =
      fileSpecs.reduce((sum, file) => sum + Math.max(0, Number(file.sizeBytes || 0)), 0) ||
      model.sizeBytes ||
      0;
    const includeHuggingFace = !(isChineseLocale(options) && Boolean(model.downloadUrl));
    let completedBytes = 0;

    await fsPromises.mkdir(tempDir, { recursive: true });

    for (const file of fileSpecs) {
      const filePath = String(file.path || "").replace(/^[/\\]+/, "");
      const destination = path.join(tempDir, filePath);
      await fsPromises.mkdir(path.dirname(destination), { recursive: true });

      const expectedSize = Math.max(0, Number(file.sizeBytes || 0));
      try {
        await this.validateDownloadedArtifact(destination, {
          expectedSize,
          sha256: file.sha256,
          strictSize: Boolean(expectedSize && file.sha256),
        });
        const existingStats = await fsPromises.stat(destination);
        completedBytes += expectedSize || existingStats.size;
        progressCallback?.({
          type: "progress",
          model: model.id,
          downloaded_bytes: completedBytes,
          total_bytes: totalBytes,
          percentage:
            totalBytes > 0 ? Math.min(99, Math.round((completedBytes / totalBytes) * 100)) : 0,
        });
        continue;
      } catch {
        // Missing or invalid files are downloaded below. Validators remove
        // files that are provably corrupt while resumable .tmp data remains.
      }

      await this.downloadArtifactFromSources({
        artifactLabel: filePath,
        modelId: model.id,
        destination,
        sources: buildDownloadSources(
          {
            primaryUrl: file.url,
            mirrors: file.mirrors,
            mirrorPath: file.mirrorPath || path.join(model.dirName, filePath),
            includeHuggingFace,
          },
          options
        ),
        expectedSize,
        sha256: file.sha256,
        strictSize: Boolean(expectedSize && file.sha256),
        signal,
        progressCallback,
        completedBytes,
        totalBytes,
      });

      if (expectedSize > 0) {
        await validateFileSize(destination, expectedSize, 0);
      }
      const stats = await fsPromises.stat(destination);
      completedBytes += expectedSize || stats.size;
    }

    progressCallback?.({
      type: "installing",
      model: model.id,
      percentage: 100,
    });

    if (!this.isModelDirectoryValid(tempDir, model)) {
      const error = new Error("Downloaded model is missing required files");
      error.code = "DOWNLOAD_INCOMPLETE";
      throw error;
    }

    await fsPromises.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    await fsPromises.rename(tempDir, targetDir);
  }

  async extractModelArchive(archivePath, model, customDir = "", signal = null) {
    const modelsDir = this.getModelsDir(customDir);
    const extractDir = path.join(modelsDir, `temp-extract-${model.id}`);
    const targetDir = this.getModelDir(model.id, customDir);

    try {
      await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      await fsPromises.mkdir(extractDir, { recursive: true });
      await this.runTarExtract(archivePath, extractDir, signal);

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

  runTarExtract(archivePath, extractDir, signal = null) {
    return runSystemTarExtractSafe(archivePath, extractDir, ["-xjf"], { signal });
  }

  cancelDownload() {
    if (!this.currentDownload) {
      return { success: false, error: "No active download to cancel" };
    }

    this.currentDownload.abort();
    return { success: true, message: "Download cancelled" };
  }

  async deleteModel(modelId, customDir = "") {
    const exactModel = getStreamingModelConfigByExactId(modelId);
    const normalizedModelId = exactModel ? exactModel.id : resolveStreamingModelId(modelId);
    const model = exactModel || getStreamingModelConfig(normalizedModelId);
    if (!model) {
      return { success: false, model: modelId, deleted: false, error: "Model not found" };
    }

    const modelDir = path.join(this.getModelsDir(customDir), model.dirName);
    const archivePath = path.join(this.getModelsDir(customDir), `${model.id}.tar.bz2`);

    try {
      if (
        this.currentModelId === normalizedModelId &&
        this.currentModelsDir === this.getModelsDir(customDir)
      ) {
        this.stopStream();
        this._releaseRecognizer();
      }

      await fsPromises.rm(modelDir, { recursive: true, force: true });
      await fsPromises.rm(archivePath, { force: true });
      if (fs.existsSync(modelDir) || fs.existsSync(archivePath)) {
        throw new Error("Model files still exist after deletion");
      }

      return { success: true, model: normalizedModelId, deleted: true, path: modelDir };
    } catch (error) {
      return {
        success: false,
        model: normalizedModelId,
        deleted: false,
        path: modelDir,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deleteAllModels(customDir = "") {
    const modelsDir = await this.ensureModelsDirExists(customDir);
    try {
      this.stopStream();
      this._releaseRecognizer();
      await fsPromises.rm(modelsDir, { recursive: true, force: true });
      await fsPromises.mkdir(modelsDir, { recursive: true });
      const remainingEntries = await fsPromises.readdir(modelsDir);
      if (remainingEntries.length > 0) {
        throw new Error("Some streaming model files could not be removed");
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Start a new streaming session.
   * Creates a fresh OnlineStream and resets text state.
   */
  async startStream(modelId, customDir = "", options = {}) {
    const normalizedModelId = resolveStreamingModelId(modelId);
    if (this.isActive) {
      debugLogger.warn("Stream already active, stopping first", {}, "sherpa-streaming");
      this.stopStream();
    }

    await this.loadModel(normalizedModelId, customDir);
    try {
      await this.initializeVad(customDir, options);
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

    debugLogger.debug(
      "Streaming session started",
      { modelId: normalizedModelId },
      "sherpa-streaming"
    );
    return true;
  }

  async warmupModel(modelId, customDir = "", options = {}) {
    const normalizedModelId = resolveStreamingModelId(modelId || DEFAULT_STREAMING_MODEL_ID);
    if (this.isActive) {
      return { success: false, alreadyActive: true, modelId: this.currentModelId };
    }

    const t0 = Date.now();
    await this.loadModel(normalizedModelId, customDir);
    try {
      await this.initializeVad(customDir, options);
    } catch (error) {
      this.vad = null;
      debugLogger.warn(
        "Streaming VAD unavailable during warmup; continuing without VAD",
        { error: error.message, modelsDir: this.getModelsDir(customDir) },
        "sherpa-streaming"
      );
    }

    debugLogger.info(
      "Streaming recognizer warmed up",
      {
        modelId: normalizedModelId,
        warmupMs: Date.now() - t0,
        hasRecognizer: !!this.recognizer,
        hasVad: !!this.vad,
      },
      "sherpa-streaming"
    );
    return {
      success: true,
      modelId: normalizedModelId,
      warmupMs: Date.now() - t0,
      hasRecognizer: !!this.recognizer,
      hasVad: !!this.vad,
    };
  }

  /**
   * Feed a PCM audio chunk (Int16 ArrayBuffer from AudioWorklet via IPC).
   *
   * This is the hot path — called ~every 50ms during recording.
   * Returns the display text (confirmed + partial) after decoding.
   */
  feedAudioChunk(audioBuffer) {
    if (!this.isActive || !this.stream || !this.recognizer) return null;

    let int16;
    try {
      int16 = toPcmInt16Array(audioBuffer);
    } catch (error) {
      debugLogger.warn(
        "Ignored invalid local streaming audio chunk",
        { error: error.message },
        "sherpa-streaming"
      );
      return null;
    }

    if (!int16.length) {
      return null;
    }

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
      this.onPartialTranscript?.(this._composeDisplayText(this.currentPartial));
    }

    return this._composeDisplayText(this.currentPartial);
  }

  _appendConfirmedSegment(text) {
    const punctuatedText = addMlPunctuation(text) ?? applyLightPunctuation(text);
    if (!punctuatedText) {
      return;
    }

    if (!this.confirmedText) {
      this.confirmedText = punctuatedText;
      return;
    }

    const needsSpace = shouldInsertSpace(this.confirmedText, punctuatedText);

    this.confirmedText += needsSpace ? ` ${punctuatedText}` : punctuatedText;
  }

  _composeDisplayText(partialText = "") {
    if (!partialText) {
      return this.confirmedText;
    }

    if (!this.confirmedText) {
      return partialText;
    }

    return shouldInsertSpace(this.confirmedText, partialText)
      ? `${this.confirmedText} ${partialText}`
      : this.confirmedText + partialText;
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

        // A completed VAD segment only means the user paused after speech.
        // Long-form dictation must keep recording through natural pauses and
        // stop only on explicit hotkey/user action or hard failure.
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
      return {
        text: this.confirmedText || "",
        observedSpeech: this.vadObservedSpeech,
        hadVad: !!this.vad,
      };
    }

    let finalText = this.confirmedText;
    const hadVad = !!this.vad;
    const observedSpeech = this.vadObservedSpeech;

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
          const punctuatedLastText = addMlPunctuation(lastText) ?? applyLightPunctuation(lastText);
          if (punctuatedLastText) {
            const needsSpace = shouldInsertSpace(finalText, punctuatedLastText);
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

    return { text: finalText, observedSpeech, hadVad };
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      isActive: this.isActive,
      currentModelId: this.currentModelId,
      currentDownloadModelId: this.currentDownload?.modelId || null,
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
