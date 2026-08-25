// Shared endpoint normalization helpers used by both Electron main (CommonJS)
// and renderer TypeScript code. Keep this file dependency-free.

function normalizeBaseUrl(value) {
  if (!value) return "";

  let normalized = String(value).trim();
  if (!normalized) return "";

  const suffixReplacements = [
    [/\/v1\/chat\/completions$/i, "/v1"],
    [/\/chat\/completions$/i, ""],
    [/\/v1\/responses$/i, "/v1"],
    [/\/responses$/i, ""],
    [/\/v1\/models$/i, "/v1"],
    [/\/models$/i, ""],
    [/\/v1\/audio\/transcriptions$/i, "/v1"],
    [/\/audio\/transcriptions$/i, ""],
    [/\/v1\/audio\/translations$/i, "/v1"],
    [/\/audio\/translations$/i, ""],
  ];

  for (const [pattern, replacement] of suffixReplacements) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, replacement).replace(/\/+$/, "");
    }
  }

  return normalized.replace(/\/+$/, "");
}

function normalizeEndpointUrl(value) {
  if (!value) return "";

  const trimmed = String(value).trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  const lower = trimmed.toLowerCase();
  if (lower.endsWith("/responses") || lower.endsWith("/chat/completions")) {
    return trimmed;
  }

  return normalizeBaseUrl(trimmed);
}

function getEndpointBaseUrl(value) {
  return normalizeBaseUrl(normalizeEndpointUrl(value));
}

function getGeminiEndpointFamily(value) {
  const normalized = getEndpointBaseUrl(value);
  if (!normalized) return "unknown";
  if (/generativelanguage\.googleapis\.com/i.test(normalized)) return "official-google";
  if (/\/gemini-bridge(?:\/(?:v1|v1beta))?$/i.test(normalized)) return "chordvox-bridge";
  return "compatible";
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isOfficialGoogleGeminiEndpoint(value) {
  return getGeminiEndpointFamily(value) === "official-google";
}

function isChordVoxGeminiBridgeEndpoint(value) {
  return getGeminiEndpointFamily(value) === "chordvox-bridge";
}

function isOpenAiCompatibleGeminiEndpoint(value) {
  const normalized = getEndpointBaseUrl(value);
  if (!normalized) return false;

  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return /\/gemini-openai\/v\d+(?:beta)?$/i.test(pathname);
  } catch {
    return false;
  }
}

function getGeminiRequestBaseUrl(value) {
  const normalized = getEndpointBaseUrl(value);
  if (!normalized) return "";
  if (/\/gemini-bridge$/i.test(normalized)) {
    return `${normalized}/v1`;
  }
  if (/\/gemini-bridge\/v1beta$/i.test(normalized)) {
    return normalized.replace(/\/v1beta$/i, "/v1");
  }
  if (/googleapis\.com$/i.test(normalized)) {
    return `${normalized}/v1beta`;
  }
  return normalized;
}

function getGeminiGenerateContentEndpointInfo(value) {
  if (!value) return null;

  const trimmed = String(value).trim().replace(/\/+$/, "");
  if (!trimmed) return null;

  const [withoutQuery] = trimmed.split("?");
  const match = withoutQuery.match(
    /^(.*)\/models\/([^/]+):(generateContent|streamGenerateContent)$/i
  );
  if (!match) return null;

  const baseUrl = normalizeBaseUrl(match[1]);
  const modelId = safeDecodeURIComponent(match[2]);
  const method =
    match[3].toLowerCase() === "streamgeneratecontent"
      ? "streamGenerateContent"
      : "generateContent";
  if (!baseUrl || !modelId) return null;

  return { baseUrl, modelId, method };
}

function isGeminiGenerateContentEndpoint(value) {
  return !!getGeminiGenerateContentEndpointInfo(value);
}

function buildGeminiGenerateContentUrl(endpointOrBase, modelId) {
  const endpointInfo = getGeminiGenerateContentEndpointInfo(endpointOrBase);
  if (endpointInfo?.method === "generateContent") {
    return String(endpointOrBase).trim().replace(/\/+$/, "");
  }

  const baseUrl = endpointInfo?.baseUrl || getGeminiRequestBaseUrl(endpointOrBase);
  if (!baseUrl || !modelId) return "";
  return `${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`;
}

function buildGeminiStreamGenerateContentUrl(endpointOrBase, modelId) {
  const endpointInfo = getGeminiGenerateContentEndpointInfo(endpointOrBase);
  if (endpointInfo) {
    return `${endpointInfo.baseUrl}/models/${encodeURIComponent(
      endpointInfo.modelId
    )}:streamGenerateContent?alt=sse`;
  }

  const baseUrl = getGeminiRequestBaseUrl(endpointOrBase);
  if (!baseUrl || !modelId) return "";
  return `${baseUrl}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
}

function buildApiUrl(base, path) {
  const normalizedBase = normalizeBaseUrl(base) || "https://api.openai.com/v1";
  if (!path) {
    return normalizedBase;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function buildModelsUrl(endpointOrBase) {
  const normalizedBase = getEndpointBaseUrl(endpointOrBase);
  if (!normalizedBase) return "";
  return buildApiUrl(normalizedBase, "/models");
}

module.exports = {
  normalizeBaseUrl,
  normalizeEndpointUrl,
  getEndpointBaseUrl,
  getGeminiEndpointFamily,
  isOfficialGoogleGeminiEndpoint,
  isChordVoxGeminiBridgeEndpoint,
  isOpenAiCompatibleGeminiEndpoint,
  getGeminiRequestBaseUrl,
  getGeminiGenerateContentEndpointInfo,
  isGeminiGenerateContentEndpoint,
  buildGeminiGenerateContentUrl,
  buildGeminiStreamGenerateContentUrl,
  buildApiUrl,
  buildModelsUrl,
};
