type GeminiEndpointFamily = "official-google" | "chordvox-bridge" | "compatible" | "unknown";

type GeminiGenerateContentEndpointInfo = {
  baseUrl: string;
  modelId: string;
  method: "generateContent" | "streamGenerateContent";
};

export function normalizeBaseUrl(value?: string | null): string {
  if (!value) return "";

  let normalized = String(value).trim();
  if (!normalized) return "";

  const suffixReplacements: Array<[RegExp, string]> = [
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

export function normalizeEndpointUrl(value?: string | null): string {
  if (!value) return "";

  const trimmed = String(value).trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  const lower = trimmed.toLowerCase();
  if (lower.endsWith("/responses") || lower.endsWith("/chat/completions")) {
    return trimmed;
  }

  return normalizeBaseUrl(trimmed);
}

export function getEndpointBaseUrl(value?: string | null): string {
  return normalizeBaseUrl(normalizeEndpointUrl(value));
}

export function getGeminiEndpointFamily(value?: string | null): GeminiEndpointFamily {
  const normalized = getEndpointBaseUrl(value);
  if (!normalized) return "unknown";
  if (/generativelanguage\.googleapis\.com/i.test(normalized)) return "official-google";
  if (/\/gemini-bridge(?:\/(?:v1|v1beta))?$/i.test(normalized)) return "chordvox-bridge";
  return "compatible";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isOfficialGoogleGeminiEndpoint(value?: string | null): boolean {
  return getGeminiEndpointFamily(value) === "official-google";
}

export function isChordVoxGeminiBridgeEndpoint(value?: string | null): boolean {
  return getGeminiEndpointFamily(value) === "chordvox-bridge";
}

export function isOpenAiCompatibleGeminiEndpoint(value?: string | null): boolean {
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

export function getGeminiRequestBaseUrl(value?: string | null): string {
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

export function getGeminiGenerateContentEndpointInfo(
  value?: string | null
): GeminiGenerateContentEndpointInfo | null {
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

export function isGeminiGenerateContentEndpoint(value?: string | null): boolean {
  return !!getGeminiGenerateContentEndpointInfo(value);
}

export function buildGeminiGenerateContentUrl(endpointOrBase: string, modelId: string): string {
  const endpointInfo = getGeminiGenerateContentEndpointInfo(endpointOrBase);
  if (endpointInfo?.method === "generateContent") {
    return String(endpointOrBase).trim().replace(/\/+$/, "");
  }

  const baseUrl = endpointInfo?.baseUrl || getGeminiRequestBaseUrl(endpointOrBase);
  if (!baseUrl || !modelId) return "";
  return `${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`;
}

export function buildGeminiStreamGenerateContentUrl(
  endpointOrBase: string,
  modelId: string
): string {
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

export function buildApiUrl(base: string, path: string): string {
  const normalizedBase = normalizeBaseUrl(base) || "https://api.openai.com/v1";
  if (!path) {
    return normalizedBase;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function buildModelsUrl(endpointOrBase: string): string {
  const normalizedBase = getEndpointBaseUrl(endpointOrBase);
  if (!normalizedBase) return "";
  return buildApiUrl(normalizedBase, "/models");
}
