const fs = require("fs/promises");
const debugLogger = require("./debugLogger");

const DEFAULT_MODEL = "chirp_3";
const DEFAULT_TIMEOUT_MS = 60_000;
const PLACEHOLDER_ENDPOINT_PATTERN = /\b(YOUR_PROJECT_ID|PROJECT_ID)\b/i;

function isAllowedGoogleCloudSttHost(hostname) {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase();
  return normalized === "googleapis.com" || normalized.endsWith(".googleapis.com");
}

const LANGUAGE_CODE_MAP = {
  zh: "cmn-Hans-CN",
  "zh-cn": "cmn-Hans-CN",
  "zh-hans": "cmn-Hans-CN",
  "zh-hans-cn": "cmn-Hans-CN",
  "zh-tw": "cmn-Hant-TW",
  "zh-hant": "cmn-Hant-TW",
  en: "en-US",
  "en-us": "en-US",
  "en-gb": "en-GB",
  ja: "ja-JP",
  ko: "ko-KR",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
  ru: "ru-RU",
  hi: "hi-IN",
  pl: "pl-PL",
  nl: "nl-NL",
  tr: "tr-TR",
  vi: "vi-VN",
  id: "id-ID",
  th: "th-TH",
};

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data || []);
}

function createSilentWavBuffer(durationMs = 250) {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function normalizeEndpoint(endpoint) {
  const raw = String(endpoint || "").trim();
  if (!raw) {
    throw new Error(
      "Google Cloud STT endpoint not configured. Use a Speech-to-Text v2 recognize endpoint."
    );
  }
  if (PLACEHOLDER_ENDPOINT_PATTERN.test(raw)) {
    throw new Error("Replace PROJECT_ID in the Google Cloud STT endpoint before testing.");
  }
  if (!/^https:\/\//i.test(raw)) {
    throw new Error("Google Cloud STT endpoint must start with https://");
  }
  const url = new URL(raw);
  if (!isAllowedGoogleCloudSttHost(url.hostname)) {
    throw new Error("Google Cloud STT endpoint must use a googleapis.com host.");
  }
  if (/:recognize$/i.test(url.pathname)) {
    return raw;
  }
  if (/\/recognizers\/[^/?#:]+$/i.test(url.pathname)) {
    url.pathname = `${url.pathname}:recognize`;
    return url.toString();
  }
  if (!/:recognize$/i.test(url.pathname)) {
    throw new Error(
      "Google Cloud STT endpoint must be a v2 recognizers:recognize URL, for example https://us-speech.googleapis.com/v2/projects/PROJECT_ID/locations/us/recognizers/_:recognize"
    );
  }
  return raw;
}

function normalizeCredential(rawCredential) {
  const credential = String(rawCredential || "").trim();
  if (!credential) return { type: "empty", value: "" };

  const bearerMatch = credential.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return { type: "bearer", value: bearerMatch[1].trim() };
  }

  if (/^ya29\./i.test(credential) || /^eyJ[a-zA-Z0-9_-]+\./.test(credential)) {
    return { type: "bearer", value: credential };
  }

  return { type: "api-key", value: credential };
}

function buildRequestTarget({ endpoint, credential }) {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const url = new URL(normalizedEndpoint);
  const normalizedCredential = normalizeCredential(credential);
  const headers = {
    "Content-Type": "application/json",
  };

  if (normalizedCredential.type === "bearer") {
    headers.Authorization = `Bearer ${normalizedCredential.value}`;
  } else if (normalizedCredential.type === "api-key") {
    if (!url.searchParams.has("key")) {
      url.searchParams.set("key", normalizedCredential.value);
    }
  } else if (!url.searchParams.has("key") && !url.searchParams.has("access_token")) {
    throw new Error("Google Cloud STT access token or API key not configured.");
  }

  return {
    url: url.toString(),
    headers,
  };
}

function normalizeLanguageCodes(language) {
  const raw = String(language || "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "auto") return [];
  const mapped = LANGUAGE_CODE_MAP[raw] || LANGUAGE_CODE_MAP[raw.split("-")[0]];
  if (mapped) return [mapped];
  return [language];
}

function extractTranscript(response) {
  const results = Array.isArray(response?.results) ? response.results : [];
  return results
    .map((result) => result?.alternatives?.[0]?.transcript)
    .filter((text) => typeof text === "string" && text.trim())
    .map((text) => text.trim())
    .join("\n")
    .trim();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const abortController = new AbortController();
  const parentSignal = options?.signal;
  const onAbort = () => abortController.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    onAbort();
  } else {
    parentSignal?.addEventListener?.("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener?.("abort", onAbort);
  }
}

class GoogleCloudSttClient {
  async transcribe({ audioBuffer, endpoint, credential, model, language, timeoutMs, signal }) {
    return this.recognize({
      audioBuffer,
      endpoint,
      credential,
      model,
      language,
      timeoutMs,
      signal,
      allowEmptyText: false,
    });
  }

  async transcribeFile({ filePath, endpoint, credential, model, language, timeoutMs, signal }) {
    const audioBuffer = await fs.readFile(filePath, { signal });
    return this.transcribe({
      audioBuffer,
      endpoint,
      credential,
      model,
      language,
      timeoutMs,
      signal,
    });
  }

  async testConnection({ endpoint, credential, model, language, timeoutMs }) {
    const result = await this.recognize({
      audioBuffer: createSilentWavBuffer(),
      endpoint,
      credential,
      model,
      language: language || "auto",
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 20_000,
      allowEmptyText: true,
    });

    return {
      ...result,
      resolvedModelId: result.model,
    };
  }

  async recognize({
    audioBuffer,
    endpoint,
    credential,
    model,
    language,
    timeoutMs,
    signal,
    allowEmptyText = false,
  }) {
    const normalizedAudio = toBuffer(audioBuffer);
    if (!normalizedAudio.length) {
      throw new Error("Google Cloud STT audio buffer is empty");
    }

    const resolvedModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const requestTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const { url, headers } = buildRequestTarget({ endpoint, credential });
    const languageCodes = normalizeLanguageCodes(language);
    const config = {
      autoDecodingConfig: {},
      model: resolvedModel,
    };
    if (languageCodes.length) {
      config.languageCodes = languageCodes;
    }
    const body = {
      config,
      content: normalizedAudio.toString("base64"),
    };

    debugLogger.debug(
      "Google Cloud STT request",
      {
        endpointHost: new URL(url).host,
        model: resolvedModel,
        languageCodes: body.config.languageCodes || [],
        audioBytes: normalizedAudio.length,
        hasAuthorization: Boolean(headers.Authorization),
        hasQueryKey: new URL(url).searchParams.has("key"),
      },
      "transcription"
    );

    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      },
      requestTimeoutMs
    );
    const rawText = await response.text();
    let parsed = null;

    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const errorMessage =
        parsed?.error?.message ||
        parsed?.message ||
        rawText ||
        `Google Cloud STT API error: ${response.status}`;
      const code = parsed?.error?.status || parsed?.error?.code || response.status;
      throw new Error(`Google Cloud STT ${code}: ${errorMessage}`);
    }

    const text = extractTranscript(parsed);
    if (!text && !allowEmptyText) {
      throw new Error("No text transcribed - Google Cloud STT response was empty");
    }

    return {
      text,
      model: resolvedModel,
      responseMetadata: parsed?.metadata || null,
    };
  }
}

module.exports = GoogleCloudSttClient;
