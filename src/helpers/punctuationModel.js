/**
 * punctuationModel.js — CT-Transformer ML punctuation for local ASR output.
 *
 * Paraformer / streaming sherpa-onnx ASR emits UNPUNCTUATED text. When the
 * CT-Transformer model is installed, we restore real punctuation via the
 * sherpa-onnx-node OfflinePunctuation API. When it is absent or fails to load,
 * addMlPunctuation() returns null so callers fall back to the existing
 * asrPunctuation.js heuristic — there is no regression without the model.
 *
 * The model is zh-en, so we only route CJK-bearing text through it; pure-Latin
 * and other languages keep using the heuristic.
 */

const fs = require("fs");
const fsPromises = require("fs").promises;
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const { resolveInsideDirectory } = require("./pathSecurity");
const { runSystemTarExtractSafe } = require("./archiveSecurity");
const {
  buildDownloadSources,
  downloadArtifactFromSources,
  validateDownloadedArtifact,
} = require("./modelDownloadSources");
const { createDownloadSignal } = require("./downloadUtils");
const registryData = require("../models/modelRegistryData.json");

const SERVICE = "punctuation";
const DEFAULT_PUNCTUATION_MODEL = "ct-transformer-zh-en-int8";

// Same CJK range used by asrPunctuation.js — presence gate for the zh-en model.
const CJK_CHAR_REGEX = /[\u3400-\u9fff]/u;

let sherpaOnnx = null;
let sherpaLoadFailed = false;
let punctuator = null; // cached OfflinePunctuation instance
let punctuatorInitFailed = false;
let backgroundEnsurePromise = null;
let backgroundEnsureAbort = null;

function getPunctuationModelConfig(modelName = DEFAULT_PUNCTUATION_MODEL) {
  const models = registryData.punctuationModels || {};
  return models[modelName] || null;
}

function getModelDir(modelName = DEFAULT_PUNCTUATION_MODEL) {
  const config = getPunctuationModelConfig(modelName);
  if (!config) return null;
  const modelsDir = getModelsDirForService(SERVICE);
  return resolveInsideDirectory(modelsDir, config.extractDir, "Punctuation model directory");
}

function getModelFilePath(modelName = DEFAULT_PUNCTUATION_MODEL) {
  const config = getPunctuationModelConfig(modelName);
  const modelDir = getModelDir(modelName);
  if (!config || !modelDir) return null;
  // Prefer the declared file; fall back to common sherpa names so the int8/full
  // tarball layout does not need to be hardcoded at the call site.
  const candidates = [config.modelFileName, "model.int8.onnx", "model.onnx"].filter(Boolean);
  for (const name of candidates) {
    const candidate = resolveInsideDirectory(modelDir, name, "Punctuation model file");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isPunctuationModelAvailable(modelName = DEFAULT_PUNCTUATION_MODEL) {
  try {
    return Boolean(getModelFilePath(modelName));
  } catch {
    return false;
  }
}

function loadSherpa() {
  if (sherpaOnnx || sherpaLoadFailed) return sherpaOnnx;
  try {
    sherpaOnnx = require("sherpa-onnx-node");
  } catch (error) {
    sherpaLoadFailed = true;
    debugLogger.warn("sherpa-onnx-node unavailable; ML punctuation disabled", {
      error: error.message,
    });
  }
  return sherpaOnnx;
}

function loadPunctuator() {
  if (punctuator || punctuatorInitFailed) return punctuator;

  let modelPath = null;
  try {
    modelPath = getModelFilePath();
  } catch {
    modelPath = null;
  }
  if (!modelPath) return null; // not downloaded — silent; caller falls back to heuristic

  const sherpa = loadSherpa();
  if (!sherpa?.OfflinePunctuation) return null;

  try {
    punctuator = new sherpa.OfflinePunctuation({
      model: { ctTransformer: modelPath, numThreads: 1, provider: "cpu", debug: false },
    });
    debugLogger.info("ML punctuation model loaded", { modelPath });
  } catch (error) {
    punctuatorInitFailed = true;
    debugLogger.warn("Failed to init ML punctuation model; using heuristic fallback", {
      error: error.message,
    });
    return null;
  }
  return punctuator;
}

/**
 * Add ML punctuation to recognized text. Returns a punctuated string when the
 * model is loaded and the text contains CJK, otherwise null (caller falls back
 * to the asrPunctuation.js heuristic).
 */
function addMlPunctuation(rawText) {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return null;
  if (!CJK_CHAR_REGEX.test(text)) return null; // zh-en model; let heuristic handle pure-Latin

  let model = null;
  try {
    model = loadPunctuator();
  } catch {
    return null;
  }
  if (!model) {
    // Model not ready: if the ML runtime works but the model file is just
    // missing, self-install it in the background so local Chinese dictation
    // gets real punctuation from next time on. Fall back to heuristic for now.
    if (!isPunctuationModelAvailable() && loadSherpa()) {
      ensurePunctuationModelInBackground();
    }
    return null;
  }

  try {
    const result = model.addPunct(text);
    return typeof result === "string" && result.trim() ? result : null;
  } catch (error) {
    debugLogger.warn("ML punctuation addPunct failed; using heuristic fallback", {
      error: error.message,
    });
    return null;
  }
}

/**
 * Download + verify + extract the punctuation model into the punctuation
 * service models dir. Mirrors the paraformer download/extract pipeline and
 * reuses the same checksum/size verification and safe-extraction primitives.
 */
async function downloadPunctuationModel({
  onProgress = null,
  signal = null,
  modelName = DEFAULT_PUNCTUATION_MODEL,
  uiLanguage = "",
} = {}) {
  const config = getPunctuationModelConfig(modelName);
  if (!config) throw new Error(`Unknown punctuation model: ${modelName}`);

  if (isPunctuationModelAvailable(modelName)) {
    return {
      model: modelName,
      downloaded: false,
      alreadyInstalled: true,
      path: getModelDir(modelName),
    };
  }

  const modelsDir = getModelsDirForService(SERVICE);
  await fsPromises.mkdir(modelsDir, { recursive: true });

  const archivePath = resolveInsideDirectory(
    modelsDir,
    config.archiveFileName,
    "Punctuation archive"
  );
  const targetDir = resolveInsideDirectory(
    modelsDir,
    config.extractDir,
    "Punctuation model directory"
  );
  const tempExtractDir = resolveInsideDirectory(
    modelsDir,
    `temp-extract-${modelName}`,
    "Punctuation temp extract directory"
  );

  const sources = buildDownloadSources(
    { primaryUrl: config.downloadUrl, mirrorPath: config.mirrorPath || config.archiveFileName },
    { uiLanguage }
  );

  let archiveReady = false;
  try {
    await validateDownloadedArtifact(archivePath, {
      expectedSize: config.archiveSizeBytes || 0,
      sha256: config.sha256 || "",
      strictSize: true,
    });
    archiveReady = true;
  } catch {
    archiveReady = false;
  }

  if (!archiveReady) {
    await downloadArtifactFromSources({
      artifactLabel: "punctuation-model",
      modelId: modelName,
      destination: archivePath,
      sources,
      expectedSize: config.archiveSizeBytes || 0,
      sha256: config.sha256 || "",
      strictSize: true,
      progressCallback: onProgress,
      signal,
    });

    await validateDownloadedArtifact(archivePath, {
      expectedSize: config.archiveSizeBytes || 0,
      sha256: config.sha256 || "",
      strictSize: true,
    });
  }

  await fsPromises.rm(tempExtractDir, { recursive: true, force: true }).catch(() => {});
  await fsPromises.mkdir(tempExtractDir, { recursive: true });

  let installed = false;
  try {
    await runSystemTarExtractSafe(archivePath, tempExtractDir, ["-xjf"], { signal });

    const extractedInner = resolveInsideDirectory(
      tempExtractDir,
      config.extractDir,
      "Punctuation extracted directory"
    );
    if (!fs.existsSync(extractedInner)) {
      throw new Error(`Extracted archive missing expected directory: ${config.extractDir}`);
    }

    await fsPromises.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    await fsPromises.rename(extractedInner, targetDir);
    installed = true;
  } finally {
    await fsPromises.rm(tempExtractDir, { recursive: true, force: true }).catch(() => {});
    if (installed) {
      await fsPromises.unlink(archivePath).catch(() => {});
    }
  }

  if (!isPunctuationModelAvailable(modelName)) {
    throw new Error("Punctuation model installed but model file not found after extraction.");
  }

  // Drop cached state so the next addMlPunctuation() picks up the new model.
  punctuator = null;
  punctuatorInitFailed = false;

  return { model: modelName, downloaded: true, path: targetDir };
}

/**
 * Kick off a one-time background download of the punctuation model so local
 * Chinese dictation self-installs ML punctuation on first use. Non-blocking and
 * idempotent: skips when already installed, de-dupes concurrent calls, and on
 * failure clears the guard so a later session can retry. Callers stay on the
 * heuristic until the model is ready.
 */
function ensurePunctuationModelInBackground(options = {}) {
  if (backgroundEnsurePromise) return backgroundEnsurePromise;
  if (isPunctuationModelAvailable()) return Promise.resolve(null);

  const controller = options.signal ? null : createDownloadSignal();
  const downloadOptions = controller ? { ...options, signal: controller.signal } : options;
  backgroundEnsureAbort = controller?.abort || null;

  backgroundEnsurePromise = downloadPunctuationModel(downloadOptions)
    .then((result) => {
      debugLogger.info("ML punctuation model auto-installed", { path: result?.path });
      return result;
    })
    .catch((error) => {
      debugLogger.debug("Background punctuation model download failed; staying on heuristic", {
        error: error.message,
      });
      return null;
    })
    .finally(() => {
      backgroundEnsurePromise = null;
      backgroundEnsureAbort = null;
    });
  return backgroundEnsurePromise;
}

async function deletePunctuationModels() {
  try {
    backgroundEnsureAbort?.();
    await backgroundEnsurePromise?.catch(() => {});

    punctuator = null;
    punctuatorInitFailed = false;
    const modelsDir = getModelsDirForService(SERVICE);
    await fsPromises.rm(modelsDir, { recursive: true, force: true });
    if (fs.existsSync(modelsDir)) {
      throw new Error("Punctuation model files still exist after deletion");
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = {
  DEFAULT_PUNCTUATION_MODEL,
  addMlPunctuation,
  isPunctuationModelAvailable,
  downloadPunctuationModel,
  deletePunctuationModels,
  ensurePunctuationModelInBackground,
  getPunctuationModelConfig,
};
