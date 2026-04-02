const crypto = require("crypto");
const zlib = require("zlib");
const WebSocket = require("ws");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

const MESSAGE_TYPES = {
  FULL_CLIENT_REQUEST: 0x1,
  AUDIO_ONLY_REQUEST: 0x2,
  FULL_SERVER_RESPONSE: 0x9,
  ERROR_RESPONSE: 0xf,
};

const MESSAGE_FLAGS = {
  NONE: 0x0,
  LAST_AUDIO_PACKET: 0x2,
  POSITIVE_SEQUENCE: 0x1,
  NEGATIVE_SEQUENCE: 0x3,
};

const SERIALIZATION = {
  NONE: 0x0,
  JSON: 0x1,
};

const COMPRESSION = {
  NONE: 0x0,
  GZIP: 0x1,
};

const AUDIO_CHUNK_SIZE_BYTES = 6400;
const AUDIO_SEND_INTERVAL_MS = 2;
const DEFAULT_TIMEOUT_MS = 45_000;
const DOUBAO_ASR_WS_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";

const DOUBAO_MODEL_CONFIGS = {
  "doubao-streaming-auto": {
    resourceIds: [
      "volc.seedasr.sauc.duration",
      "volc.seedasr.sauc.concurrent",
      "volc.bigasr.sauc.duration",
      "volc.bigasr.sauc.concurrent",
    ],
  },
  "doubao-seedasr-streaming-2.0": {
    resourceIds: ["volc.seedasr.sauc.duration", "volc.seedasr.sauc.concurrent"],
  },
  "doubao-bigasr-streaming-1.0": {
    resourceIds: ["volc.bigasr.sauc.duration", "volc.bigasr.sauc.concurrent"],
  },
};

const DOUBAO_LANGUAGE_MAP = {
  zh: "zh-CN",
  en: "en-US",
  ja: "ja-JP",
  id: "id-ID",
  es: "es-MX",
  pt: "pt-BR",
  de: "de-DE",
  fr: "fr-FR",
  ko: "ko-KR",
  fil: "fil-PH",
  ms: "ms-MY",
  th: "th-TH",
  ar: "ar-SA",
  it: "it-IT",
  bn: "bn-BD",
  el: "el-GR",
  nl: "nl-NL",
  ru: "ru-RU",
  tr: "tr-TR",
  vi: "vi-VN",
  pl: "pl-PL",
  ro: "ro-RO",
  ne: "ne-NP",
  uk: "uk-UA",
  yue: "yue-CN",
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

function gzipBuffer(buffer) {
  return zlib.gzipSync(buffer);
}

function gunzipBuffer(buffer) {
  return zlib.gunzipSync(buffer);
}

function buildHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    0x11,
    ((messageType & 0x0f) << 4) | (flags & 0x0f),
    ((serialization & 0x0f) << 4) | (compression & 0x0f),
    0x00,
  ]);
}

function buildPayloadFrame({ header, payload, includeSequence = false, sequence = 0 }) {
  const parts = [header];

  if (includeSequence) {
    const sequenceBuffer = Buffer.alloc(4);
    sequenceBuffer.writeInt32BE(sequence, 0);
    parts.push(sequenceBuffer);
  }

  const payloadSizeBuffer = Buffer.alloc(4);
  payloadSizeBuffer.writeUInt32BE(payload.length, 0);
  parts.push(payloadSizeBuffer, payload);

  return Buffer.concat(parts);
}

function buildFullClientRequest(payloadObject) {
  const payload = gzipBuffer(Buffer.from(JSON.stringify(payloadObject), "utf8"));
  return buildPayloadFrame({
    header: buildHeader(
      MESSAGE_TYPES.FULL_CLIENT_REQUEST,
      MESSAGE_FLAGS.NONE,
      SERIALIZATION.JSON,
      COMPRESSION.GZIP
    ),
    payload,
  });
}

function buildAudioOnlyRequest(audioChunk, isFinalChunk) {
  const payload = gzipBuffer(audioChunk);
  return buildPayloadFrame({
    header: buildHeader(
      MESSAGE_TYPES.AUDIO_ONLY_REQUEST,
      isFinalChunk ? MESSAGE_FLAGS.LAST_AUDIO_PACKET : MESSAGE_FLAGS.NONE,
      SERIALIZATION.NONE,
      COMPRESSION.GZIP
    ),
    payload,
  });
}

function maybeDecompressPayload(buffer, compression) {
  if (compression === COMPRESSION.GZIP) {
    return gunzipBuffer(buffer);
  }
  return buffer;
}

function parseFrame(data) {
  const buffer = toBuffer(data);
  if (buffer.length < 8) {
    throw new Error("Doubao ASR frame too short");
  }

  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = (buffer[1] & 0xf0) >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = (buffer[2] & 0xf0) >> 4;
  const compression = buffer[2] & 0x0f;

  let offset = headerSize;
  let sequence = null;

  if (
    messageType === MESSAGE_TYPES.FULL_SERVER_RESPONSE &&
    (flags === MESSAGE_FLAGS.POSITIVE_SEQUENCE || flags === MESSAGE_FLAGS.NEGATIVE_SEQUENCE)
  ) {
    sequence = buffer.readInt32BE(offset);
    offset += 4;
  }

  if (messageType === MESSAGE_TYPES.ERROR_RESPONSE) {
    const errorCode = buffer.readUInt32BE(offset);
    offset += 4;
    const errorSize = buffer.readUInt32BE(offset);
    offset += 4;
    const errorPayload = buffer.subarray(offset, offset + errorSize);
    const message = errorPayload.toString("utf8");

    return {
      messageType,
      flags,
      errorCode,
      errorMessage: message,
      sequence,
    };
  }

  const payloadSize = buffer.readUInt32BE(offset);
  offset += 4;
  const payloadBuffer = buffer.subarray(offset, offset + payloadSize);
  const decodedPayload = maybeDecompressPayload(payloadBuffer, compression);

  let payload = decodedPayload;
  if (serialization === SERIALIZATION.JSON) {
    payload = JSON.parse(decodedPayload.toString("utf8"));
  }

  return {
    messageType,
    flags,
    serialization,
    compression,
    sequence,
    payload,
  };
}

function splitAudioBuffer(audioBuffer, chunkSize = AUDIO_CHUNK_SIZE_BYTES) {
  const chunks = [];
  for (let offset = 0; offset < audioBuffer.length; offset += chunkSize) {
    chunks.push(audioBuffer.subarray(offset, Math.min(audioBuffer.length, offset + chunkSize)));
  }
  return chunks;
}

function normalizeDoubaoLanguage(language) {
  const raw = String(language || "").trim();
  if (!raw || raw === "auto") return undefined;
  if (raw.includes("-")) return raw;
  return DOUBAO_LANGUAGE_MAP[raw] || undefined;
}

function buildFullClientPayload({ requestId, language }) {
  const resolvedLanguage = normalizeDoubaoLanguage(language);

  return {
    user: {
      uid: requestId,
      did: "chordvox-desktop",
      platform: process.platform,
      sdk_version: "chordvox-electron",
      app_version: app.getVersion(),
    },
    audio: {
      format: "wav",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
      ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
    },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      show_utterances: false,
    },
  };
}

function sendFrame(ws, frame) {
  return new Promise((resolve, reject) => {
    ws.send(frame, { binary: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function inferModelIdFromResourceId(resourceId) {
  if (String(resourceId || "").includes("seedasr")) {
    return "doubao-seedasr-streaming-2.0";
  }
  if (String(resourceId || "").includes("bigasr")) {
    return "doubao-bigasr-streaming-1.0";
  }
  return "doubao-streaming-auto";
}

async function streamAudioFrames(ws, audioBuffer) {
  const chunks = splitAudioBuffer(audioBuffer);
  if (chunks.length === 0) {
    throw new Error("Doubao ASR audio buffer is empty");
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const isFinalChunk = index === chunks.length - 1;
    await sendFrame(ws, buildAudioOnlyRequest(chunks[index], isFinalChunk));
    if (!isFinalChunk) {
      await wait(AUDIO_SEND_INTERVAL_MS);
    }
  }
}

class DoubaoAsrClient {
  getModelConfig(modelId) {
    return DOUBAO_MODEL_CONFIGS[modelId] || DOUBAO_MODEL_CONFIGS["doubao-streaming-auto"];
  }

  async transcribe({ audioBuffer, appId, accessToken, model, language, timeoutMs }) {
    const normalizedAudio = toBuffer(audioBuffer);
    const normalizedAppId = String(appId || "").trim();
    const normalizedToken = String(accessToken || "").trim();

    if (!normalizedAudio.length) {
      throw new Error("Doubao ASR audio buffer is empty");
    }
    if (!normalizedAppId) {
      throw new Error("Doubao APP ID not configured");
    }
    if (!normalizedToken) {
      throw new Error("Doubao Access Token not configured");
    }

    const requestTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const modelConfig = this.getModelConfig(model);
    const errors = [];

    for (const resourceId of modelConfig.resourceIds) {
      try {
        return await this.transcribeWithResourceId({
          audioBuffer: normalizedAudio,
          appId: normalizedAppId,
          accessToken: normalizedToken,
          resourceId,
          language,
          timeoutMs: requestTimeoutMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${resourceId}: ${message}`);
      }
    }

    throw new Error(`Doubao ASR failed: ${errors.join(" | ")}`);
  }

  async testConnection({ appId, accessToken, model, language, timeoutMs }) {
    const normalizedAppId = String(appId || "").trim();
    const normalizedToken = String(accessToken || "").trim();

    if (!normalizedAppId) {
      throw new Error("Doubao APP ID not configured");
    }
    if (!normalizedToken) {
      throw new Error("Doubao Access Token not configured");
    }

    const requestTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const modelConfig = this.getModelConfig(model);
    const errors = [];

    for (const resourceId of modelConfig.resourceIds) {
      try {
        const result = await this.probeResourceId({
          appId: normalizedAppId,
          accessToken: normalizedToken,
          resourceId,
          language,
          timeoutMs: requestTimeoutMs,
        });

        return {
          ...result,
          resolvedModelId: inferModelIdFromResourceId(resourceId),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${resourceId}: ${message}`);
      }
    }

    throw new Error(`Doubao ASR connection test failed: ${errors.join(" | ")}`);
  }

  probeResourceId({ appId, accessToken, resourceId, language, timeoutMs }) {
    const connectId = crypto.randomUUID();
    const headers = {
      "X-Api-App-Key": appId,
      "X-Api-Access-Key": accessToken,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Connect-Id": connectId,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let logId = null;

      const ws = new WebSocket(DOUBAO_ASR_WS_URL, { headers });

      const finalize = (handler, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        try {
          ws.close();
        } catch {}
        handler(value);
      };

      const timeoutHandle = setTimeout(() => {
        finalize(
          reject,
          new Error(`Doubao ASR connection test timed out after ${Math.round(timeoutMs / 1000)}s`)
        );
      }, timeoutMs);

      ws.on("upgrade", (response) => {
        logId = response?.headers?.["x-tt-logid"] || null;
      });

      ws.on("unexpected-response", (_, response) => {
        const statusCode = response?.statusCode || "unknown";
        finalize(
          reject,
          new Error(`Doubao ASR handshake failed (${statusCode}) for resource ${resourceId}`)
        );
      });

      ws.on("open", async () => {
        try {
          await sendFrame(
            ws,
            buildFullClientRequest(
              buildFullClientPayload({
                requestId: connectId,
                language,
              })
            )
          );
        } catch (error) {
          finalize(reject, error);
        }
      });

      ws.on("message", (rawData) => {
        let frame;

        try {
          frame = parseFrame(rawData);
        } catch (error) {
          finalize(reject, error);
          return;
        }

        if (frame.messageType === MESSAGE_TYPES.ERROR_RESPONSE) {
          finalize(
            reject,
            new Error(
              `Doubao ASR error ${frame.errorCode || "UNKNOWN"}: ${frame.errorMessage || "Unknown error"}`
            )
          );
          return;
        }

        if (frame.messageType !== MESSAGE_TYPES.FULL_SERVER_RESPONSE) {
          return;
        }

        finalize(resolve, {
          ok: true,
          logId,
          resourceId,
          connectId,
        });
      });

      ws.on("close", (code, reasonBuffer) => {
        if (settled) return;

        const reason = Buffer.isBuffer(reasonBuffer)
          ? reasonBuffer.toString("utf8")
          : String(reasonBuffer || "");

        finalize(
          reject,
          new Error(
            `Doubao ASR socket closed during connection test (code: ${code}${reason ? `, reason: ${reason}` : ""})`
          )
        );
      });

      ws.on("error", (error) => {
        finalize(reject, error);
      });
    });
  }

  transcribeWithResourceId({ audioBuffer, appId, accessToken, resourceId, language, timeoutMs }) {
    const connectId = crypto.randomUUID();
    const headers = {
      "X-Api-App-Key": appId,
      "X-Api-Access-Key": accessToken,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Connect-Id": connectId,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let handshakeAccepted = false;
      let audioSending = false;
      let audioSent = false;
      let latestText = "";
      let logId = null;

      const ws = new WebSocket(DOUBAO_ASR_WS_URL, { headers });

      const finalize = (handler, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        try {
          ws.close();
        } catch {}
        handler(value);
      };

      const timeoutHandle = setTimeout(() => {
        finalize(reject, new Error(`Doubao ASR timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      ws.on("upgrade", (response) => {
        logId = response?.headers?.["x-tt-logid"] || null;
        debugLogger.debug("Doubao ASR websocket upgraded", { resourceId, logId, connectId });
      });

      ws.on("unexpected-response", (_, response) => {
        const statusCode = response?.statusCode || "unknown";
        finalize(
          reject,
          new Error(`Doubao ASR handshake failed (${statusCode}) for resource ${resourceId}`)
        );
      });

      ws.on("open", async () => {
        try {
          await sendFrame(
            ws,
            buildFullClientRequest(
              buildFullClientPayload({
                requestId: connectId,
                language,
              })
            )
          );
        } catch (error) {
          finalize(reject, error);
        }
      });

      ws.on("message", async (rawData) => {
        let frame;

        try {
          frame = parseFrame(rawData);
        } catch (error) {
          finalize(reject, error);
          return;
        }

        if (frame.messageType === MESSAGE_TYPES.ERROR_RESPONSE) {
          finalize(
            reject,
            new Error(
              `Doubao ASR error ${frame.errorCode || "UNKNOWN"}: ${frame.errorMessage || "Unknown error"}`
            )
          );
          return;
        }

        if (frame.messageType !== MESSAGE_TYPES.FULL_SERVER_RESPONSE) {
          return;
        }

        const text = frame.payload?.result?.text;
        if (typeof text === "string" && text.trim()) {
          latestText = text.trim();
        }

        if (!handshakeAccepted) {
          handshakeAccepted = true;
          if (!audioSending) {
            audioSending = true;
            try {
              await streamAudioFrames(ws, audioBuffer);
              audioSent = true;
            } catch (error) {
              finalize(reject, error);
            }
          }
          return;
        }

        if (frame.flags === MESSAGE_FLAGS.NEGATIVE_SEQUENCE) {
          if (!latestText) {
            finalize(
              reject,
              new Error(`Doubao ASR returned an empty transcript${logId ? ` (logid: ${logId})` : ""}`)
            );
            return;
          }

          finalize(resolve, { text: latestText, logId, resourceId, connectId });
        }
      });

      ws.on("close", (code, reasonBuffer) => {
        if (settled) return;

        const reason = Buffer.isBuffer(reasonBuffer)
          ? reasonBuffer.toString("utf8")
          : String(reasonBuffer || "");

        if (audioSent && latestText) {
          finalize(resolve, { text: latestText, logId, resourceId, connectId });
          return;
        }

        finalize(
          reject,
          new Error(
            `Doubao ASR socket closed before completion (code: ${code}${reason ? `, reason: ${reason}` : ""})`
          )
        );
      });

      ws.on("error", (error) => {
        finalize(reject, error);
      });
    });
  }
}

module.exports = DoubaoAsrClient;
