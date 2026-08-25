const crypto = require("crypto");
const fs = require("fs/promises");
const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const SONIOX_ASR_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const DEFAULT_MODEL = "stt-rt-v4";
const DEFAULT_TIMEOUT_MS = 60_000;
const AUDIO_CHUNK_SIZE_BYTES = 64 * 1024;
const AUDIO_SEND_INTERVAL_MS = 1;
const MAX_WS_BUFFERED_AMOUNT_BYTES = 2 * 1024 * 1024;

const LANGUAGE_HINT_MAP = {
  "zh-cn": "zh",
  "zh-tw": "zh",
  zh: "zh",
  yue: "yue",
  en: "en",
  ja: "ja",
  ko: "ko",
  es: "es",
  fr: "fr",
  de: "de",
  pt: "pt",
  it: "it",
  ru: "ru",
  ar: "ar",
  tr: "tr",
  vi: "vi",
  id: "id",
  ms: "ms",
  th: "th",
  nl: "nl",
  pl: "pl",
  ro: "ro",
  uk: "uk",
  el: "el",
  bn: "bn",
  fil: "fil",
  ne: "ne",
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data || []);
}

function normalizeLanguageHints(language) {
  const raw = String(language || "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "auto") return undefined;

  const mapped =
    LANGUAGE_HINT_MAP[raw] || LANGUAGE_HINT_MAP[raw.split("-")[0]] || raw.split("-")[0];
  return mapped ? [mapped] : undefined;
}

function splitAudioBuffer(audioBuffer, chunkSize = AUDIO_CHUNK_SIZE_BYTES) {
  const chunks = [];
  for (let offset = 0; offset < audioBuffer.length; offset += chunkSize) {
    chunks.push(audioBuffer.subarray(offset, Math.min(audioBuffer.length, offset + chunkSize)));
  }
  return chunks;
}

function sendFrame(ws, frame, options = {}) {
  return new Promise((resolve, reject) => {
    if (ws.bufferedAmount > MAX_WS_BUFFERED_AMOUNT_BYTES) {
      debugLogger.warn("Soniox WebSocket backpressure; waiting before send", {
        bufferedAmount: ws.bufferedAmount,
      });
      setTimeout(() => {
        sendFrame(ws, frame, options).then(resolve).catch(reject);
      }, AUDIO_SEND_INTERVAL_MS);
      return;
    }

    ws.send(frame, options, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function buildConfig({ apiKey, model, language, clientReferenceId }) {
  const config = {
    api_key: apiKey,
    model: model || DEFAULT_MODEL,
    audio_format: "auto",
    enable_endpoint_detection: true,
    max_endpoint_delay_ms: 500,
    client_reference_id: clientReferenceId,
  };

  const languageHints = normalizeLanguageHints(language);
  if (languageHints?.length) {
    config.language_hints = languageHints;
  }

  return config;
}

function extractMessageError(message) {
  if (!message || typeof message !== "object") return null;
  const code = message.error_code || message.code || message.error;
  const text = message.error_message || message.message;
  if (!code && !text) return null;
  return [code, text].filter(Boolean).join(": ");
}

function extractTokensText(tokens, finalOnly) {
  if (!Array.isArray(tokens)) return "";
  return tokens
    .filter((token) => token && typeof token.text === "string")
    .filter((token) => (finalOnly ? token.is_final === true : token.is_final !== true))
    .map((token) => token.text)
    .join("");
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

class SonioxAsrClient {
  async transcribe({ audioBuffer, apiKey, model, language, timeoutMs, signal }) {
    const normalizedAudio = toBuffer(audioBuffer);
    const normalizedApiKey = String(apiKey || "").trim();
    const resolvedModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

    if (!normalizedAudio.length) {
      throw new Error("Soniox audio buffer is empty");
    }
    if (!normalizedApiKey) {
      throw new Error("Soniox API key not configured");
    }

    return this.runWebSocketSession({
      audioBuffer: normalizedAudio,
      apiKey: normalizedApiKey,
      model: resolvedModel,
      language,
      timeoutMs,
      signal,
    });
  }

  async transcribeFile({ filePath, apiKey, model, language, timeoutMs, signal }) {
    const audioBuffer = await fs.readFile(filePath, { signal });
    return this.transcribe({
      audioBuffer,
      apiKey,
      model,
      language,
      timeoutMs,
      signal,
    });
  }

  async testConnection({ apiKey, model, language, timeoutMs }) {
    const normalizedApiKey = String(apiKey || "").trim();
    if (!normalizedApiKey) {
      throw new Error("Soniox API key not configured");
    }

    const resolvedModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    let result;
    try {
      result = await this.runWebSocketSession({
        audioBuffer: createSilentWavBuffer(),
        apiKey: normalizedApiKey,
        model: resolvedModel,
        language: language || "en",
        timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 15_000,
        allowEmptyText: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no (speech|audio)|silent|empty transcript/i.test(message)) {
        result = {
          text: "",
          model: resolvedModel,
          clientReferenceId: null,
        };
      } else {
        throw error;
      }
    }

    return {
      ...result,
      resolvedModelId: result.model,
    };
  }

  runWebSocketSession({
    audioBuffer,
    apiKey,
    model,
    language,
    timeoutMs,
    allowEmptyText = false,
    signal,
  }) {
    const requestTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const clientReferenceId = `chordvox-${crypto.randomUUID()}`;
    const config = buildConfig({ apiKey, model, language, clientReferenceId });

    return new Promise((resolve, reject) => {
      let settled = false;
      let finalText = "";
      let nonFinalText = "";
      let lastResponse = null;
      let ws = null;

      const onAbort = () => {
        const error = new Error("Soniox transcription cancelled");
        error.name = "AbortError";
        settle(reject, error);
      };

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener?.("abort", onAbort);
        try {
          if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        } catch {
          // Ignore close errors during cleanup.
        }
        fn(value);
      };

      const timeout = setTimeout(() => {
        settle(reject, new Error("Soniox transcription timed out"));
      }, requestTimeoutMs);

      ws = new WebSocket(SONIOX_ASR_WS_URL);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });

      const resolveTranscript = () => {
        const text = `${finalText}${nonFinalText}`.trim();
        if (!text && !allowEmptyText) {
          settle(reject, new Error("No text transcribed - Soniox response was empty"));
          return;
        }
        settle(resolve, {
          text,
          model,
          clientReferenceId,
          finalAudioProcMs: lastResponse?.final_audio_proc_ms ?? null,
          totalAudioProcMs: lastResponse?.total_audio_proc_ms ?? null,
        });
      };

      ws.on("open", async () => {
        try {
          await sendFrame(ws, JSON.stringify(config));

          const chunks = splitAudioBuffer(audioBuffer);
          for (let index = 0; index < chunks.length; index += 1) {
            signal?.throwIfAborted?.();
            await sendFrame(ws, chunks[index], { binary: true });
            if (index < chunks.length - 1) {
              await wait(AUDIO_SEND_INTERVAL_MS);
            }
          }

          await sendFrame(ws, Buffer.alloc(0), { binary: true });
        } catch (error) {
          settle(reject, error);
        }
      });

      ws.on("message", (data) => {
        try {
          const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          if (!raw.trim()) return;

          const message = JSON.parse(raw);
          lastResponse = message;

          const messageError = extractMessageError(message);
          if (messageError) {
            settle(reject, new Error(messageError));
            return;
          }

          if (Array.isArray(message.tokens)) {
            finalText += extractTokensText(message.tokens, true);
            nonFinalText = extractTokensText(message.tokens, false);
          }

          if (message.finished === true || message.type === "finished") {
            resolveTranscript();
          }
        } catch (error) {
          settle(reject, error);
        }
      });

      ws.on("error", (error) => {
        debugLogger.error("Soniox WebSocket error:", error);
        settle(reject, error);
      });

      ws.on("close", () => {
        if (settled) return;
        resolveTranscript();
      });
    });
  }
}

module.exports = SonioxAsrClient;
