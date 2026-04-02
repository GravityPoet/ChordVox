import ReasoningService from "../services/ReasoningService";
import {
  API_ENDPOINTS,
  buildApiUrl,
  normalizeBaseUrl,
} from "../config/constants";
import { getSystemPrompt } from "../config/prompts";
import logger from "../utils/logger";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { isSecureEndpoint } from "../utils/urlUtils";
import { withSessionRefresh } from "../lib/neonAuth";
import { getBaseLanguageCode, validateLanguageForModel } from "../utils/languageSupport";
import { hasStoredByokKey } from "../utils/byokDetection";
import {
  CHORDVOX_CLOUD_MODE,
  CHORDVOX_CLOUD_MODEL,
  CHORDVOX_CLOUD_PROVIDER,
  CHORDVOX_CLOUD_SOURCE,
  isChordVoxCloudMode,
  normalizeChordVoxCloudMode,
  normalizeChordVoxProvider,
} from "../utils/chordvoxCloud";
import streamingModels from "../config/streamingModels.json";

const SHORT_CLIP_DURATION_SECONDS = 2.5;
const REASONING_CACHE_TTL = 30000; // 30 seconds
const PRO_ACCESS_CACHE_TTL = 5000; // 5 seconds
const TRANSCRIPTION_TIMEOUT_MS = 60_000; // 60 seconds — default transcription timeout
const LOCAL_STREAMING_INITIAL_SILENCE_TIMEOUT_MS = 12000;
const SECONDARY_HOTKEY_PROFILE_KEY = "secondaryHotkeyProfile";
const DEFAULT_STREAMING_MODEL_ID =
  streamingModels.find((model) => model.default)?.id || streamingModels[0]?.id;
const DEFAULT_CLOUD_REASONING_MODE = "byok";

function withTimeout(
  promise,
  ms,
  label = "Operation"
) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `${label} timed out after ${Math.round(ms / 1000)}s. Check your network connection or try a smaller audio clip.`
      );
      err.code = "TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isLikelyLocalPath(value) {
  const raw = String(value || "").trim();
  return raw.includes("/") || raw.includes("\\");
}

const PLACEHOLDER_KEYS = {
  openai: "your_openai_api_key_here",
  groq: "your_groq_api_key_here",
};

const isValidApiKey = (key, provider = "openai") => {
  if (!key || key.trim() === "") return false;
  const placeholder = PLACEHOLDER_KEYS[provider] || PLACEHOLDER_KEYS.openai;
  return key !== placeholder;
};

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onAudioLevel = null;
    this.onProgress = null;
    this.lastLocalStreamingStartFailure = null;
    this.recordingLevelContext = null;
    this.recordingLevelSource = null;
    this.recordingAnalyser = null;
    this.recordingLevelFrame = null;
    this.recordingLevelData = null;
    this.cachedApiKey = null;
    this.cachedApiKeyProvider = null;

    this._onApiKeyChanged = () => {
      this.cachedApiKey = null;
      this.cachedApiKeyProvider = null;
    };
    window.addEventListener("api-key-changed", this._onApiKeyChanged);
    this.cachedTranscriptionEndpoint = null;
    this.cachedEndpointProvider = null;
    this.cachedEndpointBaseUrl = null;
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this.proAccessCache = { value: true, expiresAt: 0, status: null };
    this.isStreaming = false;
    this.streamingAudioContext = null;
    this.streamingSource = null;
    this.streamingProcessor = null;
    this.streamingStream = null;
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    this.streamingTextDebounce = null;
    this.cachedMicDeviceId = null;
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this.streamingStartInProgress = false;
    this.stopRequestedDuringStreamingStart = false;
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this.streamingAutoStopTimer = null;
    this.streamingHasRecognizedSpeech = false;
    this.streamingAutoStopTriggered = false;
    this.activeHotkeyProfileId = "primary";
    this.currentTraceId = null;
    this.currentTraceStartedAt = null;
    this.progressState = {
      current: 0,
      target: 0,
      stage: "idle",
      timer: null,
    };
  }

  getWorkletBlobUrl() {
    if (this.workletBlobUrl) return this.workletBlobUrl;
    const code = `
const BUFFER_SIZE = 800;
class PCMStreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this._sumSquares = 0;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          const rms = Math.sqrt(this._sumSquares / this._offset);
          this.port.postMessage({ type: "audio-data", buffer: partial.buffer, level: rms }, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
          this._sumSquares = 0;
        }
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._sumSquares += s * s;
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        const rms = Math.sqrt(this._sumSquares / BUFFER_SIZE);
        this.port.postMessage({ type: "audio-data", buffer: this._buffer.buffer, level: rms }, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
        this._sumSquares = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-streaming-processor", PCMStreamingProcessor);
`;
    this.workletBlobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return this.workletBlobUrl;
  }

  getCustomDictionaryPrompt() {
    try {
      const raw = localStorage.getItem("customDictionary");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.join(", ");
    } catch {
      // ignore parse errors
    }
    return null;
  }

  setCallbacks({
    onStateChange,
    onError,
    onTranscriptionComplete,
    onPartialTranscript,
    onAudioLevel,
    onProgress,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onPartialTranscript = onPartialTranscript;
    this.onAudioLevel = onAudioLevel;
    this.onProgress = onProgress;
  }

  normalizeAudioLevel(rms = 0) {
    const numeric = Number(rms);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return 0;
    }

    const noiseFloor = 0.006;
    const ceiling = 0.12;
    const normalized = Math.max(0, Math.min(1, (numeric - noiseFloor) / (ceiling - noiseFloor)));
    return Math.pow(normalized, 0.65);
  }

  emitAudioLevel(rms = 0) {
    this.onAudioLevel?.(this.normalizeAudioLevel(rms));
  }

  getLastLocalStreamingStartFailure() {
    return this.lastLocalStreamingStartFailure;
  }

  stopRecordingLevelMonitor() {
    if (this.recordingLevelFrame) {
      cancelAnimationFrame(this.recordingLevelFrame);
      this.recordingLevelFrame = null;
    }

    if (this.recordingLevelSource) {
      try {
        this.recordingLevelSource.disconnect();
      } catch {
        // ignore
      }
      this.recordingLevelSource = null;
    }

    if (this.recordingAnalyser) {
      try {
        this.recordingAnalyser.disconnect?.();
      } catch {
        // ignore
      }
      this.recordingAnalyser = null;
    }

    if (this.recordingLevelContext && this.recordingLevelContext.state !== "closed") {
      this.recordingLevelContext.close().catch(() => {});
    }
    this.recordingLevelContext = null;
    this.recordingLevelData = null;
    this.emitAudioLevel(0);
  }

  startRecordingLevelMonitor(stream) {
    this.stopRecordingLevelMonitor();

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        return;
      }

      const context = new AudioCtx();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.78;

      const data = new Float32Array(analyser.fftSize);
      source.connect(analyser);

      this.recordingLevelContext = context;
      this.recordingLevelSource = source;
      this.recordingAnalyser = analyser;
      this.recordingLevelData = data;

      const tick = () => {
        if (!this.recordingAnalyser || !this.recordingLevelData || !this.isRecording) {
          this.recordingLevelFrame = null;
          return;
        }

        this.recordingAnalyser.getFloatTimeDomainData(this.recordingLevelData);
        let sumSquares = 0;
        for (let i = 0; i < this.recordingLevelData.length; i += 1) {
          const sample = this.recordingLevelData[i];
          sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / this.recordingLevelData.length);
        this.emitAudioLevel(rms);
        this.recordingLevelFrame = requestAnimationFrame(tick);
      };

      this.recordingLevelFrame = requestAnimationFrame(tick);
    } catch (error) {
      logger.debug(
        "Recording level monitor unavailable",
        { error: error?.message || String(error) },
        "audio"
      );
      this.stopRecordingLevelMonitor();
    }
  }

  emitStateChange(overrides = {}) {
    this.onStateChange?.({
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      ...overrides,
    });
  }

  clearProgressTimer() {
    if (this.progressState.timer) {
      clearTimeout(this.progressState.timer);
      this.progressState.timer = null;
    }
  }

  resetProgressState() {
    this.clearProgressTimer();
    this.progressState = {
      current: 0,
      target: 0,
      stage: "idle",
      timer: null,
    };
  }

  getProgressAnimationConfig(stage) {
    switch (stage) {
      case "preparing":
        return { step: 2, delayMs: 90 };
      case "transcribing":
        return { step: 1, delayMs: 170 };
      case "enhancing":
        return { step: 1, delayMs: 220 };
      case "saving":
        return { step: 2, delayMs: 120 };
      default:
        return { step: 2, delayMs: 120 };
    }
  }

  scheduleProgressAnimation() {
    if (this.progressState.timer) {
      return;
    }

    const tick = () => {
      this.progressState.timer = null;

      if (this.progressState.stage === "idle") {
        return;
      }

      const remaining = this.progressState.target - this.progressState.current;
      if (remaining <= 0) {
        return;
      }

      const { step, delayMs } = this.getProgressAnimationConfig(this.progressState.stage);
      const dynamicStep = remaining > step * 6 ? step + 1 : step;
      this.progressState.current = Math.min(
        this.progressState.target,
        this.progressState.current + dynamicStep
      );

      this.onProgress?.({
        progress: this.progressState.current,
        stage: this.progressState.stage,
      });

      if (this.progressState.current < this.progressState.target) {
        this.progressState.timer = setTimeout(tick, delayMs);
      }
    };

    this.progressState.timer = setTimeout(tick, 60);
  }

  emitProgress(progress, stage = "idle") {
    const normalizedProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
    if (stage === "idle" && normalizedProgress === 0) {
      this.resetProgressState();
      this.onProgress?.({ progress: 0, stage: "idle" });
      return;
    }

    if (stage === "complete" || normalizedProgress >= 100) {
      this.clearProgressTimer();
      this.progressState.current = 100;
      this.progressState.target = 100;
      this.progressState.stage = "complete";
      this.onProgress?.({
        progress: 100,
        stage: "complete",
      });
      return;
    }

    this.progressState.stage = stage;
    this.progressState.target = Math.max(
      this.progressState.current,
      this.progressState.target,
      normalizedProgress
    );

    if (this.progressState.current === 0 && normalizedProgress > 0) {
      this.progressState.current = Math.min(2, normalizedProgress);
      this.onProgress?.({
        progress: this.progressState.current,
        stage,
      });
    }

    this.scheduleProgressAnimation();
  }

  setActiveHotkeyProfile(profileId = "primary") {
    this.activeHotkeyProfileId = profileId === "secondary" ? "secondary" : "primary";
  }

  getActiveHotkeyProfile() {
    if (this.activeHotkeyProfileId !== "secondary") {
      return null;
    }
    try {
      const raw = localStorage.getItem(SECONDARY_HOTKEY_PROFILE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  getSettingValue(key, fallback = "") {
    const profile = this.getActiveHotkeyProfile();
    if (profile && Object.prototype.hasOwnProperty.call(profile, key)) {
      const value = profile[key];
      if (value === null || value === undefined || value === "") {
        return fallback;
      }
      return value;
    }
    const value = localStorage.getItem(key);
    if (value === null || value === undefined || value === "") {
      return fallback;
    }
    return value;
  }

  getBooleanSetting(key, fallback = false) {
    const value = this.getSettingValue(key, fallback ? "true" : "false");
    if (typeof value === "boolean") {
      return value;
    }
    return value === "true";
  }

  getStringSetting(key, fallback = "") {
    const value = this.getSettingValue(key, fallback);
    return typeof value === "string" ? value : String(value);
  }

  ensureTraceContext() {
    if (this.currentTraceId) {
      return { runId: this.currentTraceId, created: false };
    }
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.currentTraceId = runId;
    this.currentTraceStartedAt = Date.now();
    return { runId, created: true };
  }

  emitCallTrace(phase, status, details = {}, options = {}) {
    const runId = options.runId || this.currentTraceId || this.ensureTraceContext().runId;
    const payload = {
      runId,
      profileId: this.activeHotkeyProfileId,
      phase,
      status,
      ...details,
    };

    if (typeof logger.write === "function") {
      logger.write(status === "error" ? "error" : "info", "CALL_TRACE", payload, "call-trace", "renderer");
    } else {
      const level = status === "error" ? "error" : "info";
      if (logger[level]) {
        logger[level]("CALL_TRACE", payload, "call-trace");
      }
    }

    return runId;
  }

  clearTraceContext() {
    this.currentTraceId = null;
    this.currentTraceStartedAt = null;
  }

  finalizeTrace(status, details = {}) {
    if (!this.currentTraceId) return;
    const durationMs = this.currentTraceStartedAt ? Date.now() - this.currentTraceStartedAt : null;
    this.emitCallTrace("session", status, { durationMs, ...details }, { runId: this.currentTraceId });
    this.clearTraceContext();
  }

  async getAudioConstraints() {
    const preferBuiltIn = localStorage.getItem("preferBuiltInMic") !== "false";
    const selectedDeviceId = localStorage.getItem("selectedMicDeviceId") || "";

    // Disable browser audio processing — dictation doesn't need it and it adds ~48ms latency
    const noProcessing = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };

    if (preferBuiltIn) {
      if (this.cachedMicDeviceId) {
        logger.debug(
          "Using cached microphone device ID",
          { deviceId: this.cachedMicDeviceId },
          "audio"
        );
        return { audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing } };
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));

        if (builtInMic) {
          this.cachedMicDeviceId = builtInMic.deviceId;
          logger.debug(
            "Using built-in microphone (cached for next time)",
            { deviceId: builtInMic.deviceId, label: builtInMic.label },
            "audio"
          );
          return { audio: { deviceId: { exact: builtInMic.deviceId }, ...noProcessing } };
        }
      } catch (error) {
        logger.debug(
          "Failed to enumerate devices for built-in mic detection",
          { error: error.message },
          "audio"
        );
      }
    }

    if (!preferBuiltIn && selectedDeviceId) {
      logger.debug("Using selected microphone", { deviceId: selectedDeviceId }, "audio");
      return { audio: { deviceId: { exact: selectedDeviceId }, ...noProcessing } };
    }

    logger.debug("Using default microphone", {}, "audio");
    return { audio: noProcessing };
  }

  async cacheMicrophoneDeviceId() {
    if (this.cachedMicDeviceId) return; // Already cached

    const preferBuiltIn = localStorage.getItem("preferBuiltInMic") !== "false";
    if (!preferBuiltIn) return; // Only needed for built-in mic detection

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");
      const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));
      if (builtInMic) {
        this.cachedMicDeviceId = builtInMic.deviceId;
        logger.debug("Microphone device ID pre-cached", { deviceId: builtInMic.deviceId }, "audio");
      }
    } catch (error) {
      logger.debug("Failed to pre-cache microphone device ID", { error: error.message }, "audio");
    }
  }

  async startRecording() {
    try {
      if (this.isRecording || this.isProcessing || this.mediaRecorder?.state === "recording") {
        return false;
      }

      const trace = this.ensureTraceContext();
      if (trace.created) {
        this.emitCallTrace("session", "start", { mode: "batch" }, { runId: trace.runId });
      }
      this.emitCallTrace("recording", "start", { mode: "batch" }, { runId: trace.runId });
      void this.warmupReasoningConnection();

      const constraints = await this.getAudioConstraints();
      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
          },
          "audio"
        );
      }

      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];
      this.recordingStartTime = Date.now();
      this.recordingMimeType = this.mediaRecorder.mimeType || "audio/webm";
      this.startRecordingLevelMonitor(stream);

      this.mediaRecorder.ondataavailable = (event) => {
        this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = async () => {
        this.isRecording = false;
        this.isProcessing = true;
        this.stopRecordingLevelMonitor();
        this.emitStateChange({ stage: "transcribing" });

        const audioBlob = new Blob(this.audioChunks, { type: this.recordingMimeType });

        logger.info(
          "Recording stopped",
          {
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            chunksCount: this.audioChunks.length,
          },
          "audio"
        );

        const durationSeconds = this.recordingStartTime
          ? (Date.now() - this.recordingStartTime) / 1000
          : null;
        this.recordingStartTime = null;
        this.emitCallTrace("recording", "success", {
          mode: "batch",
          recordingDurationMs:
            typeof durationSeconds === "number" && durationSeconds >= 0
              ? Math.round(durationSeconds * 1000)
              : null,
        });
        await this.processAudio(audioBlob, { durationSeconds });

        stream.getTracks().forEach((track) => track.stop());
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.emitStateChange({ stage: "recording" });

      return true;
    } catch (error) {
      this.emitCallTrace("recording", "error", { mode: "batch", error: error.message });
      this.finalizeTrace("error", { error: error.message });
      logger.error("Failed to start recording", { error: error.message }, "audio");

      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorTitle = "No Microphone Found";
        errorDescription = "No microphone was detected. Please connect a microphone and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    }
  }

  stopRecording() {
    if (this.mediaRecorder?.state === "recording") {
      // Keep the floating overlay in the processing state immediately after the
      // hotkey release so it does not collapse and reappear between states.
      this.isRecording = false;
      this.isProcessing = true;
      this.emitStateChange({ stage: "transcribing" });
      this.mediaRecorder.stop();
      return true;
    }
    return false;
  }

  cancelRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.emitCallTrace("recording", "cancelled", { mode: "batch" });
      this.finalizeTrace("cancelled", { reason: "user_cancelled" });

      this.mediaRecorder.onstop = () => {
        this.isRecording = false;
        this.isProcessing = false;
        this.audioChunks = [];
        this.recordingStartTime = null;
        this.stopRecordingLevelMonitor();
        this.emitStateChange({ stage: "idle" });
      };

      this.mediaRecorder.stop();

      if (this.mediaRecorder.stream) {
        this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
      }
      this.stopRecordingLevelMonitor();

      return true;
    }
    return false;
  }

  cancelProcessing() {
    if (this.isProcessing) {
      this.emitCallTrace("session", "cancelled", { reason: "processing_cancelled" });
      this.clearTraceContext();
      this.isProcessing = false;
      this.emitStateChange({ stage: "idle" });
      return true;
    }
    return false;
  }

  async processAudio(audioBlob, metadata = {}) {
    const pipelineStart = performance.now();

    try {
      this.emitProgress(12, "preparing");
      const trace = this.ensureTraceContext();
      if (trace.created) {
        this.emitCallTrace("session", "start", { mode: "batch" }, { runId: trace.runId });
      }

      const useLocalWhisper = this.getBooleanSetting("useLocalWhisper", true);
      const useStreamingRouteForFile =
        metadata?.sourceType === "file" && this.shouldUseLocalStreaming();
      const localProvider = this.getStringSetting("localTranscriptionProvider", "whisper");
      const whisperModel = this.getStringSetting("whisperModel", "turbo");
      const parakeetModel = this.getStringSetting("parakeetModel", "parakeet-tdt-0.6b-v3");
      const senseVoiceModelPath = this.getStringSetting("senseVoiceModelPath", "");
      const senseVoiceBinaryPath = this.getStringSetting("senseVoiceBinaryPath", "");

      const cloudTranscriptionMode = this.getStringSetting(
        "cloudTranscriptionMode",
        hasStoredByokKey() ? "byok" : CHORDVOX_CLOUD_MODE
      );
      const isSignedIn = localStorage.getItem("isSignedIn") === "true";

      const isChordVoxCloudTranscriptionMode =
        !useLocalWhisper && !useStreamingRouteForFile && isChordVoxCloudMode(cloudTranscriptionMode);
      const useCloud = isChordVoxCloudTranscriptionMode && isSignedIn;
      logger.debug(
        "Transcription routing",
        {
          useLocalWhisper,
          useStreamingRouteForFile,
          useCloud,
          isSignedIn,
          cloudTranscriptionMode,
        },
        "transcription"
      );

      let result;
      let activeModel;
      let transcriptionProvider;
      this.emitProgress(28, "transcribing");
      if (useStreamingRouteForFile) {
        transcriptionProvider = "local-streaming";
        activeModel = this.getLocalStreamingModelId();
        this.emitCallTrace("transcription", "start", {
          transcriptionProvider,
          transcriptionModel: activeModel,
        });
        result = await withTimeout(
          this.processWithLocalStreamingFile(audioBlob, metadata),
          TRANSCRIPTION_TIMEOUT_MS,
          "Transcription"
        );
      } else if (useLocalWhisper) {
        transcriptionProvider = localProvider;
        if (localProvider === "nvidia") {
          activeModel = parakeetModel;
          this.emitCallTrace("transcription", "start", {
            transcriptionProvider,
            transcriptionModel: activeModel,
          });
          result = await withTimeout(
            this.processWithLocalParakeet(audioBlob, parakeetModel, metadata),
            TRANSCRIPTION_TIMEOUT_MS,
            "Transcription"
          );
        } else if (localProvider === "sensevoice") {
          activeModel = senseVoiceModelPath || "sensevoice";
          this.emitCallTrace("transcription", "start", {
            transcriptionProvider,
            transcriptionModel: activeModel,
          });
          result = await withTimeout(
            this.processWithLocalSenseVoice(
              audioBlob,
              {
                modelPath: senseVoiceModelPath,
                binaryPath: senseVoiceBinaryPath,
              },
              metadata
            ),
            TRANSCRIPTION_TIMEOUT_MS,
            "Transcription"
          );
        } else {
          activeModel = whisperModel;
          this.emitCallTrace("transcription", "start", {
            transcriptionProvider,
            transcriptionModel: activeModel,
          });
          result = await withTimeout(
            this.processWithLocalWhisper(audioBlob, whisperModel, metadata),
            TRANSCRIPTION_TIMEOUT_MS,
            "Transcription"
          );
        }
      } else if (isChordVoxCloudTranscriptionMode) {
        transcriptionProvider = CHORDVOX_CLOUD_PROVIDER;
        if (!isSignedIn) {
          const err = new Error(
            "ChordVox Cloud requires sign-in. Please sign in again or switch to BYOK mode."
          );
          err.code = "AUTH_REQUIRED";
          throw err;
        }
        activeModel = CHORDVOX_CLOUD_MODEL;
        this.emitCallTrace("transcription", "start", {
          transcriptionProvider,
          transcriptionModel: activeModel,
        });
        result = await withTimeout(
          this.processWithChordVoxCloud(audioBlob, metadata),
          TRANSCRIPTION_TIMEOUT_MS,
          "Transcription"
        );
      } else {
        transcriptionProvider = this.getStringSetting("cloudTranscriptionProvider", "openai");
        activeModel = this.getTranscriptionModel();
        this.emitCallTrace("transcription", "start", {
          transcriptionProvider,
          transcriptionModel: activeModel,
        });
        result = await withTimeout(
          this.processWithOpenAIAPI(audioBlob, metadata),
          TRANSCRIPTION_TIMEOUT_MS,
          "Transcription"
        );
      }

      this.emitCallTrace(
        "transcription",
        "success",
        {
          transcriptionProvider,
          transcriptionModel: activeModel,
          source: result?.source || null,
          transcriptionProcessingDurationMs: result?.timings?.transcriptionProcessingDurationMs ?? null,
          reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
        },
        { runId: trace.runId }
      );

      if (!this.isProcessing) {
        this.finalizeTrace("cancelled", { reason: "processing_cancelled" });
        return;
      }

      if (result && typeof result === "object") {
        result.traceId = trace.runId;
        result.profileId = this.activeHotkeyProfileId;
        result.recordingDurationMs =
          typeof metadata.durationSeconds === "number" && metadata.durationSeconds >= 0
            ? Math.round(metadata.durationSeconds * 1000)
            : null;
      }

      this.emitProgress(92, "saving");
      if (
        metadata?.sourceType === "file" &&
        result?.success &&
        result?.text &&
        !this.onTranscriptionComplete
      ) {
        await this.saveTranscription(result.text, {
          recordingDurationMs: result.recordingDurationMs,
        });
      }
      await Promise.resolve(this.onTranscriptionComplete?.(result));
      this.emitProgress(100, "complete");

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      const timingData = {
        mode: useStreamingRouteForFile
          ? "local-streaming"
          : useLocalWhisper
            ? `local-${localProvider}`
            : "cloud",
        model: activeModel,
        audioDurationMs: metadata.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : null,
        reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
        roundTripDurationMs,
        audioSizeBytes: audioBlob.size,
        audioFormat: audioBlob.type,
        outputTextLength: result?.text?.length,
      };

      if (useLocalWhisper) {
        timingData.audioConversionDurationMs = result?.timings?.audioConversionDurationMs ?? null;
      }
      timingData.transcriptionProcessingDurationMs =
        result?.timings?.transcriptionProcessingDurationMs ?? null;

      logger.info("Pipeline timing", timingData, "performance");
    } catch (error) {
      const errorAtMs = Math.round(performance.now() - pipelineStart);

      this.emitCallTrace("transcription", "error", {
        error: error.message,
        errorAtMs,
      });
      this.finalizeTrace("error", { error: error.message, errorAtMs });

      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      if (error.message !== "No audio detected") {
        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
          code: error.code,
        });
      }
    } finally {
      if (this.isProcessing) {
        this.isProcessing = false;
        this.emitStateChange({ stage: "idle" });
      }
    }
  }

  async transcribeFile(audioBlob, metadata = {}) {
    if (!audioBlob || typeof audioBlob.arrayBuffer !== "function") {
      throw new Error("Unsupported file data. Please choose a valid audio or video file.");
    }

    if (this.isRecording || this.isProcessing) {
      return false;
    }

    this.isProcessing = true;
    this.resetProgressState();
    this.emitProgress(3, "preparing");
    this.emitStateChange({ stage: "transcribing" });

    await this.processAudio(audioBlob, metadata);
    return true;
  }

  async processWithLocalStreamingFile(audioBlob, metadata = {}) {
    const timings = {};

    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const modelId = this.getLocalStreamingModelId();
      const modelsDir = this.getLocalStreamingModelsDir();

      logger.debug(
        "Local streaming file transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
          modelId,
          hasModelsDir: !!modelsDir,
        },
        "sherpa-streaming"
      );

      const transcriptionStart = performance.now();
      const result = await window.electronAPI.sherpaStreamingTranscribeFile?.(arrayBuffer, {
        modelId,
        modelsDir: modelsDir || undefined,
        sourceFileName: metadata.sourceFileName || null,
        mimeType: metadata.mimeType || audioBlob.type || null,
      });
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Local streaming file transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result?.success,
        },
        "sherpa-streaming"
      );

      if (result?.success && result.text) {
        this.onPartialTranscript?.(result.text.trim());
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local-streaming");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, source: "local-streaming", timings };
        }
        throw new Error("No text transcribed");
      } else if (result?.success === false && result?.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result?.message || result?.error || "Local streaming transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const allowOpenAIFallback = this.getBooleanSetting("allowOpenAIFallback", false);
      const proAccess = await this.getProAccessState();

      if (allowOpenAIFallback && proAccess.allowed) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Local streaming failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      }

      throw new Error(`Local streaming failed: ${error.message}`);
    }
  }

  async processWithLocalWhisper(audioBlob, model = "base", metadata = {}) {
    const timings = {};

    try {
      // Send original audio to main process - FFmpeg in main process handles conversion
      // (renderer-side AudioContext conversion was unreliable with WebM/Opus format)
      const arrayBuffer = await audioBlob.arrayBuffer();
      const language = getBaseLanguageCode(this.getStringSetting("preferredLanguage", "auto"));
      const options = { model };
      if (language) {
        options.language = language;
      }

      // Add custom dictionary as initial prompt to help Whisper recognize specific words
      const dictionaryPrompt = this.getCustomDictionaryPrompt();
      if (dictionaryPrompt) {
        options.initialPrompt = dictionaryPrompt;
      }

      logger.debug(
        "Local transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Local transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        this.onPartialTranscript?.(result.text.trim());
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, source: "local", timings };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Local Whisper transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const allowOpenAIFallback = this.getBooleanSetting("allowOpenAIFallback", false);
      const isLocalMode = this.getBooleanSetting("useLocalWhisper", true);
      const proAccess = await this.getProAccessState();

      if (allowOpenAIFallback && isLocalMode && proAccess.allowed) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Local Whisper failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Local Whisper failed: ${error.message}`);
      }
    }
  }

  async processWithLocalParakeet(audioBlob, model = "parakeet-tdt-0.6b-v3", metadata = {}) {
    const timings = {};

    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const modelValue = String(model || "parakeet-tdt-0.6b-v3").trim() || "parakeet-tdt-0.6b-v3";
      const effectiveModelForLanguage = isLikelyLocalPath(modelValue)
        ? "parakeet-tdt-0.6b-v3"
        : modelValue;
      const language = validateLanguageForModel(
        this.getStringSetting("preferredLanguage", "auto"),
        effectiveModelForLanguage
      );
      const options = { model: effectiveModelForLanguage };
      if (isLikelyLocalPath(modelValue)) {
        options.modelPath = modelValue;
      }
      if (language) {
        options.language = language;
      }

      logger.debug(
        "Parakeet transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
          model: modelValue,
          hasModelPath: !!options.modelPath,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Parakeet transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        this.onPartialTranscript?.(result.text.trim());
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local-parakeet");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, source: "local-parakeet", timings };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Parakeet transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const allowOpenAIFallback = this.getBooleanSetting("allowOpenAIFallback", false);
      const isLocalMode = this.getBooleanSetting("useLocalWhisper", true);
      const proAccess = await this.getProAccessState();

      if (allowOpenAIFallback && isLocalMode && proAccess.allowed) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Parakeet failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Parakeet failed: ${error.message}`);
      }
    }
  }

  async processWithLocalSenseVoice(audioBlob, config = {}, metadata = {}) {
    const timings = {};

    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const preferredLanguage = getBaseLanguageCode(this.getStringSetting("preferredLanguage", "auto"));
      const supportedLanguages = new Set(["zh", "en", "yue", "ja", "ko"]);
      const language =
        preferredLanguage && supportedLanguages.has(preferredLanguage) ? preferredLanguage : "auto";

      const options = {
        modelPath: config.modelPath || "",
        binaryPath: config.binaryPath || "",
        language,
      };

      logger.debug(
        "SenseVoice transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
          hasModelPath: !!options.modelPath,
          hasBinaryPath: !!options.binaryPath,
          language,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await window.electronAPI.transcribeLocalSenseVoice(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "SenseVoice transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        this.onPartialTranscript?.(result.text.trim());
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local-sensevoice");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, source: "local-sensevoice", timings };
        }
        throw new Error("No text transcribed");
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "SenseVoice transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const allowOpenAIFallback = this.getBooleanSetting("allowOpenAIFallback", false);
      const isLocalMode = this.getBooleanSetting("useLocalWhisper", false);
      const proAccess = await this.getProAccessState();

      if (allowOpenAIFallback && isLocalMode && proAccess.allowed) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Others failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Others failed: ${error.message}`);
      }
    }
  }

  async getAPIKey() {
    // Get the current transcription provider
    const provider =
      typeof localStorage !== "undefined"
        ? this.getStringSetting("cloudTranscriptionProvider", "openai")
        : "openai";

    // Check cache (invalidate if provider changed)
    if (this.cachedApiKey !== null && this.cachedApiKeyProvider === provider) {
      return this.cachedApiKey;
    }

    let apiKey = null;

    if (provider === "custom") {
      // Prefer localStorage (user-entered via UI) over main process (.env)
      apiKey = localStorage.getItem("customTranscriptionApiKey") || "";
      if (!apiKey.trim()) {
        try {
          apiKey = await window.electronAPI.getCustomTranscriptionKey?.();
        } catch (err) {
          logger.debug(
            "Failed to get custom transcription key via IPC",
            { error: err?.message },
            "transcription"
          );
        }
      }
      apiKey = apiKey?.trim() || "";

      logger.debug(
        "Custom STT API key retrieval",
        {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
          keyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : "(none)",
        },
        "transcription"
      );

      // For custom, we allow null/empty - the endpoint may not require auth
      if (!apiKey) {
        apiKey = null;
      }
    } else if (provider === "groq") {
      // Prefer localStorage (user-entered via UI) over main process (.env)
      apiKey = localStorage.getItem("groqApiKey");
      if (!isValidApiKey(apiKey, "groq")) {
        apiKey = await window.electronAPI.getGroqKey?.();
      }
      if (!isValidApiKey(apiKey, "groq")) {
        throw new Error("Groq API key not found. Please set your API key in the Control Panel.");
      }
    } else {
      // Default to OpenAI
      // Prefer localStorage (user-entered via UI) over main process (.env)
      // to avoid stale keys in process.env after auth mode transitions
      apiKey = localStorage.getItem("openaiApiKey");
      if (!isValidApiKey(apiKey, "openai")) {
        apiKey = await window.electronAPI.getOpenAIKey();
      }
      if (!isValidApiKey(apiKey, "openai")) {
        throw new Error(
          "OpenAI API key not found. Please set your API key in the .env file or Control Panel."
        );
      }
    }

    this.cachedApiKey = apiKey;
    this.cachedApiKeyProvider = provider;
    return apiKey;
  }

  async getDoubaoCredentials() {
    const localAppId = localStorage.getItem("doubaoAppId") || "";
    const localAccessToken = localStorage.getItem("doubaoAccessToken") || "";

    const appId = localAppId.trim() || (await window.electronAPI.getDoubaoAppId?.()) || "";
    const accessToken =
      localAccessToken.trim() || (await window.electronAPI.getDoubaoAccessToken?.()) || "";

    if (!appId.trim()) {
      throw new Error("Doubao APP ID not found. Please set it in the Control Panel.");
    }

    if (!accessToken.trim()) {
      throw new Error("Doubao Access Token not found. Please set it in the Control Panel.");
    }

    return {
      appId: appId.trim(),
      accessToken: accessToken.trim(),
    };
  }

  async optimizeAudio(audioBlob) {
    return new Promise((resolve) => {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const reader = new FileReader();

      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result;
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          // Convert to 16kHz mono for smaller size and faster upload
          const sampleRate = 16000;
          const channels = 1;
          const length = Math.floor(audioBuffer.duration * sampleRate);
          const offlineContext = new OfflineAudioContext(channels, length, sampleRate);

          const source = offlineContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offlineContext.destination);
          source.start();

          const renderedBuffer = await offlineContext.startRendering();
          const wavBlob = this.audioBufferToWav(renderedBuffer);
          resolve(wavBlob);
        } catch (error) {
          // If optimization fails, use original
          resolve(audioBlob);
        }
      };

      reader.onerror = () => resolve(audioBlob);
      reader.readAsArrayBuffer(audioBlob);
    });
  }

  audioBufferToWav(buffer) {
    const length = buffer.length;
    const arrayBuffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(arrayBuffer);
    const sampleRate = buffer.sampleRate;
    const channelData = buffer.getChannelData(0);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, length * 2, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }

    return new Blob([arrayBuffer], { type: "audio/wav" });
  }

  async processWithReasoningModel(text, model, agentName, config = {}) {
    logger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      providerOverride: config.providerOverride || null,
      textLength: text.length,
    });

    const startTime = Date.now();
    const REASONING_TIMEOUT_MS = 30000; // 30 seconds

    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("AI reasoning timed out after 30s")),
          REASONING_TIMEOUT_MS
        );
      });

      const result = await Promise.race([
        ReasoningService.processText(text, model, agentName, config),
        timeoutPromise,
      ]);

      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
        timedOut: error.message.includes("timed out"),
      });

      throw error;
    }
  }

  async isReasoningAvailable() {
    if (typeof window === "undefined" || !window.localStorage) {
      return false;
    }

    const storedValue = this.getSettingValue("useReasoningModel", "true");
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === storedValue;

    if (cacheValid) {
      return this.reasoningAvailabilityCache.value;
    }

    logger.logReasoning("REASONING_STORAGE_CHECK", {
      storedValue,
      typeOfStoredValue: typeof storedValue,
      isTrue: storedValue === "true",
      isTruthy: !!storedValue && storedValue !== "false",
    });

    const useReasoning = storedValue === "true" || (!!storedValue && storedValue !== "false");

    if (!useReasoning) {
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = storedValue;
      return false;
    }

    const proAccess = await this.getProAccessState();
    if (!proAccess.allowed) {
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = storedValue;
      return false;
    }

    try {
      const reasoningProvider = this.getStringSetting("reasoningProvider", "auto");
      const isAvailable = await ReasoningService.isAvailable(reasoningProvider);

      logger.logReasoning("REASONING_AVAILABILITY", {
        isAvailable,
        reasoningEnabled: useReasoning,
        finalDecision: useReasoning && isAvailable,
      });

      this.reasoningAvailabilityCache = {
        value: isAvailable,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = storedValue;

      return isAvailable;
    } catch (error) {
      logger.logReasoning("REASONING_AVAILABILITY_ERROR", {
        error: error.message,
        stack: error.stack,
      });

      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = storedValue;
      return false;
    }
  }

  async getProAccessState(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && now < (this.proAccessCache?.expiresAt || 0)) {
      return {
        allowed: Boolean(this.proAccessCache?.value),
        status: this.proAccessCache?.status || null,
      };
    }

    if (!window?.electronAPI) {
      const status = {
        success: false,
        status: "invalid",
        isActive: false,
        keyPresent: false,
        error: "LICENSE_RUNTIME_UNAVAILABLE",
        message: "Pro access is unavailable because the desktop runtime bridge is missing.",
      };
      this.proAccessCache = {
        value: false,
        expiresAt: now + PRO_ACCESS_CACHE_TTL,
        status,
      };
      return { allowed: false, status };
    }

    if (!window.electronAPI.licenseEnsureProAccess && !window.electronAPI.licenseGetStatus) {
      const status = {
        success: false,
        status: "invalid",
        isActive: false,
        keyPresent: false,
        error: "LICENSE_RUNTIME_UNAVAILABLE",
        message: "Pro access is unavailable because the desktop runtime bridge is missing.",
      };
      this.proAccessCache = {
        value: false,
        expiresAt: now + PRO_ACCESS_CACHE_TTL,
        status,
      };
      return { allowed: false, status };
    }

    try {
      const status = window.electronAPI.licenseEnsureProAccess
        ? await window.electronAPI.licenseEnsureProAccess()
        : window.electronAPI.licenseGetStatus
          ? await window.electronAPI.licenseGetStatus()
          : { isActive: true };
      const allowed = Boolean(status?.isActive);
      this.proAccessCache = {
        value: allowed,
        expiresAt: now + PRO_ACCESS_CACHE_TTL,
        status: status || null,
      };
      return { allowed, status: status || null };
    } catch (_error) {
      const status = {
        success: false,
        status: "invalid",
        isActive: false,
        keyPresent: false,
        error: "LICENSE_CHECK_FAILED",
        message: "Failed to verify Pro access. Please open Settings > Account and retry.",
      };
      this.proAccessCache = {
        value: false,
        expiresAt: now + PRO_ACCESS_CACHE_TTL,
        status,
      };
      return { allowed: false, status };
    }
  }

  createProRequiredError(status = null) {
    const err = new Error(
      status?.message || "This feature requires Pro. Open Settings > Account to upgrade."
    );
    err.code = "LICENSE_REQUIRED";
    err.title = "LICENSE_REQUIRED";
    err.description = err.message;
    err.licenseStatus = status || null;
    return err;
  }

  async processTranscription(text, source) {
    const normalizedText = typeof text === "string" ? text.trim() : "";

    logger.logReasoning("TRANSCRIPTION_RECEIVED", {
      source,
      textLength: normalizedText.length,
      textPreview: normalizedText.substring(0, 100) + (normalizedText.length > 100 ? "..." : ""),
      timestamp: new Date().toISOString(),
    });

    const reasoningModel =
      typeof window !== "undefined" && window.localStorage
        ? this.getStringSetting("reasoningModel", "")
        : "";
    const reasoningProvider =
      typeof window !== "undefined" && window.localStorage
        ? this.getStringSetting("reasoningProvider", "auto")
        : "auto";
    const agentName =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("agentName") || null
        : null;
    if (!reasoningModel) {
      logger.logReasoning("REASONING_SKIPPED", {
        reason: "No reasoning model selected",
      });
      this.emitCallTrace("reasoning", "skipped", {
        reason: "No reasoning model selected",
      });
      this.emitProgress(92, "saving");
      return normalizedText;
    }

    const useReasoning = await this.isReasoningAvailable();

    logger.logReasoning("REASONING_CHECK", {
      useReasoning,
      reasoningModel,
      reasoningProvider,
      agentName,
    });

    if (useReasoning) {
      try {
        this.emitProgress(78, "enhancing");
        this.emitStateChange({ stage: "polishing" });
        this.emitCallTrace("reasoning", "start", {
          reasoningProvider,
          reasoningModel,
        });
        logger.logReasoning("SENDING_TO_REASONING", {
          preparedTextLength: normalizedText.length,
          model: reasoningModel,
          provider: reasoningProvider,
        });

        const result = await this.processWithReasoningModel(
          normalizedText,
          reasoningModel,
          agentName,
          {
            providerOverride: reasoningProvider,
            promptMode: "fast-cleanup",
          }
        );

        logger.logReasoning("REASONING_SUCCESS", {
          resultLength: result.length,
          resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
          processingTime: new Date().toISOString(),
        });

        this.emitCallTrace("reasoning", "success", {
          reasoningProvider,
          reasoningModel,
        });

        this.emitProgress(92, "saving");
        return result;
      } catch (error) {
        logger.logReasoning("REASONING_FAILED", {
          error: error.message,
          stack: error.stack,
          fallbackToCleanup: true,
        });
        this.emitCallTrace("reasoning", "error", {
          reasoningProvider,
          reasoningModel,
          error: error.message,
        });
        console.error(`Reasoning failed (${source}):`, error.message);
      }
    }

    if (!useReasoning) {
      this.emitCallTrace("reasoning", "skipped", {
        reason: `Reasoning not enabled or unavailable (provider=${reasoningProvider})`,
        reasoningProvider,
      });
    }

    logger.logReasoning("USING_STANDARD_CLEANUP", {
      reason: useReasoning ? "Reasoning failed" : "Reasoning not enabled",
    });

    this.emitProgress(92, "saving");
    return normalizedText;
  }

  shouldStreamTranscription(model, provider) {
    if (provider !== "openai") {
      return false;
    }
    const normalized = typeof model === "string" ? model.trim() : "";
    if (!normalized || normalized === "whisper-1") {
      return false;
    }
    if (normalized === "gpt-4o-transcribe" || normalized === "gpt-4o-transcribe-diarize") {
      return true;
    }
    return normalized.startsWith("gpt-4o-mini-transcribe");
  }

  async readTranscriptionStream(response) {
    const reader = response.body?.getReader();
    if (!reader) {
      logger.error("Streaming response body not available", {}, "transcription");
      throw new Error("Streaming response body not available");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let collectedText = "";
    let finalText = null;
    let eventCount = 0;
    const eventTypes = {};

    const handleEvent = (payload) => {
      if (!payload || typeof payload !== "object") {
        return;
      }
      eventCount++;
      const eventType = payload.type || "unknown";
      eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

      logger.debug(
        "Stream event received",
        {
          type: eventType,
          eventNumber: eventCount,
          payloadKeys: Object.keys(payload),
        },
        "transcription"
      );

      if (payload.type === "transcript.text.delta" && typeof payload.delta === "string") {
        collectedText += payload.delta;
        this.onPartialTranscript?.(collectedText.trim());
        return;
      }
      if (payload.type === "transcript.text.segment" && typeof payload.text === "string") {
        collectedText += payload.text;
        this.onPartialTranscript?.(collectedText.trim());
        return;
      }
      if (payload.type === "transcript.text.done" && typeof payload.text === "string") {
        finalText = payload.text;
        this.onPartialTranscript?.(payload.text.trim());
        logger.debug(
          "Final transcript received",
          {
            textLength: payload.text.length,
          },
          "transcription"
        );
      }
    };

    logger.debug("Starting to read transcription stream", {}, "transcription");

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        logger.debug(
          "Stream reading complete",
          {
            eventCount,
            eventTypes,
            collectedTextLength: collectedText.length,
            hasFinalText: finalText !== null,
          },
          "transcription"
        );
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Log first chunk to see format
      if (eventCount === 0 && chunk.length > 0) {
        logger.debug(
          "First stream chunk received",
          {
            chunkLength: chunk.length,
            chunkPreview: chunk.substring(0, 500),
          },
          "transcription"
        );
      }

      // Process complete lines from the buffer
      // Each SSE event is "data: <json>\n" followed by empty line
      const lines = buffer.split("\n");
      buffer = "";

      for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip empty lines
        if (!trimmedLine) {
          continue;
        }

        // Extract data from "data: " prefix
        let data = "";
        if (trimmedLine.startsWith("data: ")) {
          data = trimmedLine.slice(6);
        } else if (trimmedLine.startsWith("data:")) {
          data = trimmedLine.slice(5).trim();
        } else {
          // Not a data line, could be leftover - keep in buffer
          buffer += line + "\n";
          continue;
        }

        // Handle [DONE] marker
        if (data === "[DONE]") {
          finalText = finalText ?? collectedText;
          continue;
        }

        // Try to parse JSON
        try {
          const parsed = JSON.parse(data);
          handleEvent(parsed);
        } catch (error) {
          // Incomplete JSON - put back in buffer for next iteration
          buffer += line + "\n";
        }
      }
    }

    const result = finalText ?? collectedText;
    this.onPartialTranscript?.(result.trim());
    logger.debug(
      "Stream processing complete",
      {
        resultLength: result.length,
        usedFinalText: finalText !== null,
        eventCount,
        eventTypes,
      },
      "transcription"
    );

    return result;
  }

  async processWithChordVoxCloud(audioBlob, metadata = {}) {
    if (!navigator.onLine) {
      const err = new Error("You're offline. Cloud transcription requires an internet connection.");
      err.code = "OFFLINE";
      throw err;
    }

    const timings = {};
    const language = getBaseLanguageCode(this.getStringSetting("preferredLanguage", "auto"));

    const arrayBuffer = await audioBlob.arrayBuffer();
    const opts = {};
    if (language) opts.language = language;

    const dictionaryPrompt = this.getCustomDictionaryPrompt();
    if (dictionaryPrompt) opts.prompt = dictionaryPrompt;

    // Use withSessionRefresh to handle AUTH_EXPIRED automatically
    const transcriptionStart = performance.now();
    const result = await withSessionRefresh(async () => {
      const res = await window.electronAPI.cloudTranscribe(arrayBuffer, opts);
      if (!res.success) {
        const err = new Error(res.error || "Cloud transcription failed");
        err.code = res.code;
        throw err;
      }
      return res;
    });
    timings.transcriptionProcessingDurationMs = Math.round(performance.now() - transcriptionStart);

    // Process with reasoning if enabled
    let processedText = result.text;
    this.onPartialTranscript?.(processedText.trim());
    const useReasoningModel = this.getBooleanSetting("useReasoningModel", true);
    if (useReasoningModel && processedText) {
      this.emitStateChange({ stage: "polishing" });
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || "";
      const {
        cloudReasoningMode,
        reasoningModel,
        reasoningProvider,
      } = this.getEffectiveReasoningTarget();

      this.emitCallTrace("reasoning", "start", {
        reasoningProvider,
        reasoningModel,
      });

      try {
        if (isChordVoxCloudMode(cloudReasoningMode)) {
          const reasonResult = await withSessionRefresh(async () => {
            const res = await window.electronAPI.cloudReason(processedText, {
              agentName,
              customDictionary: this.getCustomDictionaryArray(),
              customPrompt: this.getFastCleanupPrompt(agentName, processedText),
              language: this.getStringSetting("preferredLanguage", "auto"),
              locale: localStorage.getItem("uiLanguage") || "en",
            });
            if (!res.success) {
              const err = new Error(res.error || "Cloud reasoning failed");
              err.code = res.code;
              throw err;
            }
            return res;
          });

          if (reasonResult.success) {
            processedText = reasonResult.text;
          }

          this.emitCallTrace("reasoning", "success", {
            reasoningProvider,
            reasoningModel: reasonResult.model || reasoningModel,
          });
        } else if (reasoningModel) {
          const result = await this.processWithReasoningModel(
            processedText,
            reasoningModel,
            agentName,
            {
              providerOverride: reasoningProvider,
              promptMode: "fast-cleanup",
            }
          );
          if (result) {
            processedText = result;
          }
          this.emitCallTrace("reasoning", "success", {
            reasoningProvider,
            reasoningModel,
          });
        } else {
          this.emitCallTrace("reasoning", "skipped", {
            reason: "No reasoning model selected",
            reasoningProvider,
          });
        }
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);
      } catch (error) {
        this.emitCallTrace("reasoning", "error", {
          reasoningProvider,
          reasoningModel,
          error: error.message,
        });
        throw error;
      }
    } else {
      this.emitCallTrace("reasoning", "skipped", {
        reason: useReasoningModel ? "No text for reasoning" : "Reasoning disabled",
      });
    }

    return {
      success: true,
      text: processedText,
      source: CHORDVOX_CLOUD_SOURCE,
      timings,
      limitReached: result.limitReached,
      wordsUsed: result.wordsUsed,
      wordsRemaining: result.wordsRemaining,
    };
  }

  getCustomDictionaryArray() {
    try {
      const raw = localStorage.getItem("customDictionary");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  getCustomPrompt() {
    try {
      const raw = localStorage.getItem("customUnifiedPrompt");
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  getFastCleanupPrompt(agentName, transcript) {
    const customPrompt = this.getCustomPrompt();
    if (customPrompt) {
      return customPrompt;
    }

    return getSystemPrompt(
      agentName || null,
      this.getCustomDictionaryArray(),
      this.getStringSetting("preferredLanguage", "auto"),
      transcript,
      localStorage.getItem("uiLanguage") || "en",
      { promptMode: "fast-cleanup" }
    );
  }

  getKeyterms() {
    return this.getCustomDictionaryArray();
  }

  async processWithOpenAIAPI(audioBlob, metadata = {}) {
    const timings = {};
    const preferredLanguage = this.getStringSetting("preferredLanguage", "auto");
    const language = getBaseLanguageCode(preferredLanguage);
    const allowLocalFallback = this.getBooleanSetting("allowLocalFallback", false);
    const fallbackModel = this.getStringSetting("fallbackWhisperModel", "base");
    const proAccess = await this.getProAccessState();

    if (!proAccess.allowed) {
      throw this.createProRequiredError(proAccess.status);
    }

    try {
      const durationSeconds = metadata.durationSeconds ?? null;
      const shouldSkipOptimizationForDuration =
        typeof durationSeconds === "number" &&
        durationSeconds > 0 &&
        durationSeconds < SHORT_CLIP_DURATION_SECONDS;

      const model = this.getTranscriptionModel();
      const provider = this.getStringSetting("cloudTranscriptionProvider", "openai");

      logger.debug(
        "Transcription request starting",
        {
          provider,
          model,
          blobSize: audioBlob.size,
          blobType: audioBlob.type,
          durationSeconds,
          language,
        },
        "transcription"
      );

      // gpt-4o-transcribe models don't support WAV format - they need webm, mp3, mp4, etc.
      // Only use WAV optimization for whisper-1 and groq models
      const is4oModel = model.includes("gpt-4o");
      const shouldOptimize =
        provider === "doubao"
          ? true
          : !is4oModel && !shouldSkipOptimizationForDuration && audioBlob.size > 1024 * 1024;

      logger.debug(
        "Audio optimization decision",
        {
          is4oModel,
          shouldOptimize,
          shouldSkipOptimizationForDuration,
        },
        "transcription"
      );

      const [credentials, optimizedAudio] = await Promise.all([
        provider === "doubao" ? this.getDoubaoCredentials() : this.getAPIKey(),
        shouldOptimize ? this.optimizeAudio(audioBlob) : Promise.resolve(audioBlob),
      ]);
      const apiKey = provider === "doubao" ? null : credentials;
      const doubaoCredentials = provider === "doubao" ? credentials : null;

      // Determine the correct file extension based on the blob type
      const mimeType = optimizedAudio.type || "audio/webm";
      const extension = mimeType.includes("webm")
        ? "webm"
        : mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("mp4")
            ? "mp4"
            : mimeType.includes("mpeg")
              ? "mp3"
              : mimeType.includes("wav")
                ? "wav"
                : "webm";

      logger.debug(
        "FormData preparation",
        {
          mimeType,
          extension,
          optimizedSize: optimizedAudio.size,
          hasApiKey: !!apiKey || !!doubaoCredentials,
        },
        "transcription"
      );

      const apiCallStart = performance.now();

      if (provider === "doubao" && window.electronAPI?.proxyDoubaoTranscription) {
        const audioBuffer = await optimizedAudio.arrayBuffer();
        const doubaoCredentials = await this.getDoubaoCredentials();
        const result = await window.electronAPI.proxyDoubaoTranscription({
          audioBuffer,
          model,
          language: preferredLanguage,
          appId: doubaoCredentials.appId,
          accessToken: doubaoCredentials.accessToken,
        });
        const proxyText = result?.text;

        if (proxyText && proxyText.trim().length > 0) {
          timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
          const reasoningStart = performance.now();
          const text = await this.processTranscription(proxyText, "doubao");
          timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

          const source = (await this.isReasoningAvailable()) ? "doubao-reasoned" : "doubao";
          return { success: true, text, source, timings };
        }

        throw new Error("No text transcribed - Doubao response was empty");
      }

      const formData = new FormData();
      formData.append("file", optimizedAudio, `audio.${extension}`);
      formData.append("model", model);

      if (language) {
        formData.append("language", language);
      }

      // Add custom dictionary as prompt hint for cloud transcription
      const dictionaryPrompt = this.getCustomDictionaryPrompt();
      if (dictionaryPrompt) {
        formData.append("prompt", dictionaryPrompt);
      }

      const shouldStream = this.shouldStreamTranscription(model, provider);
      if (shouldStream) {
        formData.append("stream", "true");
      }

      const endpoint = this.getTranscriptionEndpoint();
      const isCustomEndpoint =
        provider === "custom" ||
        (!endpoint.includes("api.openai.com") &&
          !endpoint.includes("api.groq.com") &&
          !endpoint.includes("openspeech.bytedance.com"));

      logger.debug(
        "Making transcription API request",
        {
          endpoint,
          shouldStream,
          model,
          provider,
          isCustomEndpoint,
          hasApiKey: !!apiKey,
          apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : "(none)",
        },
        "transcription"
      );

      // Build headers - only include Authorization if we have an API key
      const headers = {};
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      logger.debug(
        "STT request details",
        {
          endpoint,
          method: "POST",
          hasAuthHeader: !!apiKey,
          formDataFields: [
            "file",
            "model",
            language && language !== "auto" ? "language" : null,
            shouldStream ? "stream" : null,
          ].filter(Boolean),
        },
        "transcription"
      );

      const abortController = new AbortController();
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: formData,
        signal: abortController.signal,
      });

      const responseContentType = response.headers.get("content-type") || "";

      logger.debug(
        "Transcription API response received",
        {
          status: response.status,
          statusText: response.statusText,
          contentType: responseContentType,
          ok: response.ok,
        },
        "transcription"
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Transcription API error response",
          {
            status: response.status,
            errorText,
          },
          "transcription"
        );
        throw new Error(`API Error: ${response.status} ${errorText}`);
      }

      let result;
      const contentType = responseContentType;

      if (shouldStream && contentType.includes("text/event-stream")) {
        logger.debug("Processing streaming response", { contentType }, "transcription");
        const streamedText = await this.readTranscriptionStream(response);
        result = { text: streamedText };
        logger.debug(
          "Streaming response parsed",
          {
            hasText: !!streamedText,
            textLength: streamedText?.length,
          },
          "transcription"
        );
      } else {
        const rawText = await response.text();
        logger.debug(
          "Raw API response body",
          {
            rawText: rawText.substring(0, 1000),
            fullLength: rawText.length,
          },
          "transcription"
        );

        try {
          result = JSON.parse(rawText);
        } catch (parseError) {
          logger.error(
            "Failed to parse JSON response",
            {
              parseError: parseError.message,
              rawText: rawText.substring(0, 500),
            },
            "transcription"
          );
          throw new Error(`Failed to parse API response: ${parseError.message}`);
        }

        logger.debug(
          "Parsed transcription result",
          {
            hasText: !!result.text,
            textLength: result.text?.length,
            resultKeys: Object.keys(result),
            fullResult: result,
          },
          "transcription"
        );
      }

      // Check for text - handle both empty string and missing field
      if (result.text && result.text.trim().length > 0) {
        this.onPartialTranscript?.(result.text.trim());
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);

        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "openai");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable()) ? "openai-reasoned" : "openai";
        logger.debug(
          "Transcription successful",
          {
            originalLength: result.text.length,
            processedLength: text.length,
            source,
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          },
          "transcription"
        );
        return { success: true, text, source, timings };
      } else {
        // Log at info level so it shows without debug mode
        logger.info(
          "Transcription returned empty - check audio input",
          {
            model,
            provider,
            endpoint,
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            mimeType,
            extension,
            resultText: result.text,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        logger.error(
          "No text in transcription result",
          {
            result,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        throw new Error(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }
    } catch (error) {
      const isOpenAIMode = !this.getBooleanSetting("useLocalWhisper", true);

      if (allowLocalFallback && isOpenAIMode) {
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const options = { model: fallbackModel };
          if (language && language !== "auto") {
            options.language = language;
          }

          const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);

          if (result.success && result.text) {
            this.onPartialTranscript?.(result.text.trim());
            const text = await this.processTranscription(result.text, "local-fallback");
            if (text) {
              return { success: true, text, source: "local-fallback" };
            }
          }
          throw error;
        } catch (fallbackError) {
          throw new Error(
            `OpenAI API failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`
          );
        }
      }

      throw error;
    }
  }

  getTranscriptionModel() {
    try {
      const provider =
        typeof localStorage !== "undefined"
          ? this.getStringSetting("cloudTranscriptionProvider", "openai")
          : "openai";

      const model =
        typeof localStorage !== "undefined"
          ? this.getStringSetting("cloudTranscriptionModel", "")
          : "";

      const trimmedModel = model.trim();

      // For custom provider, use whatever model is set (or fallback to whisper-1)
      if (provider === "custom") {
        return trimmedModel || "whisper-1";
      }

      // Validate model matches provider to handle settings migration
      if (trimmedModel) {
        const isGroqModel = trimmedModel.startsWith("whisper-large-v3");
        const isOpenAIModel = trimmedModel.startsWith("gpt-4o") || trimmedModel === "whisper-1";
        const isDoubaoModel = trimmedModel.startsWith("doubao-");

        if (provider === "groq" && isGroqModel) {
          return trimmedModel;
        }
        if (provider === "openai" && isOpenAIModel) {
          return trimmedModel;
        }
        if (provider === "doubao" && isDoubaoModel) {
          return trimmedModel;
        }
        // Model doesn't match provider - fall through to default
      }

      // Return provider-appropriate default
      if (provider === "groq") return "whisper-large-v3-turbo";
      if (provider === "doubao") return "doubao-streaming-auto";
      return "gpt-4o-mini-transcribe";
    } catch (error) {
      return "gpt-4o-mini-transcribe";
    }
  }

  getTranscriptionEndpoint() {
    // Get current provider and base URL to check if cache is valid
    const currentProvider =
      typeof localStorage !== "undefined"
        ? this.getStringSetting("cloudTranscriptionProvider", "openai")
        : "openai";
    const currentBaseUrl =
      typeof localStorage !== "undefined"
        ? this.getStringSetting("cloudTranscriptionBaseUrl", "")
        : "";

    // Only use custom URL when provider is explicitly "custom"
    const isCustomEndpoint = currentProvider === "custom";

    // Invalidate cache if provider or base URL changed
    if (
      this.cachedTranscriptionEndpoint &&
      (this.cachedEndpointProvider !== currentProvider ||
        this.cachedEndpointBaseUrl !== currentBaseUrl)
    ) {
      logger.debug(
        "STT endpoint cache invalidated",
        {
          previousProvider: this.cachedEndpointProvider,
          newProvider: currentProvider,
          previousBaseUrl: this.cachedEndpointBaseUrl,
          newBaseUrl: currentBaseUrl,
        },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = null;
    }

    if (this.cachedTranscriptionEndpoint) {
      return this.cachedTranscriptionEndpoint;
    }

    try {
      // Use custom URL only when provider is "custom", otherwise use provider-specific defaults
      let base;
      if (isCustomEndpoint) {
        base = currentBaseUrl.trim() || API_ENDPOINTS.TRANSCRIPTION_BASE;
      } else if (currentProvider === "groq") {
        base = API_ENDPOINTS.GROQ_BASE;
      } else if (currentProvider === "doubao") {
        base = API_ENDPOINTS.DOUBAO_ASR_WS;
      } else {
        // OpenAI or other standard providers
        base = API_ENDPOINTS.TRANSCRIPTION_BASE;
      }

      const normalizedBase = normalizeBaseUrl(base);

      logger.debug(
        "STT endpoint resolution",
        {
          provider: currentProvider,
          isCustomEndpoint,
          rawBaseUrl: currentBaseUrl,
          normalizedBase,
          defaultBase: API_ENDPOINTS.TRANSCRIPTION_BASE,
        },
        "transcription"
      );

      const cacheResult = (endpoint) => {
        this.cachedTranscriptionEndpoint = endpoint;
        this.cachedEndpointProvider = currentProvider;
        this.cachedEndpointBaseUrl = currentBaseUrl;

        logger.debug(
          "STT endpoint resolved",
          {
            endpoint,
            provider: currentProvider,
            isCustomEndpoint,
            usingDefault: endpoint === API_ENDPOINTS.TRANSCRIPTION,
          },
          "transcription"
        );

        return endpoint;
      };

      if (!normalizedBase) {
        logger.debug(
          "STT endpoint: using default (normalization failed)",
          { rawBase: base },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      // Only validate HTTPS for custom endpoints (known providers are already HTTPS)
      if (isCustomEndpoint && !isSecureEndpoint(normalizedBase)) {
        logger.warn(
          "STT endpoint: HTTPS required, falling back to default",
          { attemptedUrl: normalizedBase },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      let endpoint;
      if (/\/audio\/(transcriptions|translations)$/i.test(normalizedBase)) {
        endpoint = normalizedBase;
        logger.debug("STT endpoint: using full path from config", { endpoint }, "transcription");
      } else {
        endpoint = buildApiUrl(normalizedBase, "/audio/transcriptions");
        logger.debug(
          "STT endpoint: appending /audio/transcriptions to base",
          { base: normalizedBase, endpoint },
          "transcription"
        );
      }

      return cacheResult(endpoint);
    } catch (error) {
      logger.error(
        "STT endpoint resolution failed",
        { error: error.message, stack: error.stack },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = API_ENDPOINTS.TRANSCRIPTION;
      this.cachedEndpointProvider = currentProvider;
      this.cachedEndpointBaseUrl = currentBaseUrl;
      return API_ENDPOINTS.TRANSCRIPTION;
    }
  }

  async safePaste(text, options = {}) {
    const { traceId, source, ...pasteOptions } = options || {};
    const runId = traceId || this.currentTraceId || null;

    try {
      this.emitCallTrace(
        "paste",
        "start",
        { textLength: text?.length || 0, source: source || null },
        runId ? { runId } : {}
      );

      await window.electronAPI.pasteText(text, pasteOptions);

      this.emitCallTrace(
        "paste",
        "success",
        { textLength: text?.length || 0, source: source || null },
        runId ? { runId } : {}
      );
      this.finalizeTrace("success", { source: source || null });
      return true;
    } catch (error) {
      this.emitCallTrace(
        "paste",
        "error",
        {
          source: source || null,
          error:
            error?.message ??
            (typeof error?.toString === "function" ? error.toString() : String(error)),
        },
        runId ? { runId } : {}
      );
      this.finalizeTrace("error", {
        source: source || null,
        error:
          error?.message ??
          (typeof error?.toString === "function" ? error.toString() : String(error)),
      });

      const message =
        error?.message ??
        (typeof error?.toString === "function" ? error.toString() : String(error));
      const normalizedMessage = String(message || "").toLowerCase();
      const requiresAccessibilityPermission =
        normalizedMessage.includes("accessibility permissions required") ||
        normalizedMessage.includes("check accessibility permissions") ||
        normalizedMessage.includes("not authorized to send apple events") ||
        normalizedMessage.includes("system events got an error");

      this.onError?.({
        code: requiresAccessibilityPermission
          ? "PASTE_ACCESSIBILITY_REQUIRED"
          : "PASTE_FAILED",
        title: requiresAccessibilityPermission
          ? "PASTE_ACCESSIBILITY_REQUIRED"
          : "PASTE_FAILED",
        description: message,
        requiresAccessibilityPermission,
      });
      return false;
    }
  }

  countTextUnits(text) {
    const normalized = typeof text === "string" ? text.trim() : "";
    if (!normalized) return 0;

    const matches = normalized.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu
    );
    return matches ? matches.length : 0;
  }

  async saveTranscription(text, metadata = {}) {
    try {
      await window.electronAPI.saveTranscription(text, {
        unitCount: this.countTextUnits(text),
        recordingDurationMs:
          Number.isFinite(Number(metadata.recordingDurationMs))
            ? Math.max(0, Math.round(Number(metadata.recordingDurationMs)))
            : null,
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      isStreamingStartInProgress: this.streamingStartInProgress,
    };
  }

  async warmupReasoningConnection({ force = false } = {}) {
    try {
      return await ReasoningService.prewarmFromSettings(force);
    } catch (error) {
      logger.debug(
        "Reasoning warmup skipped",
        { error: error.message || "unknown" },
        "reasoning"
      );
      return false;
    }
  }

  shouldUseStreaming(isSignedInOverride) {
    const cloudTranscriptionMode = this.getStringSetting(
      "cloudTranscriptionMode",
      hasStoredByokKey() ? "byok" : CHORDVOX_CLOUD_MODE
    );
    const isSignedIn = isSignedInOverride ?? localStorage.getItem("isSignedIn") === "true";
    const useLocalWhisper = this.getBooleanSetting("useLocalWhisper", true);
    const streamingDisabled = localStorage.getItem("deepgramStreaming") === "false";

    return (
      !useLocalWhisper &&
      isChordVoxCloudMode(cloudTranscriptionMode) &&
      isSignedIn &&
      !streamingDisabled
    );
  }

  async warmupStreamingConnection({ isSignedIn: isSignedInOverride } = {}) {
    const reasoningWarmupPromise = this.warmupReasoningConnection().catch((error) => {
      logger.debug(
        "Reasoning warmup failed during startup",
        { error: error.message || "unknown" },
        "reasoning"
      );
      return false;
    });

    if (!this.shouldUseStreaming(isSignedInOverride)) {
      logger.debug("Streaming warmup skipped - not in streaming mode", {}, "streaming");
      await reasoningWarmupPromise;
      return false;
    }

    try {
      const [, wsResult] = await Promise.all([
        this.cacheMicrophoneDeviceId(),
        withSessionRefresh(async () => {
          const warmupLang = this.getStringSetting("preferredLanguage", "auto");
          const res = await window.electronAPI.deepgramStreamingWarmup({
            sampleRate: 16000,
            language: warmupLang && warmupLang !== "auto" ? warmupLang : undefined,
            keyterms: this.getKeyterms(),
          });
          // Throw error to trigger retry if AUTH_EXPIRED
          if (!res.success && res.code) {
            const err = new Error(res.error || "Warmup failed");
            err.code = res.code;
            throw err;
          }
          return res;
        }),
      ]);

      await reasoningWarmupPromise;

      if (wsResult.success) {
        // Pre-load AudioWorklet module so first recording is faster
        try {
          const audioContext = await this.getOrCreateAudioContext();
          if (!this.workletModuleLoaded) {
            await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
            this.workletModuleLoaded = true;
            logger.debug("AudioWorklet module pre-loaded during warmup", {}, "streaming");
          }
        } catch (e) {
          logger.debug(
            "AudioWorklet pre-load failed (will retry on recording)",
            { error: e.message },
            "streaming"
          );
        }

        // Warm up the OS audio driver by briefly acquiring the mic, then releasing.
        // This forces macOS to initialize the audio subsystem so subsequent
        // getUserMedia calls resolve in ~100-200ms instead of ~500-1000ms.
        if (!this.micDriverWarmedUp) {
          try {
            const constraints = await this.getAudioConstraints();
            const tempStream = await navigator.mediaDevices.getUserMedia(constraints);
            tempStream.getTracks().forEach((track) => track.stop());
            this.micDriverWarmedUp = true;
            logger.debug("Microphone driver pre-warmed", {}, "streaming");
          } catch (e) {
            logger.debug(
              "Mic driver warmup failed (non-critical)",
              { error: e.message },
              "streaming"
            );
          }
        }

        logger.info(
          "Deepgram streaming connection warmed up",
          { alreadyWarm: wsResult.alreadyWarm, micCached: !!this.cachedMicDeviceId },
          "streaming"
        );
        return true;
      } else if (wsResult.code === "NO_API") {
        logger.debug("Streaming warmup skipped - API not configured", {}, "streaming");
        return false;
      } else {
        logger.warn("Deepgram warmup failed", { error: wsResult.error }, "streaming");
        return false;
      }
    } catch (error) {
      logger.error("Deepgram warmup error", { error: error.message }, "streaming");
      return false;
    }
  }

  async getOrCreateAudioContext() {
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      if (this.persistentAudioContext.state === "suspended") {
        await this.persistentAudioContext.resume();
      }
      return this.persistentAudioContext;
    }
    this.persistentAudioContext = new AudioContext({ sampleRate: 16000 });
    this.workletModuleLoaded = false;
    return this.persistentAudioContext;
  }

  // ---- Local Streaming (sherpa-onnx) ----

  /**
   * Check if the user has selected local streaming mode
   */
  shouldUseLocalStreaming() {
    return localStorage.getItem("useLocalStreaming") === "true";
  }

  /**
   * Get the selected local streaming model ID
   */
  getLocalStreamingModelId() {
    return localStorage.getItem("localStreamingModelId") || DEFAULT_STREAMING_MODEL_ID;
  }

  getLocalStreamingModelsDir() {
    const modelStorageRoot = (localStorage.getItem("modelStorageRoot") || "").trim();
    if (modelStorageRoot) {
      const separator =
        /^(?:[A-Za-z]:\\|\\\\)/.test(modelStorageRoot) ||
        (modelStorageRoot.includes("\\") && !modelStorageRoot.includes("/"))
          ? "\\"
          : "/";
      return `${modelStorageRoot.replace(/[\\/]+$/, "")}${separator}streaming-models`;
    }

    return localStorage.getItem("localStreamingModelsDir") || "";
  }

  getEffectiveCloudReasoningMode() {
    return normalizeChordVoxCloudMode(
      this.getStringSetting("cloudReasoningMode", DEFAULT_CLOUD_REASONING_MODE),
      DEFAULT_CLOUD_REASONING_MODE
    );
  }

  getEffectiveReasoningTarget() {
    const configuredProvider = normalizeChordVoxProvider(
      this.getStringSetting("reasoningProvider", "auto"),
      "auto"
    );
    const configuredModel = this.getStringSetting("reasoningModel", "");
    const isSignedIn = localStorage.getItem("isSignedIn") === "true";

    if (configuredProvider === "local" && configuredModel) {
      return {
        route: "local",
        cloudReasoningMode: "byok",
        reasoningProvider: "local",
        reasoningModel: configuredModel,
      };
    }

    const cloudReasoningMode = this.getEffectiveCloudReasoningMode();
    if (isSignedIn && isChordVoxCloudMode(cloudReasoningMode)) {
      return {
        route: "cloud",
        cloudReasoningMode: CHORDVOX_CLOUD_MODE,
        reasoningProvider: CHORDVOX_CLOUD_PROVIDER,
        reasoningModel: CHORDVOX_CLOUD_MODEL,
      };
    }

    return {
      route: configuredProvider === "local" ? "local" : "configured",
      cloudReasoningMode,
      reasoningProvider: configuredProvider,
      reasoningModel: configuredModel,
    };
  }

  clearLocalStreamingAutoStopTimer() {
    if (this.streamingAutoStopTimer) {
      clearTimeout(this.streamingAutoStopTimer);
      this.streamingAutoStopTimer = null;
    }
  }

  markLocalStreamingSpeechDetected(source = "transcript") {
    if (this.streamingHasRecognizedSpeech) {
      return;
    }

    this.streamingHasRecognizedSpeech = true;
    this.clearLocalStreamingAutoStopTimer();
    logger.debug("Local streaming speech detected", { source }, "sherpa-streaming");
  }

  scheduleLocalStreamingInitialSilenceTimeout() {
    this.clearLocalStreamingAutoStopTimer();
    this.streamingAutoStopTimer = setTimeout(() => {
      this.streamingAutoStopTimer = null;
      if (!this.isStreaming || this.streamingHasRecognizedSpeech || this.streamingAutoStopTriggered) {
        return;
      }

      this.streamingAutoStopTriggered = true;
      logger.info(
        "Auto-stopping local streaming due to initial silence",
        { timeoutMs: LOCAL_STREAMING_INITIAL_SILENCE_TIMEOUT_MS },
        "sherpa-streaming"
      );
      this.stopLocalStreamingRecording().catch((error) => {
        logger.error(
          "Failed to auto-stop local streaming after initial silence",
          { error: error.message },
          "sherpa-streaming"
        );
      });
    }, LOCAL_STREAMING_INITIAL_SILENCE_TIMEOUT_MS);
  }

  /**
   * Start local streaming recording (sherpa-onnx in main process).
   * Uses the same AudioWorklet PCM pipeline as Deepgram streaming,
   * but routes chunks to sherpa-onnx-node instead of WebSocket.
   *
   * Hotkey behavior: toggle mode (press once to start, press once to stop).
   */
  async startLocalStreamingRecording() {
    try {
      this.lastLocalStreamingStartFailure = null;
      if (this.streamingStartInProgress) {
        return false;
      }
      this.streamingStartInProgress = true;

      if (this.isRecording || this.isStreaming || this.isProcessing) {
        this.streamingStartInProgress = false;
        return false;
      }

      const trace = this.ensureTraceContext();
      if (trace.created) {
        this.emitCallTrace("session", "start", { mode: "local-streaming" }, { runId: trace.runId });
      }
      this.emitCallTrace("recording", "start", { mode: "local-streaming" }, { runId: trace.runId });

      this.stopRequestedDuringStreamingStart = false;

      const modelId = this.getLocalStreamingModelId();
      const modelsDir = this.getLocalStreamingModelsDir();
      const t0 = performance.now();

      // 1. Start sherpa recognizer in main process
      const startResult = await window.electronAPI.sherpaStreamingStart({
        modelId,
        modelsDir: modelsDir || undefined,
      });
      if (!startResult.success) {
        throw new Error(startResult.error || "Failed to start local streaming");
      }
      const tSherpa = performance.now();

      // 2. Get microphone
      const constraints = await this.getAudioConstraints();
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const tMedia = performance.now();

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Local streaming started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            modelId,
          },
          "sherpa-streaming"
        );
      }

      // 3. Set up AudioWorklet pipeline
      const audioContext = await this.getOrCreateAudioContext();
      this.streamingAudioContext = audioContext;
      this.streamingSource = audioContext.createMediaStreamSource(stream);
      this.streamingStream = stream;

      if (!this.workletModuleLoaded) {
        await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
        this.workletModuleLoaded = true;
      }

      this.streamingProcessor = new AudioWorkletNode(audioContext, "pcm-streaming-processor");

      // Route PCM chunks to sherpa-onnx in main process (instead of Deepgram)
      this.streamingProcessor.port.onmessage = (event) => {
        if (!this.isStreaming) return;
        const payload = event.data;
        if (payload?.type === "audio-data") {
          this.emitAudioLevel(payload.level || 0);
          window.electronAPI.sherpaStreamingSend(payload.buffer);
          return;
        }
        this.emitAudioLevel(0);
        window.electronAPI.sherpaStreamingSend(payload);
      };

      this.isStreaming = true;
      this.streamingSource.connect(this.streamingProcessor);
      const tPipeline = performance.now();

      // 4. Register IPC event listeners for partial/final transcripts
      this.streamingFinalText = "";
      this.streamingPartialText = "";
      this.streamingHasRecognizedSpeech = false;
      this.streamingAutoStopTriggered = false;

      const partialCleanup = window.electronAPI.onSherpaPartialTranscript((text) => {
        if (text?.trim()) {
          this.markLocalStreamingSpeechDetected("partial");
        }
        this.streamingPartialText = text;
        this.onPartialTranscript?.(text);
      });

      const finalCleanup = window.electronAPI.onSherpaFinalTranscript((text) => {
        if (text?.trim()) {
          this.markLocalStreamingSpeechDetected("final");
        }
        this.streamingFinalText = text;
        this.streamingPartialText = "";
        this.onPartialTranscript?.(text);
      });

      const autoStopCleanup = window.electronAPI.onSherpaAutoStop?.((payload) => {
        if (!this.isStreaming || this.streamingAutoStopTriggered) {
          return;
        }

        this.streamingAutoStopTriggered = true;
        this.clearLocalStreamingAutoStopTimer();
        logger.info("Local streaming auto-stop requested", payload || {}, "sherpa-streaming");
        this.stopLocalStreamingRecording().catch((error) => {
          logger.error(
            "Failed to stop local streaming after VAD auto-stop request",
            { error: error.message },
            "sherpa-streaming"
          );
        });
      });

      const errorCleanup = window.electronAPI.onSherpaError((error) => {
        logger.error("Sherpa streaming error", { error }, "sherpa-streaming");
        this.onError?.({
          title: "Local Streaming Error",
          description: error,
        });
      });

      this.streamingCleanupFns = [partialCleanup, finalCleanup, autoStopCleanup, errorCleanup];
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.emitStateChange({ stage: "recording" });
      this.scheduleLocalStreamingInitialSilenceTimeout();

      logger.info(
        "Local streaming start timing",
        {
          sherpaStartMs: Math.round(tSherpa - t0),
          getUserMediaMs: Math.round(tMedia - tSherpa),
          pipelineMs: Math.round(tPipeline - tMedia),
          totalMs: Math.round(tPipeline - t0),
          modelId,
        },
        "sherpa-streaming"
      );

      this.streamingStartInProgress = false;
      if (this.stopRequestedDuringStreamingStart) {
        this.stopRequestedDuringStreamingStart = false;
        logger.debug("Applying deferred stop during local streaming startup", {}, "sherpa-streaming");
        return this.stopLocalStreamingRecording();
      }
      return true;
    } catch (error) {
      this.streamingStartInProgress = false;
      this.stopRequestedDuringStreamingStart = false;
      this.emitCallTrace("recording", "error", { mode: "local-streaming", error: error.message });
      this.finalizeTrace("error", { mode: "local-streaming", error: error.message });
      logger.error("Failed to start local streaming", { error: error.message }, "sherpa-streaming");

      let errorTitle = "Local Streaming Error";
      let errorDescription = `Failed to start local streaming: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      this.lastLocalStreamingStartFailure = {
        title: errorTitle,
        description: errorDescription,
        error: error.message,
      };

      await this.cleanupStreaming();
      this.isRecording = false;
      this.recordingStartTime = null;
      this.emitAudioLevel(0);
      this.emitStateChange({ stage: "idle" });
      return false;
    }
  }

  /**
   * Stop local streaming recording and process the final text.
   */
  async stopLocalStreamingRecording(isCancelled = false) {
    if (this.streamingStartInProgress) {
      this.stopRequestedDuringStreamingStart = true;
      logger.debug("Local streaming stop requested while start is in progress", {}, "sherpa-streaming");
      return true;
    }

    if (!this.isStreaming) return false;
    this.clearLocalStreamingAutoStopTimer();
    this.emitAudioLevel(0);

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;

    const t0 = performance.now();
    const timings = {
      transcriptionProcessingDurationMs: null,
      reasoningProcessingDurationMs: null,
    };

    // 1. Update UI – set isProcessing=true BEFORE isStreaming goes false
    //    so the floating bar never sees all-false and auto-hides.
    this.isRecording = false;
    this.isProcessing = !isCancelled;
    this.recordingStartTime = null;
    this.emitStateChange(isCancelled ? { stage: "idle" } : { stage: "transcribing" });

    if (isCancelled) {
      if (this.streamingProcessor) {
        try {
          this.streamingProcessor.port.postMessage("stop");
          this.streamingProcessor.disconnect();
        } catch (e) { /* ignore */ }
        this.streamingProcessor = null;
      }
      if (this.streamingSource) {
        try { this.streamingSource.disconnect(); } catch (e) { /* ignore */ }
        this.streamingSource = null;
      }
      this.streamingAudioContext = null;

      if (this.streamingStream) {
        this.streamingStream.getTracks().forEach((track) => track.stop());
        this.streamingStream = null;
      }

      await window.electronAPI.sherpaStreamingStop().catch(() => {});
      this.isStreaming = false;
      this.cleanupStreamingListeners();
      this.emitCallTrace("recording", "cancelled", { mode: "local-streaming" });
      this.finalizeTrace("cancelled", { reason: "user_cancelled" });
      return false;
    }

    this.emitCallTrace("recording", "success", {
      mode: "local-streaming",
      recordingDurationMs:
        typeof durationSeconds === "number" && durationSeconds >= 0
          ? Math.round(durationSeconds * 1000)
          : null,
    });

    // 2. Stop AudioWorklet processor (flushes remaining buffer)
    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) { /* ignore */ }
      this.streamingProcessor = null;
    }
    if (this.streamingSource) {
      try { this.streamingSource.disconnect(); } catch (e) { /* ignore */ }
      this.streamingSource = null;
    }
    this.streamingAudioContext = null;

    // Stop mic
    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }

    // 3. Brief wait for final chunks to reach main process
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.isStreaming = false;

    // 4. Stop sherpa-onnx and get final text
    const stopResult = await window.electronAPI.sherpaStreamingStop().catch((e) => {
      logger.debug("Sherpa stop error", { error: e.message }, "sherpa-streaming");
      return { success: false };
    });
    const tStop = performance.now();

    let finalText = stopResult?.text || this.streamingFinalText || "";

    if (!finalText && this.streamingPartialText) {
      finalText = this.streamingPartialText;
      logger.debug("Using partial text as fallback", { textLength: finalText.length }, "sherpa-streaming");
    }

    this.cleanupStreamingListeners();

    timings.transcriptionProcessingDurationMs = Math.max(0, Math.round(tStop - t0));

    logger.info(
      "Local streaming stop timing",
      {
        durationSeconds,
        totalStopMs: Math.round(tStop - t0),
        textLength: finalText.length,
      },
      "sherpa-streaming"
    );

    // 5. Optional: reasoning/polish pass
    const useReasoningModel = this.getBooleanSetting("useReasoningModel", true);
    if (useReasoningModel && finalText) {
      this.emitStateChange({ stage: "polishing" });
      const reasoningStart = performance.now();
      try {
        const agentName = localStorage.getItem("agentName") || "";
        const {
          cloudReasoningMode,
          reasoningModel,
          reasoningProvider,
        } = this.getEffectiveReasoningTarget();

        this.emitCallTrace("reasoning", "start", { reasoningProvider, reasoningModel });

        if (isChordVoxCloudMode(cloudReasoningMode)) {
          const reasonResult = await withSessionRefresh(async () => {
            const res = await window.electronAPI.cloudReason(finalText, {
              agentName,
              customDictionary: this.getCustomDictionaryArray(),
              customPrompt: this.getFastCleanupPrompt(agentName, finalText),
              language: this.getStringSetting("preferredLanguage", "auto"),
              locale: localStorage.getItem("uiLanguage") || "en",
            });
            if (!res.success) {
              const err = new Error(res.error || "Cloud reasoning failed");
              err.code = res.code;
              throw err;
            }
            return res;
          });
          if (reasonResult.success && reasonResult.text) {
            finalText = reasonResult.text;
          }
          timings.reasoningProcessingDurationMs = Math.max(
            0,
            Math.round(performance.now() - reasoningStart)
          );
          this.emitCallTrace("reasoning", "success", {
            reasoningProvider,
            reasoningModel: reasonResult.model || reasoningModel,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          });
        } else if (reasoningModel) {
          const result = await this.processWithReasoningModel(finalText, reasoningModel, agentName, {
            providerOverride: reasoningProvider,
            promptMode: "fast-cleanup",
          });
          if (result) finalText = result;
          timings.reasoningProcessingDurationMs = Math.max(
            0,
            Math.round(performance.now() - reasoningStart)
          );
          this.emitCallTrace("reasoning", "success", {
            reasoningProvider,
            reasoningModel,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          });
        } else {
          timings.reasoningProcessingDurationMs = Math.max(
            0,
            Math.round(performance.now() - reasoningStart)
          );
          this.emitCallTrace("reasoning", "skipped", {
            reason: "No reasoning model selected",
            reasoningProvider,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          });
        }
      } catch (reasonError) {
        timings.reasoningProcessingDurationMs = Math.max(
          0,
          Math.round(performance.now() - reasoningStart)
        );
        this.emitCallTrace("reasoning", "error", {
          error: reasonError.message,
          reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
        });
        logger.error("Local streaming reasoning failed", { error: reasonError.message }, "sherpa-streaming");
      }
    }

    // 6. Deliver final text
    if (finalText) {
      this.emitCallTrace("transcription", "success", {
        source: "sherpa-streaming",
        transcriptionProvider: "sherpa-onnx",
        transcriptionModel: this.getLocalStreamingModelId(),
        transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
        reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
      });
      await Promise.resolve(this.onTranscriptionComplete?.({
        success: true,
        text: finalText,
        source: "sherpa-streaming",
        timings,
        traceId: this.currentTraceId,
        profileId: this.activeHotkeyProfileId,
      }));
    } else {
      this.emitCallTrace("transcription", "error", {
        source: "sherpa-streaming",
        error: "No text transcribed from local streaming session",
        transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
      });
      this.finalizeTrace("error", {
        source: "sherpa-streaming",
        error: "No text transcribed",
        transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
      });
    }

    this.isProcessing = false;
    this.emitStateChange({ stage: "idle" });
    return true;
  }

  async startStreamingRecording() {
    try {
      if (this.streamingStartInProgress) {
        return false;
      }
      this.streamingStartInProgress = true;

      if (this.isRecording || this.isStreaming || this.isProcessing) {
        this.streamingStartInProgress = false;
        return false;
      }

      const trace = this.ensureTraceContext();
      if (trace.created) {
        this.emitCallTrace("session", "start", { mode: "streaming" }, { runId: trace.runId });
      }
      this.emitCallTrace("recording", "start", { mode: "streaming" }, { runId: trace.runId });
      void this.warmupReasoningConnection();

      this.stopRequestedDuringStreamingStart = false;

      const t0 = performance.now();
      const constraints = await this.getAudioConstraints();
      const tConstraints = performance.now();

      // 1. Get mic stream (can take 10-15s on cold macOS mic driver)
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const tMedia = performance.now();

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Streaming recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            usedCachedId: !!this.cachedMicDeviceId,
          },
          "audio"
        );
      }

      // Start fallback recorder in case streaming produces no results
      try {
        this.streamingFallbackChunks = [];
        this.streamingFallbackRecorder = new MediaRecorder(stream);
        this.streamingFallbackRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.streamingFallbackChunks.push(e.data);
        };
        this.streamingFallbackRecorder.start();
      } catch (e) {
        logger.debug("Fallback recorder failed to start", { error: e.message }, "streaming");
        this.streamingFallbackRecorder = null;
      }

      // 2. Set up audio pipeline so frames flow the instant WebSocket is ready.
      //    Frames sent before WebSocket connects are silently dropped by sendAudio().
      const audioContext = await this.getOrCreateAudioContext();
      this.streamingAudioContext = audioContext;
      this.streamingSource = audioContext.createMediaStreamSource(stream);
      this.streamingStream = stream;

      if (!this.workletModuleLoaded) {
        await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
        this.workletModuleLoaded = true;
      }

      this.streamingProcessor = new AudioWorkletNode(audioContext, "pcm-streaming-processor");

      this.streamingProcessor.port.onmessage = (event) => {
        if (!this.isStreaming) return;
        const payload = event.data;
        if (payload?.type === "audio-data") {
          this.emitAudioLevel(payload.level || 0);
          window.electronAPI.deepgramStreamingSend(payload.buffer);
          return;
        }
        this.emitAudioLevel(0);
        window.electronAPI.deepgramStreamingSend(payload);
      };

      this.isStreaming = true;
      this.streamingSource.connect(this.streamingProcessor);
      const tPipeline = performance.now();

      // 3. Register IPC event listeners BEFORE connecting, so no transcript
      //    events are lost during the connect handshake.
      this.streamingFinalText = "";
      this.streamingPartialText = "";
      this.streamingTextResolve = null;
      this.streamingTextDebounce = null;

      const partialCleanup = window.electronAPI.onDeepgramPartialTranscript((text) => {
        this.streamingPartialText = text;
        this.onPartialTranscript?.(text);
      });

      const finalCleanup = window.electronAPI.onDeepgramFinalTranscript((text) => {
        this.streamingFinalText = text;
        this.streamingPartialText = "";
        this.onPartialTranscript?.(text);
      });

      const errorCleanup = window.electronAPI.onDeepgramError((error) => {
        logger.error("Deepgram streaming error", { error }, "streaming");
        this.onError?.({
          title: "Streaming Error",
          description: error,
        });
        if (this.isStreaming) {
          logger.warn("Connection lost during streaming, auto-stopping", {}, "streaming");
          this.stopStreamingRecording().catch((e) => {
            logger.error(
              "Auto-stop after connection loss failed",
              { error: e.message },
              "streaming"
            );
          });
        }
      });

      const sessionEndCleanup = window.electronAPI.onDeepgramSessionEnd((data) => {
        logger.debug("Deepgram session ended", data, "streaming");
        if (data.text) {
          this.streamingFinalText = data.text;
        }
      });

      this.streamingCleanupFns = [partialCleanup, finalCleanup, errorCleanup, sessionEndCleanup];
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.emitStateChange({ stage: "recording" });

      // 4. Connect WebSocket — audio is already flowing from the pipeline above,
      //    so Deepgram receives data immediately (no idle timeout).
      const result = await withSessionRefresh(async () => {
        const preferredLang = this.getStringSetting("preferredLanguage", "auto");
        const res = await window.electronAPI.deepgramStreamingStart({
          sampleRate: 16000,
          language: preferredLang && preferredLang !== "auto" ? preferredLang : undefined,
          keyterms: this.getKeyterms(),
        });

        if (!res.success) {
          if (res.code === "NO_API") {
            return { needsFallback: true };
          }
          const err = new Error(res.error || "Failed to start streaming session");
          err.code = res.code;
          throw err;
        }
        return res;
      });
      const tWs = performance.now();

      if (result.needsFallback) {
        this.isRecording = false;
        this.recordingStartTime = null;
        this.stopRequestedDuringStreamingStart = false;
        await this.cleanupStreaming();
        this.emitStateChange({ stage: "idle" });
        this.streamingStartInProgress = false;
        logger.debug(
          "Streaming API not configured, falling back to regular recording",
          {},
          "streaming"
        );
        return this.startRecording();
      }

      logger.info(
        "Streaming start timing",
        {
          constraintsMs: Math.round(tConstraints - t0),
          getUserMediaMs: Math.round(tMedia - tConstraints),
          pipelineMs: Math.round(tPipeline - tMedia),
          wsConnectMs: Math.round(tWs - tPipeline),
          totalMs: Math.round(tWs - t0),
          usedWarmConnection: result.usedWarmConnection,
          micDriverWarmedUp: !!this.micDriverWarmedUp,
        },
        "streaming"
      );

      this.streamingStartInProgress = false;
      if (this.stopRequestedDuringStreamingStart) {
        this.stopRequestedDuringStreamingStart = false;
        logger.debug("Applying deferred streaming stop requested during startup", {}, "streaming");
        return this.stopStreamingRecording();
      }
      return true;
    } catch (error) {
      this.streamingStartInProgress = false;
      this.stopRequestedDuringStreamingStart = false;
      this.emitCallTrace("recording", "error", { mode: "streaming", error: error.message });
      this.finalizeTrace("error", { mode: "streaming", error: error.message });
      logger.error("Failed to start streaming recording", { error: error.message }, "streaming");

      let errorTitle = "Streaming Error";
      let errorDescription = `Failed to start streaming: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.code === "AUTH_EXPIRED" || error.code === "AUTH_REQUIRED") {
        errorTitle = "Sign-in Required";
        errorDescription =
          "Your ChordVox Cloud session is unavailable. Please sign in again from Settings.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });

      await this.cleanupStreaming();
      this.isRecording = false;
      this.recordingStartTime = null;
      this.emitAudioLevel(0);
      this.emitStateChange({ stage: "idle" });
      return false;
    }
  }

  async stopStreamingRecording(isCancelled = false) {
    if (this.streamingStartInProgress) {
      this.stopRequestedDuringStreamingStart = true;
      logger.debug("Streaming stop requested while start is in progress", {}, "streaming");
      return true;
    }

    if (!this.isStreaming) return false;
    this.emitAudioLevel(0);

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;

    const t0 = performance.now();
    const timings = {
      transcriptionProcessingDurationMs: null,
      reasoningProcessingDurationMs: null,
    };
    let finalText = this.streamingFinalText || "";

    // 1. Update UI immediately – set isProcessing=true BEFORE isStreaming goes false
    //    so the floating bar never sees all-false and auto-hides.
    this.isRecording = false;
    this.isProcessing = !isCancelled;
    this.recordingStartTime = null;
    this.emitStateChange(isCancelled ? { stage: "idle" } : { stage: "transcribing" });

    if (isCancelled) {
      if (this.streamingProcessor) {
        try {
          this.streamingProcessor.port.postMessage("stop");
          this.streamingProcessor.disconnect();
        } catch (e) { /* ignore */ }
        this.streamingProcessor = null;
      }
      if (this.streamingSource) {
        try { this.streamingSource.disconnect(); } catch (e) { /* ignore */ }
        this.streamingSource = null;
      }
      this.streamingAudioContext = null;
      
      if (this.streamingStream) {
        this.streamingStream.getTracks().forEach((track) => track.stop());
        this.streamingStream = null;
      }
      if (this.getTranscriptionProvider() === "gemini") {
        if (this.geminiLiveSocket) {
          try { this.geminiLiveSocket.close(); } catch (e) {}
          this.geminiLiveSocket = null;
        }
      } else if (this.cloudSocket) {
        try { this.cloudSocket.close(1000, "canceled"); } catch (e) {}
        this.cloudSocket = null;
      }
      this.isStreaming = false;
      this.cleanupStreamingListeners();
      this.emitCallTrace("recording", "cancelled", { mode: "cloud-streaming" });
      this.finalizeTrace("cancelled", { reason: "user_cancelled" });
      return false;
    }

    this.emitCallTrace("recording", "success", {
      mode: "streaming",
      recordingDurationMs:
        typeof durationSeconds === "number" && durationSeconds >= 0
          ? Math.round(durationSeconds * 1000)
          : null,
    });

    // 2. Stop the processor — it flushes its remaining buffer on "stop".
    //    Keep isStreaming TRUE so the port.onmessage handler forwards the flush to WebSocket.
    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }
    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }
    this.streamingAudioContext = null;

    // Stop fallback recorder before stopping media tracks
    let fallbackBlob = null;
    if (this.streamingFallbackRecorder?.state === "recording") {
      fallbackBlob = await new Promise((resolve) => {
        this.streamingFallbackRecorder.onstop = () => {
          const mimeType = this.streamingFallbackRecorder.mimeType || "audio/webm";
          resolve(new Blob(this.streamingFallbackChunks, { type: mimeType }));
        };
        this.streamingFallbackRecorder.stop();
      });
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }
    const tAudioCleanup = performance.now();

    // 3. Wait for flushed buffer to travel: port → main thread → IPC → WebSocket → server.
    //    Then mark streaming done so no further audio is forwarded.
    await new Promise((resolve) => setTimeout(resolve, 120));
    this.isStreaming = false;

    // 4. Finalize tells Deepgram to process any buffered audio and send final Results.
    //    Wait briefly so the server sends back the from_finalize transcript before
    //    CloseStream triggers connection close.
    window.electronAPI.deepgramStreamingFinalize?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const tForceEndpoint = performance.now();

    const stopResult = await window.electronAPI.deepgramStreamingStop().catch((e) => {
      logger.debug("Streaming disconnect error", { error: e.message }, "streaming");
      return { success: false };
    });
    const tTerminate = performance.now();

    finalText = this.streamingFinalText || "";

    if (!finalText && this.streamingPartialText) {
      finalText = this.streamingPartialText;
      logger.debug("Using partial text as fallback", { textLength: finalText.length }, "streaming");
    }

    if (!finalText && stopResult?.text) {
      finalText = stopResult.text;
      logger.debug(
        "Using disconnect result text as fallback",
        { textLength: finalText.length },
        "streaming"
      );
    }

    this.cleanupStreamingListeners();

    timings.transcriptionProcessingDurationMs = Math.max(0, Math.round(tTerminate - t0));

    logger.info(
      "Streaming stop timing",
      {
        durationSeconds,
        audioCleanupMs: Math.round(tAudioCleanup - t0),
        flushWaitMs: Math.round(tForceEndpoint - tAudioCleanup),
        terminateRoundTripMs: Math.round(tTerminate - tForceEndpoint),
        totalStopMs: Math.round(tTerminate - t0),
        textLength: finalText.length,
      },
      "streaming"
    );

    const useReasoningModel = this.getBooleanSetting("useReasoningModel", true);
    if (useReasoningModel && finalText) {
      this.emitStateChange({ stage: "polishing" });
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || "";
      const {
        cloudReasoningMode,
        reasoningModel,
        reasoningProvider,
      } = this.getEffectiveReasoningTarget();

      this.emitCallTrace("reasoning", "start", {
        reasoningProvider,
        reasoningModel,
      });

      try {
        if (isChordVoxCloudMode(cloudReasoningMode)) {
          const reasonResult = await withSessionRefresh(async () => {
            const res = await window.electronAPI.cloudReason(finalText, {
              agentName,
              customDictionary: this.getCustomDictionaryArray(),
              customPrompt: this.getFastCleanupPrompt(agentName, finalText),
              language: this.getStringSetting("preferredLanguage", "auto"),
              locale: localStorage.getItem("uiLanguage") || "en",
            });
            if (!res.success) {
              const err = new Error(res.error || "Cloud reasoning failed");
              err.code = res.code;
              throw err;
            }
            return res;
          });

          if (reasonResult.success && reasonResult.text) {
            finalText = reasonResult.text;
          }

          logger.info(
            "Streaming reasoning complete",
            {
              reasoningDurationMs: Math.round(performance.now() - reasoningStart),
              model: reasonResult.model,
            },
            "streaming"
          );
          timings.reasoningProcessingDurationMs = Math.max(
            0,
            Math.round(performance.now() - reasoningStart)
          );
          this.emitCallTrace("reasoning", "success", {
            reasoningProvider,
            reasoningModel: reasonResult.model || reasoningModel,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          });
        } else if (reasoningModel) {
          const result = await this.processWithReasoningModel(
            finalText,
            reasoningModel,
            agentName,
            {
              providerOverride: reasoningProvider,
              promptMode: "fast-cleanup",
            }
          );
          if (result) {
            finalText = result;
          }
          logger.info(
            "Streaming BYOK reasoning complete",
            { reasoningDurationMs: Math.round(performance.now() - reasoningStart) },
            "streaming"
          );
          timings.reasoningProcessingDurationMs = Math.max(
            0,
            Math.round(performance.now() - reasoningStart)
          );
          this.emitCallTrace("reasoning", "success", {
            reasoningProvider,
            reasoningModel,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          });
        } else {
          timings.reasoningProcessingDurationMs = Math.max(
            0,
            Math.round(performance.now() - reasoningStart)
          );
          this.emitCallTrace("reasoning", "skipped", {
            reason: "No reasoning model selected",
            reasoningProvider,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          });
        }
      } catch (reasonError) {
        timings.reasoningProcessingDurationMs = Math.max(
          0,
          Math.round(performance.now() - reasoningStart)
        );
        this.emitCallTrace("reasoning", "error", {
          reasoningProvider,
          reasoningModel,
          error: reasonError.message,
          reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
        });
        logger.error(
          "Streaming reasoning failed, using raw text",
          { error: reasonError.message },
          "streaming"
        );
      }
    } else {
      this.emitCallTrace("reasoning", "skipped", {
        reason: useReasoningModel ? "No text for reasoning" : "Reasoning disabled",
      });
    }

    // If streaming produced no text, fall back to batch transcription
    if (!finalText && durationSeconds > 2 && fallbackBlob?.size > 0) {
      logger.info(
        "Streaming produced no text, falling back to batch transcription",
        { durationSeconds, blobSize: fallbackBlob.size },
        "streaming"
      );
      try {
        const batchResult = await this.processWithChordVoxCloud(fallbackBlob, {
          durationSeconds,
        });
        if (batchResult?.text) {
          finalText = batchResult.text;
          const fallbackTranscriptionMs =
            batchResult?.timings?.transcriptionProcessingDurationMs ?? 0;
          const fallbackReasoningMs =
            batchResult?.timings?.reasoningProcessingDurationMs ?? null;
          timings.transcriptionProcessingDurationMs =
            (timings.transcriptionProcessingDurationMs ?? 0) + fallbackTranscriptionMs;
          if (fallbackReasoningMs !== null && fallbackReasoningMs !== undefined) {
            timings.reasoningProcessingDurationMs = fallbackReasoningMs;
          }
          logger.info("Batch fallback succeeded", { textLength: finalText.length }, "streaming");
        }
      } catch (fallbackErr) {
        logger.error("Batch fallback failed", { error: fallbackErr.message }, "streaming");
      }
    }

    if (finalText) {
      const tBeforePaste = performance.now();
      this.emitCallTrace("transcription", "success", {
        source: "deepgram-streaming",
        transcriptionProvider: "deepgram-streaming",
        transcriptionModel: "deepgram-streaming",
        transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
        reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
      });
      await Promise.resolve(this.onTranscriptionComplete?.({
        success: true,
        text: finalText,
        source: "deepgram-streaming",
        timings,
        traceId: this.currentTraceId,
        profileId: this.activeHotkeyProfileId,
      }));

      logger.info(
        "Streaming total processing",
        {
          totalProcessingMs: Math.round(tBeforePaste - t0),
          hasReasoning: useReasoningModel,
        },
        "streaming"
      );
    } else {
      this.emitCallTrace("transcription", "error", {
        source: "deepgram-streaming",
        error: "No text transcribed from streaming session",
        transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
      });
      this.finalizeTrace("error", {
        source: "deepgram-streaming",
        error: "No text transcribed from streaming session",
        transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
      });
    }

    this.isProcessing = false;
    this.emitStateChange({ stage: "idle" });

    if (this.shouldUseStreaming()) {
      this.warmupStreamingConnection().catch((e) => {
        logger.debug("Background re-warm failed", { error: e.message }, "streaming");
      });
    }

    return true;
  }

  cleanupStreamingAudio() {
    if (this.streamingFallbackRecorder?.state === "recording") {
      try {
        this.streamingFallbackRecorder.stop();
      } catch { }
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];

    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }

    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }

    this.streamingAudioContext = null;

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }

    this.isStreaming = false;
  }

  cleanupStreamingListeners() {
    for (const cleanup of this.streamingCleanupFns) {
      try {
        cleanup?.();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    clearTimeout(this.streamingTextDebounce);
    this.streamingTextDebounce = null;
    this.clearLocalStreamingAutoStopTimer();
    this.streamingHasRecognizedSpeech = false;
    this.streamingAutoStopTriggered = false;
    this.emitAudioLevel(0);
  }

  async cleanupStreaming() {
    this.cleanupStreamingAudio();
    this.cleanupStreamingListeners();
  }

  cleanup() {
    this.resetProgressState();
    if (this.isStreaming) {
      this.cleanupStreaming();
    }
    if (this.mediaRecorder?.state === "recording") {
      this.stopRecording();
    }
    this.stopRecordingLevelMonitor();
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      this.persistentAudioContext.close().catch(() => { });
      this.persistentAudioContext = null;
      this.workletModuleLoaded = false;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    try {
      window.electronAPI?.deepgramStreamingStop?.();
    } catch (e) {
      // Ignore errors during cleanup (page may be unloading)
    }
    try {
      window.electronAPI?.sherpaStreamingStop?.();
    } catch (e) {
      // Ignore errors during cleanup (page may be unloading)
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onAudioLevel = null;
    this.onProgress = null;
    if (this._onApiKeyChanged) {
      window.removeEventListener("api-key-changed", this._onApiKeyChanged);
    }
  }
}

export default AudioManager;
