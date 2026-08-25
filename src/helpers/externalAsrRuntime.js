const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs/promises");

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const VALID_PROVIDERS = new Set(["granite", "cohere"]);

function hasControlChars(value) {
  return /[\u0000-\u001F\u007F]/.test(String(value || ""));
}

function normalizeHeaderValue(value) {
  const normalized = String(value || "").trim();
  if (hasControlChars(normalized)) {
    throw new Error("Header value contains invalid control characters");
  }
  return normalized;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isAllowedHttpHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.endsWith(".local") ||
    isPrivateIpv4(normalized)
  );
}

function normalizeRuntimeTranscriptionUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) {
    throw new Error("External ASR runtime endpoint is required.");
  }
  if (input.length > 2048 || hasControlChars(input)) {
    throw new Error("External ASR runtime endpoint is invalid.");
  }
  if (!/^https?:\/\//i.test(input)) {
    throw new Error("External ASR runtime endpoint must start with http:// or https://.");
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("External ASR runtime endpoint is not a valid URL.");
  }

  if (url.username || url.password) {
    throw new Error("External ASR runtime endpoint must not include username or password.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("External ASR runtime endpoint must use HTTP or HTTPS.");
  }

  if (url.protocol === "http:" && !isAllowedHttpHost(url.hostname)) {
    throw new Error("HTTP runtime endpoints are only allowed for localhost or private LAN hosts.");
  }

  url.hash = "";
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (!/\/(?:audio\/)?transcriptions$/i.test(normalizedPath)) {
    const basePath = normalizedPath === "" ? "" : normalizedPath;
    url.pathname = `${basePath}${basePath.endsWith("/v1") ? "" : "/v1"}/audio/transcriptions`;
  }

  return url;
}

function normalizeProvider(provider) {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase();
  if (!VALID_PROVIDERS.has(normalized)) {
    throw new Error("Unsupported external ASR provider.");
  }
  return normalized;
}

function normalizeModel(model) {
  const normalized = String(model || "").trim();
  if (!normalized || normalized.length > 256 || hasControlChars(normalized)) {
    throw new Error("External ASR model id is invalid.");
  }
  return normalized;
}

function normalizeLanguage(language) {
  const normalized = String(language || "").trim();
  if (!normalized || normalized === "auto") return "";
  if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(normalized)) return "";
  return normalized;
}

function escapeMultipartName(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "%22")
    .replace(/\r|\n/g, "");
}

function addField(parts, boundary, name, value) {
  if (value === undefined || value === null || value === "") return;
  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeMultipartName(name)}"\r\n\r\n` +
      `${String(value)}\r\n`
  );
}

function addFile(parts, boundary, name, fileName, contentType, buffer) {
  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeMultipartName(name)}"; filename="${escapeMultipartName(fileName)}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  parts.push(buffer);
  parts.push("\r\n");
}

function toBuffer(audioBuffer) {
  if (Buffer.isBuffer(audioBuffer)) return audioBuffer;
  if (audioBuffer instanceof ArrayBuffer) return Buffer.from(audioBuffer);
  if (ArrayBuffer.isView(audioBuffer)) {
    return Buffer.from(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength);
  }
  return Buffer.from(audioBuffer || []);
}

function extractText(parsed) {
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed;
  if (typeof parsed.text === "string") return parsed.text;
  if (typeof parsed.transcription === "string") return parsed.transcription;
  if (typeof parsed.data?.text === "string") return parsed.data.text;
  if (typeof parsed.result?.text === "string") return parsed.result.text;
  if (Array.isArray(parsed.segments)) {
    return parsed.segments
      .map((segment) => (typeof segment?.text === "string" ? segment.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function extractErrorMessage(parsed, rawText, statusCode) {
  if (parsed?.error?.message) return String(parsed.error.message);
  if (parsed?.message) return String(parsed.message);
  if (parsed?.detail)
    return typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
  if (rawText) return rawText.slice(0, 400);
  return `External ASR runtime returned HTTP ${statusCode}`;
}

function parseResponseBody(rawText, contentType) {
  if (!rawText) return null;
  if (contentType.includes("application/json") || /^[\s\r\n]*[{\[]/.test(rawText)) {
    try {
      return JSON.parse(rawText);
    } catch {
      return null;
    }
  }
  return rawText;
}

function buildRuntimeModelsUrl(transcriptionUrl) {
  const url = new URL(transcriptionUrl.toString());
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (/\/audio\/transcriptions$/i.test(normalizedPath)) {
    url.pathname = normalizedPath.replace(/\/audio\/transcriptions$/i, "/models");
  } else if (normalizedPath.endsWith("/v1")) {
    url.pathname = `${normalizedPath}/models`;
  } else {
    url.pathname = `${normalizedPath}/v1/models`;
  }

  url.search = "";
  return url;
}

function buildRuntimeHealthUrl(transcriptionUrl) {
  const url = new URL(transcriptionUrl.toString());
  url.pathname = "/health";
  url.search = "";
  return url;
}

function extractModelIds(parsed) {
  const candidates = Array.isArray(parsed?.data)
    ? parsed.data
    : Array.isArray(parsed?.models)
      ? parsed.models
      : Array.isArray(parsed)
        ? parsed
        : [];

  return candidates
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.id === "string") return item.id;
      if (typeof item?.name === "string") return item.name;
      return "";
    })
    .filter(Boolean);
}

function isAuthFailure(statusCode) {
  return statusCode === 401 || statusCode === 403;
}

function isTranscriptionProbeSuccess(statusCode) {
  return (
    (statusCode >= 200 && statusCode < 400) ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 405
  );
}

function requestRuntimeProbe(url, { method = "GET", apiKey = "", timeoutMs }) {
  const endpoint = new URL(url.toString());
  const httpModule = endpoint.protocol === "https:" ? https : http;
  const safeApiKey = normalizeHeaderValue(apiKey || "");

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = httpModule.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
        path: `${endpoint.pathname}${endpoint.search}`,
        method,
        headers: {
          Accept: "application/json",
          ...(safeApiKey ? { Authorization: `Bearer ${safeApiKey}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let totalBytes = 0;

        res.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            const err = new Error("External ASR runtime check response is too large.");
            err.code = "RESPONSE_TOO_LARGE";
            req.destroy(err);
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8").trim();
          const contentTypeHeader = String(res.headers["content-type"] || "").toLowerCase();
          finish(resolve, {
            statusCode: res.statusCode || 0,
            rawText,
            parsed: parseResponseBody(rawText, contentTypeHeader),
          });
        });
      }
    );

    req.on("timeout", () => {
      const err = new Error(
        `External ASR runtime check timed out after ${Math.round(timeoutMs / 1000)}s.`
      );
      err.code = "TIMEOUT";
      req.destroy(err);
    });
    req.on("error", (error) => finish(reject, error));
    req.end();
  });
}

async function checkExternalAsrRuntime(options = {}) {
  const provider = normalizeProvider(options.provider);
  const model = normalizeModel(options.model);
  const endpoint = normalizeRuntimeTranscriptionUrl(options.runtimeUrl);
  const apiKey = normalizeHeaderValue(options.apiKey || "");
  const timeoutMs = Math.max(
    3_000,
    Math.min(Number(options.timeoutMs) || DEFAULT_CHECK_TIMEOUT_MS, 30_000)
  );

  const baseResult = {
    provider,
    model,
    endpoint: endpoint.toString(),
    modelFound: null,
    statusCode: 0,
  };

  const modelsUrl = buildRuntimeModelsUrl(endpoint);
  let lastError = "";

  try {
    const modelsProbe = await requestRuntimeProbe(modelsUrl, {
      apiKey,
      timeoutMs,
    });

    if (modelsProbe.statusCode >= 200 && modelsProbe.statusCode < 300) {
      const modelIds = extractModelIds(modelsProbe.parsed);
      const modelFound = modelIds.length > 0 ? modelIds.includes(model) : null;

      if (modelFound === false) {
        return {
          ...baseResult,
          success: false,
          status: "model_missing",
          statusCode: modelsProbe.statusCode,
          modelFound,
          message: `Runtime is reachable, but ${model} was not listed by /v1/models.`,
        };
      }

      return {
        ...baseResult,
        success: true,
        status: "ready",
        statusCode: modelsProbe.statusCode,
        modelFound,
        message: "External ASR runtime is reachable.",
      };
    }

    if (isAuthFailure(modelsProbe.statusCode)) {
      return {
        ...baseResult,
        success: false,
        status: "auth_required",
        statusCode: modelsProbe.statusCode,
        message: "External ASR runtime rejected the request. Check the API key.",
      };
    }

    lastError = `GET ${modelsUrl.pathname} returned HTTP ${modelsProbe.statusCode}`;
  } catch (error) {
    lastError = error.message || "Failed to query /v1/models.";
  }

  try {
    const transcriptionProbe = await requestRuntimeProbe(endpoint, {
      method: "HEAD",
      apiKey,
      timeoutMs,
    });

    if (isAuthFailure(transcriptionProbe.statusCode)) {
      return {
        ...baseResult,
        success: false,
        status: "auth_required",
        statusCode: transcriptionProbe.statusCode,
        message: "External ASR runtime rejected the request. Check the API key.",
      };
    }

    if (isTranscriptionProbeSuccess(transcriptionProbe.statusCode)) {
      return {
        ...baseResult,
        success: true,
        status: "ready",
        statusCode: transcriptionProbe.statusCode,
        message: "External ASR transcription endpoint is reachable.",
      };
    }

    lastError = `HEAD ${endpoint.pathname} returned HTTP ${transcriptionProbe.statusCode}`;
  } catch (error) {
    lastError = error.message || "Failed to reach transcription endpoint.";
  }

  try {
    const healthUrl = buildRuntimeHealthUrl(endpoint);
    const healthProbe = await requestRuntimeProbe(healthUrl, {
      apiKey,
      timeoutMs,
    });

    if (healthProbe.statusCode >= 200 && healthProbe.statusCode < 300) {
      return {
        ...baseResult,
        success: true,
        status: "reachable",
        statusCode: healthProbe.statusCode,
        message: "External ASR runtime health endpoint is reachable.",
      };
    }

    if (isAuthFailure(healthProbe.statusCode)) {
      return {
        ...baseResult,
        success: false,
        status: "auth_required",
        statusCode: healthProbe.statusCode,
        message: "External ASR runtime rejected the request. Check the API key.",
      };
    }

    lastError = `GET ${healthUrl.pathname} returned HTTP ${healthProbe.statusCode}`;
  } catch (error) {
    lastError = error.message || "Failed to reach health endpoint.";
  }

  return {
    ...baseResult,
    success: false,
    status: "unreachable",
    message: lastError || "External ASR runtime is unreachable.",
  };
}

async function transcribeExternalAsrRuntime(audioBuffer, options = {}) {
  const provider = normalizeProvider(options.provider);
  const model = normalizeModel(options.model);
  const endpoint = normalizeRuntimeTranscriptionUrl(options.runtimeUrl);
  const audioData = toBuffer(audioBuffer);
  if (audioData.length === 0) {
    return { success: false, error: "no_audio_data", message: "No audio detected" };
  }

  const contentType = normalizeHeaderValue(options.mimeType || "audio/webm") || "audio/webm";
  const apiKey = normalizeHeaderValue(options.apiKey || "");
  const language = normalizeLanguage(options.language);
  const prompt = String(options.prompt || "").trim();
  const signal = options.signal || null;
  const timeoutMs = Math.max(
    5_000,
    Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 300_000)
  );
  if (signal?.aborted) {
    const err = new Error("External ASR runtime transcription cancelled.");
    err.code = "ABORT_ERR";
    throw err;
  }
  const boundary = `----ChordVoxExternalAsr${crypto.randomBytes(8).toString("hex")}`;
  const parts = [];

  addFile(parts, boundary, "file", options.fileName || "audio.webm", contentType, audioData);
  addField(parts, boundary, "model", model);
  addField(parts, boundary, "response_format", "json");
  addField(parts, boundary, "language", language);
  addField(parts, boundary, "prompt", prompt);
  parts.push(`--${boundary}--\r\n`);

  const body = Buffer.concat(
    parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part))
  );
  const httpModule = endpoint.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      const err = new Error("External ASR runtime transcription cancelled.");
      err.code = "ABORT_ERR";
      if (req) {
        req.destroy(err);
      }
      finish(reject, err);
    };

    req = httpModule.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
        path: `${endpoint.pathname}${endpoint.search}`,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let totalBytes = 0;
        res.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            const err = new Error("External ASR runtime response is too large.");
            err.code = "RESPONSE_TOO_LARGE";
            req.destroy(err);
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8").trim();
          const contentTypeHeader = String(res.headers["content-type"] || "").toLowerCase();
          const parsed = parseResponseBody(rawText, contentTypeHeader);

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(extractErrorMessage(parsed, rawText, res.statusCode));
            err.code = "EXTERNAL_ASR_HTTP_ERROR";
            err.statusCode = res.statusCode;
            finish(reject, err);
            return;
          }

          const text = extractText(parsed || rawText);
          if (!text.trim()) {
            const err = new Error("External ASR runtime returned an empty transcript.");
            err.code = "EMPTY_TRANSCRIPT";
            finish(reject, err);
            return;
          }

          finish(resolve, {
            success: true,
            text: text.trim(),
            provider,
            model,
            statusCode: res.statusCode,
          });
        });
      }
    );

    req.on("timeout", () => {
      const err = new Error(
        `External ASR runtime timed out after ${Math.round(timeoutMs / 1000)}s.`
      );
      err.code = "TIMEOUT";
      req.destroy(err);
    });
    req.on("error", (error) => finish(reject, error));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    req.write(body);
    req.end();
  });
}

async function transcribeExternalAsrRuntimeFile(filePath, options = {}) {
  const signal = options.signal || null;
  signal?.throwIfAborted?.();
  const audioData = await fs.readFile(filePath, { signal });
  return transcribeExternalAsrRuntime(audioData, {
    ...options,
    mimeType: options.mimeType || "application/octet-stream",
    fileName: options.fileName || options.sourceFileName || "audio",
  });
}

module.exports = {
  checkExternalAsrRuntime,
  normalizeRuntimeTranscriptionUrl,
  transcribeExternalAsrRuntime,
  transcribeExternalAsrRuntimeFile,
};
