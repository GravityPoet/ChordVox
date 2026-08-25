import * as endpointUtils from "./endpointUtilsRenderer";

export type GeminiEndpointFamily = "official-google" | "chordvox-bridge" | "compatible" | "unknown";
export type GeminiGenerateContentEndpointInfo = {
  baseUrl: string;
  modelId: string;
  method: "generateContent" | "streamGenerateContent";
};

type EndpointUtils = {
  normalizeBaseUrl: (value?: string | null) => string;
  normalizeEndpointUrl: (value?: string | null) => string;
  getEndpointBaseUrl: (value?: string | null) => string;
  getGeminiEndpointFamily: (value?: string | null) => GeminiEndpointFamily;
  isOfficialGoogleGeminiEndpoint: (value?: string | null) => boolean;
  isChordVoxGeminiBridgeEndpoint: (value?: string | null) => boolean;
  isOpenAiCompatibleGeminiEndpoint: (value?: string | null) => boolean;
  getGeminiRequestBaseUrl: (value?: string | null) => string;
  getGeminiGenerateContentEndpointInfo: (
    value?: string | null
  ) => GeminiGenerateContentEndpointInfo | null;
  isGeminiGenerateContentEndpoint: (value?: string | null) => boolean;
  buildGeminiGenerateContentUrl: (endpointOrBase: string, modelId: string) => string;
  buildGeminiStreamGenerateContentUrl: (endpointOrBase: string, modelId: string) => string;
  buildApiUrl: (base: string, path: string) => string;
  buildModelsUrl: (endpointOrBase: string) => string;
};

const sharedEndpointUtils = endpointUtils as EndpointUtils;

// API Configuration helpers
export const normalizeBaseUrl = sharedEndpointUtils.normalizeBaseUrl;
export const normalizeEndpointUrl = sharedEndpointUtils.normalizeEndpointUrl;
export const getEndpointBaseUrl = sharedEndpointUtils.getEndpointBaseUrl;
export const getGeminiEndpointFamily = sharedEndpointUtils.getGeminiEndpointFamily;
export const isOfficialGoogleGeminiEndpoint = sharedEndpointUtils.isOfficialGoogleGeminiEndpoint;
export const isChordVoxGeminiBridgeEndpoint = sharedEndpointUtils.isChordVoxGeminiBridgeEndpoint;
export const isOpenAiCompatibleGeminiEndpoint =
  sharedEndpointUtils.isOpenAiCompatibleGeminiEndpoint;
export const getGeminiRequestBaseUrl = sharedEndpointUtils.getGeminiRequestBaseUrl;
export const getGeminiGenerateContentEndpointInfo =
  sharedEndpointUtils.getGeminiGenerateContentEndpointInfo;
export const isGeminiGenerateContentEndpoint = sharedEndpointUtils.isGeminiGenerateContentEndpoint;
export const buildGeminiGenerateContentUrl = sharedEndpointUtils.buildGeminiGenerateContentUrl;
export const buildGeminiStreamGenerateContentUrl =
  sharedEndpointUtils.buildGeminiStreamGenerateContentUrl;
export const buildApiUrl = sharedEndpointUtils.buildApiUrl;
export const buildModelsUrl = sharedEndpointUtils.buildModelsUrl;

const env = (typeof import.meta !== "undefined" && (import.meta as any).env) || {};

const computeBaseUrl = (candidates: Array<string | undefined>, fallback: string): string => {
  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return fallback;
};

const DEFAULT_OPENAI_BASE = computeBaseUrl(
  [env.CHORDVOX_OPENAI_BASE_URL as string | undefined, env.OPENAI_BASE_URL as string | undefined],
  "https://api.openai.com/v1"
);

const DEFAULT_TRANSCRIPTION_BASE = computeBaseUrl(
  [
    env.CHORDVOX_TRANSCRIPTION_BASE_URL as string | undefined,
    env.WHISPER_BASE_URL as string | undefined,
  ],
  DEFAULT_OPENAI_BASE
);

export const API_ENDPOINTS = {
  OPENAI_BASE: DEFAULT_OPENAI_BASE,
  OPENAI: buildApiUrl(DEFAULT_OPENAI_BASE, "/responses"),
  OPENAI_MODELS: buildApiUrl(DEFAULT_OPENAI_BASE, "/models"),
  ANTHROPIC: "https://api.anthropic.com/v1/messages",
  GEMINI: "https://generativelanguage.googleapis.com/v1beta",
  GROQ_BASE: "https://api.groq.com/openai/v1",
  CEREBRAS_BASE: "https://api.cerebras.ai/v1",
  DOUBAO_ASR_WS: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream",
  SONIOX_ASR_WS: "wss://stt-rt.soniox.com/transcribe-websocket",
  DEEPGRAM_LISTEN: "https://api.deepgram.com/v1/listen",
  GOOGLE_CLOUD_STT_RECOGNIZE:
    "https://us-speech.googleapis.com/v2/projects/PROJECT_ID/locations/us/recognizers/_:recognize",
  TRANSCRIPTION_BASE: DEFAULT_TRANSCRIPTION_BASE,
  TRANSCRIPTION: buildApiUrl(DEFAULT_TRANSCRIPTION_BASE, "/audio/transcriptions"),
} as const;

export const API_VERSIONS = {
  ANTHROPIC: "2023-06-01",
  GEMINI: "v1beta",
} as const;

// Model Configuration
export const MODEL_CONSTRAINTS = {
  MIN_FILE_SIZE: 1_000_000, // 1MB minimum for valid model files
  MODEL_TEST_TIMEOUT: 5000, // 5 seconds for model validation
  INFERENCE_TIMEOUT: 30000, // 30 seconds default (configurable)
} as const;

// Token Limits
export const TOKEN_LIMITS = {
  MIN_TOKENS: 100,
  MAX_TOKENS: 2048,
  MIN_TOKENS_ANTHROPIC: 100,
  MAX_TOKENS_ANTHROPIC: 4096,
  MIN_TOKENS_GEMINI: 100,
  MAX_TOKENS_GEMINI: 8192,
  TOKEN_MULTIPLIER: 2, // text.length * multiplier
  REASONING_CONTEXT_SIZE: 4096,
} as const;

// Cache Configuration
export const CACHE_CONFIG = {
  API_KEY_TTL: 3600000, // 1 hour in milliseconds
  MODEL_CACHE_SIZE: 3, // Maximum models to keep in memory
  AVAILABILITY_CHECK_TTL: 30000, // 30s for accessibility, FFmpeg, tool availability checks
  PASTE_DELAY_MS: 50, // Delay before paste simulation to allow clipboard to settle
} as const;

// ChordVox Cloud API
export const CHORDVOX_API_URL = (env.VITE_CHORDVOX_API_URL as string) || "";

// Retry Configuration
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY: 1000, // 1 second
  MAX_DELAY: 10000, // 10 seconds
  BACKOFF_MULTIPLIER: 2,
} as const;
