const debugLogger = require("./debugLogger");
const fs = require("fs/promises");

const DEFAULT_ENDPOINT = "https://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-3";
const DEFAULT_TIMEOUT_MS = 60_000;
const LONG_AUDIO_CHUNK_THRESHOLD_SEC = 10 * 60;
const LONG_AUDIO_CHUNK_DURATION_SEC = 8 * 60;
const RIFF_UINT32_MAX = 0xffffffff;

function isAllowedDeepgramHost(hostname) {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase();
  return normalized === "deepgram.com" || normalized.endsWith(".deepgram.com");
}

const LANGUAGE_CODE_MAP = {
  zh: "zh",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-hans-cn": "zh-CN",
  "zh-tw": "zh-TW",
  "zh-hant": "zh-TW",
  "zh-hant-tw": "zh-TW",
  "zh-hk": "zh-HK",
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  ja: "ja",
  ko: "ko",
  es: "es",
  fr: "fr",
  de: "de",
  it: "it",
  pt: "pt",
  ru: "ru",
  hi: "hi",
  pl: "pl",
  nl: "nl",
  tr: "tr",
  vi: "vi",
  id: "id",
  th: "th",
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

function roundSeconds(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function parsePcmWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let fmtChunk = null;
  let dataStart = 0;
  let dataSize = 0;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > buffer.length) return null;

    if (chunkId === "fmt ") {
      fmtChunk = Buffer.from(buffer.subarray(chunkStart, chunkEnd));
    } else if (chunkId === "data") {
      dataStart = chunkStart;
      dataSize = chunkSize;
    }

    if (fmtChunk && dataStart > 0) break;
    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmtChunk || dataStart <= 0 || dataSize <= 0 || fmtChunk.length < 16) return null;

  const audioFormat = fmtChunk.readUInt16LE(0);
  const numChannels = fmtChunk.readUInt16LE(2);
  const sampleRate = fmtChunk.readUInt32LE(4);
  const byteRate = fmtChunk.readUInt32LE(8);
  const blockAlign = fmtChunk.readUInt16LE(12);
  const bitsPerSample = fmtChunk.readUInt16LE(14);

  if (audioFormat !== 1) return null;
  if (!numChannels || !sampleRate || !byteRate || !blockAlign || !bitsPerSample) return null;

  return {
    fmtChunk,
    dataStart,
    dataSize,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    durationSec: dataSize / byteRate,
  };
}

function createPcmWavBuffer(fmtChunk, dataChunk) {
  const riffSize = 4 + 8 + fmtChunk.length + 8 + dataChunk.length;
  if (riffSize > RIFF_UINT32_MAX || dataChunk.length > RIFF_UINT32_MAX) {
    throw new Error("Deepgram WAV chunk is too large");
  }

  const buffer = Buffer.alloc(12 + 8 + fmtChunk.length + 8 + dataChunk.length);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(riffSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(fmtChunk.length, 16);
  fmtChunk.copy(buffer, 20);
  const dataHeaderOffset = 20 + fmtChunk.length;
  buffer.write("data", dataHeaderOffset);
  buffer.writeUInt32LE(dataChunk.length, dataHeaderOffset + 4);
  dataChunk.copy(buffer, dataHeaderOffset + 8);
  return buffer;
}

function createPcmWavChunkPlan(buffer) {
  const wav = parsePcmWav(buffer);
  if (!wav || wav.durationSec <= LONG_AUDIO_CHUNK_THRESHOLD_SEC) return null;

  const chunkDataBytes = Math.max(
    wav.blockAlign,
    Math.floor((LONG_AUDIO_CHUNK_DURATION_SEC * wav.byteRate) / wav.blockAlign) * wav.blockAlign
  );
  if (chunkDataBytes <= 0 || wav.dataSize <= chunkDataBytes) return null;

  const chunks = [];
  let dataOffset = 0;

  while (dataOffset < wav.dataSize) {
    const remainingBytes = wav.dataSize - dataOffset;
    const currentDataBytes = Math.min(chunkDataBytes, remainingBytes);
    chunks.push({
      index: chunks.length + 1,
      dataOffset,
      dataBytes: currentDataBytes,
      startSec: dataOffset / wav.byteRate,
      durationSec: currentDataBytes / wav.byteRate,
      audioBytes: 12 + 8 + wav.fmtChunk.length + 8 + currentDataBytes,
    });
    dataOffset += currentDataBytes;
  }

  if (chunks.length < 2) return null;

  return {
    chunks,
    durationSec: wav.durationSec,
    sampleRate: wav.sampleRate,
    bitsPerSample: wav.bitsPerSample,
    dataStart: wav.dataStart,
    fmtChunk: wav.fmtChunk,
    sourceBuffer: buffer,
  };
}

function createAudioBufferForChunk(chunkPlan, chunk) {
  const dataStart = chunkPlan.dataStart + chunk.dataOffset;
  const dataChunk = chunkPlan.sourceBuffer.subarray(dataStart, dataStart + chunk.dataBytes);
  return createPcmWavBuffer(chunkPlan.fmtChunk, dataChunk);
}

function normalizeEndpoint(endpoint) {
  const raw = String(endpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  if (!/^https:\/\//i.test(raw)) {
    throw new Error("Deepgram endpoint must start with https://");
  }
  const url = new URL(raw);
  if (!isAllowedDeepgramHost(url.hostname)) {
    throw new Error("Deepgram endpoint must use a deepgram.com host.");
  }
  return raw;
}

function normalizeApiKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) return "";
  return key.replace(/^Token\s+/i, "").trim();
}

function normalizeLanguage(language) {
  const raw = String(language || "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "auto") return "";
  return LANGUAGE_CODE_MAP[raw] || LANGUAGE_CODE_MAP[raw.split("-")[0]] || raw.split("-")[0];
}

function isMandarinLanguage(language) {
  return ["zh", "zh-CN"].includes(String(language || ""));
}

function createLanguageFallbackAttempts(language) {
  const attempts = [];
  const push = (candidate, reason) => {
    const normalized = normalizeLanguage(candidate);
    const key = normalized || "auto";
    if (attempts.some((attempt) => attempt.key === key)) return;
    attempts.push({
      key,
      language: normalized || "auto",
      resolvedLanguage: normalized || null,
      reason,
    });
  };

  const requestedLanguage = normalizeLanguage(language);
  if (isMandarinLanguage(requestedLanguage)) {
    // Deepgram Nova-3 can return empty transcripts for Mandarin clips when
    // single-language routing is forced. Prefer the multilingual route first,
    // then fall back to explicit Mandarin variants only if needed.
    push("multi", "mandarin-long-audio-primary");
    push(requestedLanguage, "requested");
  } else {
    push(language || "auto", "requested");
  }

  const primaryLanguage = requestedLanguage || attempts[0]?.resolvedLanguage || "";

  if (primaryLanguage === "zh-CN") {
    push("zh", "generic-mandarin");
  } else if (primaryLanguage === "zh") {
    push("zh-CN", "simplified-mandarin");
  }

  if (primaryLanguage && primaryLanguage !== "multi") {
    push("multi", "multilingual");
  }

  if (primaryLanguage) {
    push("auto", "auto-detect");
  }

  return attempts;
}

function buildUrl({ endpoint, model, language }) {
  const url = new URL(normalizeEndpoint(endpoint));
  url.searchParams.set("model", String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL);
  if (!url.searchParams.has("smart_format")) {
    url.searchParams.set("smart_format", "true");
  }
  if (!url.searchParams.has("punctuate")) {
    url.searchParams.set("punctuate", "true");
  }

  const normalizedLanguage = normalizeLanguage(language);
  if (normalizedLanguage) {
    url.searchParams.delete("detect_language");
    url.searchParams.set("language", normalizedLanguage);
  } else if (!url.searchParams.has("language") && !url.searchParams.has("detect_language")) {
    url.searchParams.set("detect_language", "true");
  }

  return url;
}

function extractTranscript(response) {
  const channels = Array.isArray(response?.results?.channels) ? response.results.channels : [];
  return channels
    .map((channel) => channel?.alternatives?.[0]?.transcript)
    .filter((text) => typeof text === "string" && text.trim())
    .map((text) => text.trim())
    .join("\n")
    .trim();
}

function createEmptyResponseMetadata({
  parsed,
  rawText,
  language,
  model,
  audioBytes,
  chunkInfo = null,
}) {
  const channels = parsed?.results?.channels || [];
  const firstChannelAlts = channels[0]?.alternatives || [];

  return {
    requestId: parsed?.metadata?.request_id || null,
    metadataDurationSec: parsed?.metadata?.duration ?? null,
    metadataChannels: parsed?.metadata?.channels ?? null,
    metadataModelInfo: parsed?.metadata?.model_info ?? null,
    metadataModelUuid: parsed?.metadata?.models?.[0] ?? null,
    channelsCount: channels.length,
    firstChannelAltsCount: firstChannelAlts.length,
    firstAlternativeConfidence: firstChannelAlts[0]?.confidence ?? null,
    firstAlternativeWordsCount: Array.isArray(firstChannelAlts[0]?.words)
      ? firstChannelAlts[0].words.length
      : null,
    detectedLanguage: channels[0]?.detected_language || null,
    requestedLanguage: language || null,
    requestedModel: model,
    audioBytes,
    chunkIndex: chunkInfo?.index ?? null,
    chunkCount: chunkInfo?.count ?? null,
    chunkStartSec: chunkInfo ? roundSeconds(chunkInfo.startSec) : null,
    chunkDurationSec: chunkInfo ? roundSeconds(chunkInfo.durationSec) : null,
    languageAttempt: chunkInfo?.languageAttempt ?? null,
    languageAttemptCount: chunkInfo?.languageAttemptCount ?? null,
    languageFallbackReason: chunkInfo?.languageFallbackReason ?? null,
    rawSnippet: rawText ? rawText.slice(0, 1500) : null,
  };
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

class DeepgramAsrClient {
  async transcribe({
    audioBuffer,
    apiKey,
    endpoint,
    model,
    language,
    mimeType,
    timeoutMs,
    onProgress,
    signal,
  }) {
    return this.listen({
      audioBuffer,
      apiKey,
      endpoint,
      model,
      language,
      mimeType,
      timeoutMs,
      allowEmptyText: false,
      onProgress,
      signal,
    });
  }

  async transcribeFile({
    filePath,
    apiKey,
    endpoint,
    model,
    language,
    mimeType,
    timeoutMs,
    onProgress,
    signal,
  }) {
    const audioBuffer = await fs.readFile(filePath, { signal });
    return this.transcribe({
      audioBuffer,
      apiKey,
      endpoint,
      model,
      language,
      mimeType: mimeType || "application/octet-stream",
      timeoutMs,
      onProgress,
      signal,
    });
  }

  async testConnection({ apiKey, endpoint, model, language, timeoutMs }) {
    const result = await this.listen({
      audioBuffer: createSilentWavBuffer(),
      apiKey,
      endpoint,
      model,
      language: language || "auto",
      mimeType: "audio/wav",
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 20_000,
      allowEmptyText: true,
    });

    return {
      ...result,
      resolvedModelId: result.model,
    };
  }

  async listen({
    audioBuffer,
    apiKey,
    endpoint,
    model,
    language,
    mimeType,
    timeoutMs,
    allowEmptyText = false,
    onProgress,
    signal,
  }) {
    const normalizedAudio = toBuffer(audioBuffer);
    const normalizedApiKey = normalizeApiKey(apiKey);
    const resolvedModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const contentType = String(mimeType || "audio/webm").trim() || "audio/webm";
    const requestTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

    if (!normalizedAudio.length) {
      throw new Error("Deepgram audio buffer is empty");
    }
    if (!normalizedApiKey) {
      throw new Error("Deepgram API key not configured");
    }

    const chunkPlan = !allowEmptyText ? createPcmWavChunkPlan(normalizedAudio) : null;
    if (chunkPlan) {
      return this.listenInChunks({
        chunkPlan,
        apiKey: normalizedApiKey,
        endpoint,
        model: resolvedModel,
        language,
        timeoutMs: requestTimeoutMs,
        originalAudioBytes: normalizedAudio.length,
        onProgress,
        signal,
      });
    }

    return this.listenSingle({
      audioBuffer: normalizedAudio,
      apiKey: normalizedApiKey,
      endpoint,
      model: resolvedModel,
      language,
      contentType,
      timeoutMs: requestTimeoutMs,
      allowEmptyText,
      signal,
    });
  }

  async listenInChunks({
    chunkPlan,
    apiKey,
    endpoint,
    model,
    language,
    timeoutMs,
    originalAudioBytes,
    onProgress,
    signal,
  }) {
    if (!apiKey) {
      throw new Error("Deepgram API key not configured");
    }

    debugLogger.info(
      "Deepgram long audio chunking enabled",
      {
        durationSec: roundSeconds(chunkPlan.durationSec),
        chunkCount: chunkPlan.chunks.length,
        chunkDurationSec: LONG_AUDIO_CHUNK_DURATION_SEC,
        sampleRate: chunkPlan.sampleRate,
        bitsPerSample: chunkPlan.bitsPerSample,
        originalAudioBytes,
      },
      "transcription"
    );
    onProgress?.({
      type: "chunk-plan",
      chunkCount: chunkPlan.chunks.length,
      durationSec: chunkPlan.durationSec,
      chunkDurationSec: LONG_AUDIO_CHUNK_DURATION_SEC,
    });

    const languageAttempts = createLanguageFallbackAttempts(language);
    const attemptedLanguages = languageAttempts.map((languageAttempt) => ({
      language: languageAttempt.resolvedLanguage || "auto",
      reason: languageAttempt.reason,
    }));
    const chunkResults = [];
    const requestIds = [];
    const emptyChunks = [];

    for (const chunk of chunkPlan.chunks) {
      signal?.throwIfAborted?.();
      const chunkRequestIds = [];
      const emptyAttempts = [];
      let chunkResult = null;

      for (let attemptIndex = 0; attemptIndex < languageAttempts.length; attemptIndex++) {
        signal?.throwIfAborted?.();
        const languageAttempt = languageAttempts[attemptIndex];

        if (attemptIndex > 0) {
          debugLogger.warn(
            "Deepgram chunk transcription retrying with fallback language",
            {
              chunkIndex: chunk.index,
              chunkCount: chunkPlan.chunks.length,
              fallbackLanguage: languageAttempt.resolvedLanguage || "auto",
              fallbackReason: languageAttempt.reason,
              languageAttempt: attemptIndex + 1,
              languageAttemptCount: languageAttempts.length,
            },
            "transcription"
          );
        }

        const chunkInfo = {
          index: chunk.index,
          count: chunkPlan.chunks.length,
          startSec: chunk.startSec,
          durationSec: chunk.durationSec,
          languageAttempt: attemptIndex + 1,
          languageAttemptCount: languageAttempts.length,
          languageFallbackReason: languageAttempt.reason,
        };

        let result;
        try {
          result = await this.listenSingle({
            audioBuffer: createAudioBufferForChunk(chunkPlan, chunk),
            apiKey,
            endpoint,
            model,
            language: languageAttempt.language,
            contentType: "audio/wav",
            timeoutMs,
            allowEmptyText: true,
            chunkInfo,
            signal,
          });
        } catch (error) {
          if (attemptIndex === 0) {
            throw error;
          }

          debugLogger.warn(
            "Deepgram chunk transcription fallback failed",
            {
              chunkIndex: chunk.index,
              chunkCount: chunkPlan.chunks.length,
              fallbackLanguage: languageAttempt.resolvedLanguage || "auto",
              fallbackReason: languageAttempt.reason,
              languageAttempt: attemptIndex + 1,
              languageAttemptCount: languageAttempts.length,
              error: error instanceof Error ? error.message : String(error),
            },
            "transcription"
          );
          continue;
        }

        if (result.requestId) {
          requestIds.push(result.requestId);
          chunkRequestIds.push(result.requestId);
        }

        if (result.text) {
          chunkResult = {
            ...result,
            chunkIndex: chunk.index,
            chunkStartSec: chunk.startSec,
            chunkDurationSec: chunk.durationSec,
            languageAttempt: attemptIndex + 1,
            languageFallbackReason: languageAttempt.reason,
          };
          debugLogger.debug(
            "Deepgram chunk transcribed",
            {
              chunkIndex: chunk.index,
              chunkCount: chunkPlan.chunks.length,
              chunkStartSec: roundSeconds(chunk.startSec),
              chunkDurationSec: roundSeconds(chunk.durationSec),
              textLength: result.text.length,
              requestId: result.requestId,
              languageAttempt: attemptIndex + 1,
              languageAttemptCount: languageAttempts.length,
              languageFallbackReason: languageAttempt.reason,
              requestedLanguage: languageAttempt.resolvedLanguage || "auto",
            },
            "transcription"
          );
          break;
        }

        emptyAttempts.push({
          language: languageAttempt.resolvedLanguage || "auto",
          reason: languageAttempt.reason,
          requestId: result.requestId || null,
        });
      }

      if (chunkResult) {
        chunkResults.push(chunkResult);
      } else {
        emptyChunks.push({
          index: chunk.index,
          startSec: roundSeconds(chunk.startSec),
          durationSec: roundSeconds(chunk.durationSec),
          requestIds: chunkRequestIds,
          attempts: emptyAttempts,
        });
      }

      onProgress?.({
        type: "chunk-complete",
        chunkIndex: chunk.index,
        chunkCount: chunkPlan.chunks.length,
        completedChunks: chunk.index,
        chunkStartSec: chunk.startSec,
        chunkDurationSec: chunk.durationSec,
        hasText: Boolean(chunkResult?.text),
        languageAttempt: chunkResult?.languageAttempt ?? languageAttempts.length,
        languageAttemptCount: languageAttempts.length,
        languageFallbackReason:
          chunkResult?.languageFallbackReason ||
          languageAttempts[languageAttempts.length - 1]?.reason ||
          null,
      });
    }

    if (emptyChunks.length > 0) {
      debugLogger.warn(
        "Deepgram chunked transcription completed with empty chunks",
        {
          chunkCount: chunkPlan.chunks.length,
          emptyChunks,
          attemptedLanguages,
        },
        "transcription"
      );
    }

    const text = chunkResults
      .map((result) => result.text)
      .filter((chunkText) => typeof chunkText === "string" && chunkText.trim())
      .join("\n\n")
      .trim();

    if (!text) {
      debugLogger.warn(
        "Deepgram chunked transcription empty after language fallbacks",
        {
          chunkCount: chunkPlan.chunks.length,
          emptyChunks,
          attemptedLanguages,
          requestIds,
        },
        "transcription"
      );
      throw new Error("No text transcribed - Deepgram chunked response was empty");
    }

    debugLogger.info(
      "Deepgram chunked transcription complete",
      {
        chunkCount: chunkPlan.chunks.length,
        transcribedChunks: chunkResults.length,
        emptyChunks,
        attemptedLanguages,
        textLength: text.length,
      },
      "transcription"
    );

    return {
      text,
      model,
      requestId: requestIds[0] || null,
      requestIds,
      emptyChunks,
      chunkCount: chunkPlan.chunks.length,
      transcribedChunks: chunkResults.length,
      detectedLanguage:
        chunkResults.find((result) => result.detectedLanguage)?.detectedLanguage || null,
    };
  }

  async listenSingle({
    audioBuffer,
    apiKey,
    endpoint,
    model,
    language,
    contentType,
    timeoutMs,
    allowEmptyText,
    chunkInfo = null,
    signal,
  }) {
    const url = buildUrl({ endpoint, model, language });
    debugLogger.debug(
      "Deepgram STT request",
      {
        endpointHost: url.host,
        model,
        language: url.searchParams.get("language") || null,
        detectLanguage: url.searchParams.get("detect_language") || null,
        audioBytes: audioBuffer.length,
        contentType,
        chunkIndex: chunkInfo?.index ?? null,
        chunkCount: chunkInfo?.count ?? null,
        chunkStartSec: chunkInfo ? roundSeconds(chunkInfo.startSec) : null,
        chunkDurationSec: chunkInfo ? roundSeconds(chunkInfo.durationSec) : null,
        languageAttempt: chunkInfo?.languageAttempt ?? null,
        languageAttemptCount: chunkInfo?.languageAttemptCount ?? null,
        languageFallbackReason: chunkInfo?.languageFallbackReason ?? null,
      },
      "transcription"
    );

    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": contentType,
        },
        body: audioBuffer,
        signal,
      },
      timeoutMs
    );
    const rawText = await response.text();
    let parsed = null;

    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const message =
        parsed?.err_msg ||
        parsed?.message ||
        parsed?.error ||
        rawText ||
        `Deepgram API error: ${response.status}`;
      const code = parsed?.err_code || parsed?.code;
      const errorId = code ? `${response.status} ${code}` : String(response.status);
      throw new Error(`Deepgram ${errorId}: ${message}`);
    }

    const text = extractTranscript(parsed);
    if (!text && !allowEmptyText) {
      // Long sync requests (~25min+) sometimes return 200 OK with no transcript.
      // Dump the response shape so we can tell apart: silent audio, language
      // mismatch, sync-endpoint length limit, or Deepgram-side processing error.
      debugLogger.warn(
        "Deepgram returned empty transcript - dumping response metadata",
        createEmptyResponseMetadata({
          parsed,
          rawText,
          language,
          model,
          audioBytes: audioBuffer.length,
          chunkInfo,
        }),
        "transcription"
      );
      throw new Error("No text transcribed - Deepgram response was empty");
    }

    if (!text && allowEmptyText && chunkInfo) {
      debugLogger.warn(
        "Deepgram chunk returned empty transcript",
        createEmptyResponseMetadata({
          parsed,
          rawText,
          language,
          model,
          audioBytes: audioBuffer.length,
          chunkInfo,
        }),
        "transcription"
      );
    }

    return {
      text,
      model,
      requestId: parsed?.metadata?.request_id || null,
      detectedLanguage: parsed?.results?.channels?.[0]?.detected_language || null,
    };
  }
}

module.exports = DeepgramAsrClient;
