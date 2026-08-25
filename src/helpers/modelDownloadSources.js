const path = require("path");
const fsPromises = require("fs").promises;
const debugLogger = require("./debugLogger");
const { downloadFile, validateFileSize, validateFileSha256 } = require("./downloadUtils");

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

const SOURCE_CONNECT_TIMEOUT_MS = Number(process.env.CHORDVOX_DOWNLOAD_SOURCE_TIMEOUT_MS || 10000);

function normalizeSha256(value = "") {
  return String(value || "")
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
}

function normalizeProtocol(url = "") {
  try {
    return new URL(String(url)).protocol;
  } catch {
    return "";
  }
}

function isOfficialSource(source) {
  const kind = String(source?.kind || inferSourceKind(source?.url || ""))
    .trim()
    .toLowerCase();
  return kind === "official" || kind === "github" || kind === "huggingface" || kind === "hf";
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
  if (normalized.includes("modelscope.cn")) return "modelscope";
  if (normalized.includes("r2.cloudflarestorage.com")) return "r2";
  if (normalized.includes("myqcloud.com") || normalized.includes(".cos.")) return "cos";
  if (normalized.includes("aliyuncs.com") || normalized.includes(".oss-")) return "oss";
  if (normalized.includes("cdn")) return "cdn";
  return fallback;
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
  const hasOfficialSource = sources.some((source) => {
    const kind = String(source.kind || "")
      .trim()
      .toLowerCase();
    return kind === "official" || kind === "github";
  });

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

async function validateDownloadedArtifact(
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

function assertDownloadSourceAllowed(source, sha256 = "") {
  const normalizedSha256 = normalizeSha256(sha256);
  const protocol = normalizeProtocol(source?.url || "");
  if (protocol !== "https:" && !normalizedSha256) {
    const error = new Error("Non-HTTPS model downloads require a sha256 checksum.");
    error.code = "ERR_DOWNLOAD_CHECKSUM_REQUIRED";
    throw error;
  }

  if (!isOfficialSource(source) && !normalizedSha256) {
    const error = new Error("Non-official model mirrors require a sha256 checksum.");
    error.code = "ERR_DOWNLOAD_CHECKSUM_REQUIRED";
    throw error;
  }
}

async function downloadArtifactFromSources({
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
  timeout = SOURCE_CONNECT_TIMEOUT_MS,
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
    assertDownloadSourceAllowed(source, sha256);
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
      await downloadFile(source.url, destination, {
        timeout,
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
              resolvedTotalBytes > 0 ? Math.round((completedBytes / resolvedTotalBytes) * 100) : 0,
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

      debugLogger.info("Model artifact downloaded", {
        modelId,
        artifactLabel,
        sourceKind: source.kind || "unknown",
      });
      return source;
    } catch (error) {
      lastError = error;
      if (error?.isAbort || signal?.aborted) {
        throw error;
      }

      debugLogger.warn(
        hasNextSource
          ? "Model download source failed; trying next source"
          : "Model download source failed; no more sources",
        {
          modelId,
          artifactLabel,
          sourceIndex: index + 1,
          sourceCount: availableSources.length,
          sourceKind: source.kind || "unknown",
          code: error.code,
          statusCode: error.statusCode,
          error: error.message,
        }
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

function defaultMirrorPathFromUrl(url = "", fallbackName = "") {
  if (fallbackName) return fallbackName;
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return path.basename(String(url || ""));
  }
}

module.exports = {
  buildDownloadSources,
  defaultMirrorPathFromUrl,
  downloadArtifactFromSources,
  inferSourceKind,
  isChineseLocale,
  normalizeSha256,
  sourcePriority,
  validateDownloadedArtifact,
};
