import { getModelProvider, isLocalReasoningProviderId } from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { parseSseStream, createProgressThrottle, createSsePayloadParser } from "./sseStreamParser";
import { SecureCache } from "../utils/SecureCache";
import { withRetry, createApiRetryStrategy } from "../utils/retry";
import {
  API_ENDPOINTS,
  TOKEN_LIMITS,
  buildGeminiGenerateContentUrl,
  buildApiUrl,
  getGeminiEndpointFamily,
  getGeminiRequestBaseUrl,
  isOpenAiCompatibleGeminiEndpoint,
  normalizeBaseUrl,
  normalizeEndpointUrl,
} from "../config/constants";
import logger from "../utils/logger";
import { isSecureEndpoint } from "../utils/urlUtils";
import { signRequest } from "../utils/awsSigV4";
import { buildContextInjectionPrompt } from "../config/prompts";
import {
  CHORDVOX_CLOUD_MODEL,
  CHORDVOX_CLOUD_PROVIDER,
  isHostedCloudModeEnabled,
  normalizeAvailableCloudMode,
  normalizeAvailableCloudProvider,
} from "../utils/chordvoxCloud";
import {
  CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL,
  normalizeCustomReasoningProtocol,
  type CustomReasoningProtocol,
} from "../utils/customReasoningProtocol";
import type { LicenseStatusResult } from "../types/electron";
import {
  getAnthropicOutputEffort,
  getCerebrasReasoningEffort,
  getCustomOpenAiReasoningEffort,
  getGeminiOpenAiReasoningEffort,
  getGeminiThinkingConfig,
  getGroqReasoningEffort,
  getLocalThinkingBudget,
  getOpenAiReasoningEffort,
  getOpenRouterReasoningEffort,
  getReasoningTemperature,
  isOpenAiReasoningModel,
  resolveReasoningPolicy,
  type ReasoningEffort,
  type ReasoningPolicy,
} from "./reasoningPolicy";

type ApiKeyProvider =
  | "openai"
  | "openrouter"
  | "anthropic"
  | "gemini"
  | "groq"
  | "cerebras"
  | "bedrock"
  | "custom";

type CachedApiKeyProvider = Exclude<ApiKeyProvider, "bedrock" | "custom">;

const API_KEY_PROVIDER_BY_STORAGE_KEY: Readonly<Record<string, CachedApiKeyProvider>> = {
  openaiApiKey: "openai",
  openrouterApiKey: "openrouter",
  anthropicApiKey: "anthropic",
  geminiApiKey: "gemini",
  groqApiKey: "groq",
  cerebrasApiKey: "cerebras",
};

type ReasoningFetchOptions = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  stream?: boolean;
};

type ReasoningProxyResult = {
  success: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  code?: string;
};

type StreamChunkHandler = {
  onPayload: (payload: string) => void;
  flush?: () => void;
};

type ReasoningAvailabilityOptions = {
  allowProPreview?: boolean;
};

type OpenAiCompatibleProvider = "openai" | "openrouter" | "custom" | "gemini-compatible";
type OpenAiProtocol = "responses" | "chat";
type OpenAiReasoningParameter = "reasoning" | "reasoning_effort";
type ParsedOpenAiError = { payload: unknown; message: string; rawText: string };
type ReasoningRequestCandidate = {
  parameter: OpenAiReasoningParameter | null;
  effort: ReasoningEffort | null;
};

const runRequestWithoutAccount = <T>(operation: () => Promise<T>): Promise<T> => operation();

type GeminiGenerateContentRequestBody = {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  generationConfig: Record<string, unknown>;
};

class ReasoningService extends BaseReasoningService {
  private apiKeyCache: SecureCache<string>;
  // Deduplicates concurrent getApiKey calls so reasoning bursts don't trigger
  // parallel IPC + decryption round-trips for the same provider.
  private pendingApiKeyFetches = new Map<ApiKeyProvider, Promise<string>>();
  private openAiEndpointPreference = new Map<string, "responses" | "chat">();
  private lowLatencyParamFallbackCache = new Map<string, number>();
  private lowLatencyParamFallbackCacheLoaded = false;
  private proAccessCache: { value: boolean; expiresAt: number; status: LicenseStatusResult | null };
  private static readonly OPENAI_ENDPOINT_PREF_STORAGE_KEY = "openAiEndpointPreference";
  private static readonly CUSTOM_REASONING_PROTOCOL_STORAGE_KEY = "customReasoningProtocol";
  private static readonly LOW_LATENCY_PARAM_FALLBACK_STORAGE_KEY = "lowLatencyParamFallbackCache";
  private static readonly LOW_LATENCY_PARAM_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly LOW_LATENCY_PARAM_FALLBACK_MAX_ENTRIES = 120;
  private static readonly OPENAI_ENDPOINT_PREF_EVENT = "openai-endpoint-preference-changed";
  private static readonly OPENROUTER_BASE = "https://openrouter.ai/api/v1";
  private static readonly CEREBRAS_BASE = API_ENDPOINTS.CEREBRAS_BASE;
  private static readonly PRO_ACCESS_CACHE_TTL_MS = 5000;
  private static readonly REASONING_WARMUP_TTL_MS = 45000;
  private cacheCleanupStop: (() => void) | undefined;
  private localStorageChangeStop: (() => void) | undefined;
  private activeProcessingCount = 0;
  private reasoningWarmupPromise: Promise<boolean> | null = null;
  private reasoningWarmupExpiresAt = 0;

  constructor() {
    super();
    this.apiKeyCache = new SecureCache();
    this.proAccessCache = { value: true, expiresAt: 0, status: null };
    this.cacheCleanupStop = this.apiKeyCache.startAutoCleanup();

    if (typeof window !== "undefined") {
      this.localStorageChangeStop = window.electronAPI?.onLocalStorageChanged?.((payload) => {
        const storageKey = typeof payload?.key === "string" ? payload.key : "";
        const provider = API_KEY_PROVIDER_BY_STORAGE_KEY[storageKey];
        if (provider) {
          this.clearApiKeyCache(provider);
        }
      });
      window.addEventListener("beforeunload", () => this.destroy());
    }
  }

  private createHttpError(message: string, status: number, statusText?: string): Error {
    const error = new Error(message) as Error & {
      status?: number;
      statusCode?: number;
      response?: { status: number; statusText?: string };
    };
    error.status = status;
    error.statusCode = status;
    error.response = { status, statusText };
    return error;
  }

  private emitOpenAiPreferenceChanged(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event(ReasoningService.OPENAI_ENDPOINT_PREF_EVENT));
  }

  private getCustomReasoningProtocol(): CustomReasoningProtocol {
    if (typeof window === "undefined" || !window.localStorage) {
      return "auto";
    }
    const raw = window.localStorage.getItem(ReasoningService.CUSTOM_REASONING_PROTOCOL_STORAGE_KEY);
    return normalizeCustomReasoningProtocol(raw);
  }

  private getFastCleanupMaxTokens(text: string): number {
    const textLength = text.trim().length;
    return Math.max(160, Math.min(Math.ceil(textLength * 1.35), 768));
  }

  private getEffectiveConfig(
    text: string,
    model: string,
    provider: string,
    config: ReasoningConfig = {}
  ): ReasoningConfig {
    const baseConfig: ReasoningConfig = {
      ...config,
      disableThinking: config.disableThinking ?? config.promptMode === "fast-cleanup",
      temperature: getReasoningTemperature(model, config.temperature),
      providerOverride: config.providerOverride ?? provider ?? getModelProvider(model),
    };

    if (config.promptMode !== "fast-cleanup") {
      return baseConfig;
    }

    return {
      ...baseConfig,
      maxTokens: config.maxTokens ?? this.getFastCleanupMaxTokens(text),
    };
  }

  private getResolvedSystemPrompt(
    agentName: string | null,
    transcript: string,
    config: ReasoningConfig = {}
  ): string {
    let prompt =
      typeof config.systemPromptOverride === "string"
        ? config.systemPromptOverride
        : this.getSystemPrompt(agentName, transcript, config.promptMode || "default");

    // Inject context if available
    if (config.contextText || config.contextSummary) {
      const contextPrompt = buildContextInjectionPrompt(
        {
          appName: config.contextAppName,
          windowTitle: config.contextWindowTitle,
          visibleText: config.contextText,
          contextSummary: config.contextSummary,
        },
        this.getUiLanguage()
      );

      if (contextPrompt) {
        prompt += "\n\n" + contextPrompt;
      }
    }

    return prompt;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) {
      throw signal.reason;
    }
    const error = new Error("AI reasoning was cancelled");
    error.name = "AbortError";
    throw error;
  }

  private createLinkedRequestController(
    timeoutMs: number,
    parentSignal?: AbortSignal
  ): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      abortFromParent();
    } else {
      parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    }
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    return {
      controller,
      cleanup: () => {
        clearTimeout(timeoutId);
        parentSignal?.removeEventListener("abort", abortFromParent);
      },
    };
  }

  private getCancellableProgress(
    onProgress: ReasoningConfig["onProgress"],
    signal?: AbortSignal
  ): ReasoningConfig["onProgress"] {
    if (typeof onProgress !== "function") return undefined;
    return (partial) => {
      if (!signal?.aborted) {
        onProgress(partial);
      }
    };
  }

  private shouldFallbackGeminiFastCleanup(
    originalText: string,
    cleanedText: string,
    config: ReasoningConfig = {}
  ): boolean {
    if (config.promptMode !== "fast-cleanup") {
      return false;
    }

    const source = originalText.trim().replace(/\s+/g, " ");
    const cleaned = cleanedText.trim().replace(/\s+/g, " ");

    if (!source || !cleaned || source === cleaned) {
      return false;
    }

    if (!source.startsWith(cleaned)) {
      return false;
    }

    const missingTail = source.slice(cleaned.length).trim();
    if (missingTail.length < 2) {
      return false;
    }

    const sourceEndsSentence = /[。！？.!?…]$/.test(source);
    const cleanedEndsSentence = /[。！？.!?…]$/.test(cleaned);

    if (sourceEndsSentence && !cleanedEndsSentence) {
      return true;
    }

    return /[，,、:：;；]$/.test(cleaned) && missingTail.length >= 4;
  }

  private getRequestReasoningPolicy(
    text: string,
    agentName: string | null,
    config: ReasoningConfig
  ): ReasoningPolicy {
    return resolveReasoningPolicy({
      text,
      agentName,
      promptMode: config.promptMode,
      disableThinking: config.disableThinking,
    });
  }

  private getOpenAiReasoningParameter(
    provider: OpenAiCompatibleProvider,
    type: OpenAiProtocol
  ): OpenAiReasoningParameter | null {
    if (type === "responses" || provider === "openrouter") return "reasoning";
    return "reasoning_effort";
  }

  private applyOpenAiReasoningEffort(
    requestBody: Record<string, unknown>,
    parameter: OpenAiReasoningParameter | null,
    effort: ReasoningEffort | null
  ): void {
    if (!parameter || !effort) return;
    if (parameter === "reasoning") {
      requestBody.reasoning = { effort };
      return;
    }
    requestBody.reasoning_effort = effort;
  }

  private removeOpenAiReasoningEffort(
    requestBody: Record<string, unknown>
  ): Record<string, unknown> {
    const nextBody = { ...requestBody };
    delete nextBody.reasoning;
    delete nextBody.reasoning_effort;
    return nextBody;
  }

  private getOpenAiReasoningEffortFromBody(
    requestBody: Record<string, unknown>
  ): ReasoningEffort | null {
    const nestedReasoning = requestBody.reasoning;
    if (nestedReasoning && typeof nestedReasoning === "object") {
      const effort = (nestedReasoning as Record<string, unknown>).effort;
      if (
        effort === "none" ||
        effort === "minimal" ||
        effort === "low" ||
        effort === "medium" ||
        effort === "high"
      ) {
        return effort;
      }
    }

    const scalarEffort = requestBody.reasoning_effort;
    if (
      scalarEffort === "none" ||
      scalarEffort === "minimal" ||
      scalarEffort === "low" ||
      scalarEffort === "medium" ||
      scalarEffort === "high"
    ) {
      return scalarEffort;
    }

    return null;
  }

  private createReasoningProxyRequestId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return `reasoning-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private shouldRetryWithMainProcessProxy(error: unknown): boolean {
    const err = error as Error;
    if (err?.name === "AbortError") return false;

    const message = String(err?.message || "").toLowerCase();
    return (
      message.includes("failed to fetch") ||
      message.includes("networkerror") ||
      message.includes("load failed")
    );
  }

  private async fetchThroughMainProcessProxy(
    endpoint: string,
    options: ReasoningFetchOptions
  ): Promise<Response> {
    const proxy =
      typeof window !== "undefined" ? window.electronAPI?.proxyReasoningRequest : undefined;
    if (typeof proxy !== "function") {
      throw new Error("Reasoning proxy is unavailable");
    }

    const requestId = this.createReasoningProxyRequestId();
    const cancelOnAbort = this.attachProxyCancelOnAbort(requestId, options.signal);

    try {
      const result = await proxy({
        requestId,
        url: endpoint,
        method: "POST",
        headers: options.headers,
        body: options.body,
        stream: false,
      });

      if (!result?.success) {
        throw new Error(result?.error || "Reasoning proxy request failed");
      }

      return this.buildProxyResponse(result);
    } finally {
      cancelOnAbort();
    }
  }

  /**
   * Forwards a renderer-side abort signal to the main process so it can cancel
   * the in-flight upstream fetch instead of waiting for its own 65s timeout.
   * Returns a teardown function that removes the listener.
   */
  private attachProxyCancelOnAbort(requestId: string, signal: AbortSignal | undefined): () => void {
    if (!signal || typeof window === "undefined") return () => {};
    const cancel = window.electronAPI?.cancelReasoningProxyRequest;
    if (typeof cancel !== "function") return () => {};

    if (signal.aborted) {
      cancel({ requestId }).catch(() => {});
      return () => {};
    }
    const onAbort = () => {
      cancel({ requestId }).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }

  private async waitForAbortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    this.throwIfAborted(signal);

    let removeAbortListener: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        try {
          this.throwIfAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });

    try {
      return await Promise.race([operation, aborted]);
    } finally {
      removeAbortListener();
    }
  }

  private async streamThroughMainProcessProxy(
    endpoint: string,
    options: ReasoningFetchOptions,
    chunkHandler: StreamChunkHandler
  ): Promise<Response> {
    const proxy =
      typeof window !== "undefined" ? window.electronAPI?.proxyReasoningRequest : undefined;
    const onProxyChunk =
      typeof window !== "undefined" ? window.electronAPI?.onReasoningProxyChunk : undefined;
    if (typeof proxy !== "function") {
      throw new Error("Reasoning proxy is unavailable");
    }

    const requestId = this.createReasoningProxyRequestId();
    const sseParser = createSsePayloadParser(chunkHandler.onPayload);
    let sawProxyChunk = false;
    const cleanup =
      typeof onProxyChunk === "function"
        ? onProxyChunk((payload) => {
            if (payload?.requestId === requestId && typeof payload.chunk === "string") {
              sawProxyChunk = true;
              sseParser.push(payload.chunk);
            }
          })
        : () => {};
    const cancelOnAbort = this.attachProxyCancelOnAbort(requestId, options.signal);

    try {
      const result = await proxy({
        requestId,
        url: endpoint,
        method: "POST",
        headers: options.headers,
        body: options.body,
        stream: true,
      });

      if (!result?.success) {
        throw new Error(result?.error || "Reasoning proxy stream failed");
      }

      if (!sawProxyChunk && result.body) {
        sseParser.push(result.body);
      }
      sseParser.flush();
      chunkHandler.flush?.();
      return this.buildProxyResponse(result);
    } finally {
      cancelOnAbort();
      cleanup();
    }
  }

  private buildProxyResponse(result: ReasoningProxyResult): Response {
    const headers = new Headers(result.headers || {});
    headers.set("x-chordvox-reasoning-proxy", "1");
    return new Response(result.body || "", {
      status: result.status ?? 502,
      statusText: result.statusText || "",
      headers,
    });
  }

  private async fetchReasoningEndpoint(
    endpoint: string,
    options: ReasoningFetchOptions
  ): Promise<Response> {
    try {
      return await fetch(endpoint, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: options.signal,
      });
    } catch (error) {
      if (!this.shouldRetryWithMainProcessProxy(error)) {
        throw error;
      }

      logger.logReasoning("REASONING_PROXY_FALLBACK", {
        endpoint,
        stream: options.stream === true,
        error: (error as Error).message,
      });

      return this.fetchThroughMainProcessProxy(endpoint, options);
    }
  }

  private async fetchReasoningStream(
    endpoint: string,
    options: ReasoningFetchOptions,
    chunkHandler: StreamChunkHandler
  ): Promise<Response> {
    try {
      return await fetch(endpoint, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: options.signal,
      });
    } catch (error) {
      if (!this.shouldRetryWithMainProcessProxy(error)) {
        throw error;
      }

      logger.logReasoning("REASONING_STREAM_PROXY_FALLBACK", {
        endpoint,
        error: (error as Error).message,
      });

      return this.streamThroughMainProcessProxy(endpoint, options, chunkHandler);
    }
  }

  private isProxyResponse(response: Response): boolean {
    return response.headers.get("x-chordvox-reasoning-proxy") === "1";
  }

  private ensureLowLatencyParamFallbackCacheLoaded(): void {
    if (this.lowLatencyParamFallbackCacheLoaded) {
      return;
    }

    this.lowLatencyParamFallbackCacheLoaded = true;

    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      const raw = window.localStorage.getItem(
        ReasoningService.LOW_LATENCY_PARAM_FALLBACK_STORAGE_KEY
      );
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }

      const now = Date.now();
      for (const [key, expiresAt] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof key === "string" && typeof expiresAt === "number" && expiresAt > now) {
          this.lowLatencyParamFallbackCache.set(key, expiresAt);
        }
      }
    } catch {
      /* ignore corrupt compatibility cache */
    }
  }

  private persistLowLatencyParamFallbackCache(): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      const entries = Array.from(this.lowLatencyParamFallbackCache.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, ReasoningService.LOW_LATENCY_PARAM_FALLBACK_MAX_ENTRIES);
      window.localStorage.setItem(
        ReasoningService.LOW_LATENCY_PARAM_FALLBACK_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(entries))
      );
    } catch {
      /* ignore storage quota errors */
    }
  }

  private pruneLowLatencyParamFallbackCache(now = Date.now()): boolean {
    let changed = false;
    for (const [key, expiresAt] of this.lowLatencyParamFallbackCache.entries()) {
      if (expiresAt <= now) {
        this.lowLatencyParamFallbackCache.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  private getLowLatencyParamFallbackKey(
    provider: string,
    endpoint: string,
    model: string,
    parameter: string
  ): string {
    return [
      provider.trim().toLowerCase(),
      endpoint.trim().toLowerCase(),
      model.trim().toLowerCase(),
      parameter.trim().toLowerCase(),
    ].join("|");
  }

  private isLowLatencyParamFallbackActive(key: string): boolean {
    this.ensureLowLatencyParamFallbackCacheLoaded();

    const now = Date.now();
    if (this.pruneLowLatencyParamFallbackCache(now)) {
      this.persistLowLatencyParamFallbackCache();
    }

    const expiresAt = this.lowLatencyParamFallbackCache.get(key);
    return typeof expiresAt === "number" && expiresAt > now;
  }

  private rememberLowLatencyParamFallback(key: string, meta: Record<string, unknown>): void {
    this.ensureLowLatencyParamFallbackCacheLoaded();
    const expiresAt = Date.now() + ReasoningService.LOW_LATENCY_PARAM_FALLBACK_TTL_MS;
    this.lowLatencyParamFallbackCache.set(key, expiresAt);
    this.pruneLowLatencyParamFallbackCache();
    this.persistLowLatencyParamFallbackCache();

    logger.logReasoning("LOW_LATENCY_PARAM_FALLBACK_REMEMBERED", {
      ...meta,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  private getReasoningCompatibilityKey(
    provider: OpenAiCompatibleProvider,
    endpoint: string,
    model: string,
    type: OpenAiProtocol,
    capability: string
  ): string {
    return this.getLowLatencyParamFallbackKey(
      provider,
      endpoint,
      model,
      `openai-compatible:${type}:${capability}`
    );
  }

  private isBelowMediumEffort(effort: ReasoningEffort | null): boolean {
    return effort === "none" || effort === "minimal" || effort === "low";
  }

  private getOpenAiReasoningRequestCandidates(
    provider: OpenAiCompatibleProvider,
    type: OpenAiProtocol,
    endpoint: string,
    model: string,
    desiredEffort: ReasoningEffort | null
  ): ReasoningRequestCandidate[] {
    if (!desiredEffort) {
      return [{ parameter: null, effort: null }];
    }

    if (
      this.isLowLatencyParamFallbackActive(
        this.getReasoningCompatibilityKey(provider, endpoint, model, type, "omit-effort")
      )
    ) {
      return [{ parameter: null, effort: null }];
    }

    const preferredParameter = this.getOpenAiReasoningParameter(provider, type);
    if (!preferredParameter) {
      return [{ parameter: null, effort: null }];
    }

    const alternateParameter: OpenAiReasoningParameter =
      preferredParameter === "reasoning" ? "reasoning_effort" : "reasoning";
    const minimumMediumRequired = this.isLowLatencyParamFallbackActive(
      this.getReasoningCompatibilityKey(provider, endpoint, model, type, "minimum-medium")
    );
    const effectiveEffort =
      minimumMediumRequired && this.isBelowMediumEffort(desiredEffort) ? "medium" : desiredEffort;

    const candidates: ReasoningRequestCandidate[] = [preferredParameter, alternateParameter]
      .filter(
        (parameter) =>
          !this.isLowLatencyParamFallbackActive(
            this.getReasoningCompatibilityKey(
              provider,
              endpoint,
              model,
              type,
              `unsupported:${parameter}`
            )
          )
      )
      .map((parameter) => ({ parameter, effort: effectiveEffort }));

    candidates.push({ parameter: null, effort: null });
    return candidates;
  }

  private createOpenAiReasoningRequestBody(
    baseRequestBody: Record<string, unknown>,
    candidate: ReasoningRequestCandidate,
    selectedModel: string
  ): Record<string, unknown> {
    const requestBody = this.removeOpenAiReasoningEffort(baseRequestBody);
    if (requestBody.model !== selectedModel) {
      throw new Error("Selected reasoning model changed during compatibility negotiation");
    }
    this.applyOpenAiReasoningEffort(requestBody, candidate.parameter, candidate.effort);
    return requestBody;
  }

  private rememberUnsupportedOpenAiReasoningParameter(
    provider: OpenAiCompatibleProvider,
    type: OpenAiProtocol,
    endpoint: string,
    model: string,
    parameter: OpenAiReasoningParameter,
    status: number
  ): void {
    this.rememberLowLatencyParamFallback(
      this.getReasoningCompatibilityKey(
        provider,
        endpoint,
        model,
        type,
        `unsupported:${parameter}`
      ),
      { provider, type, endpoint, model, parameter, status }
    );
  }

  private rememberOpenAiMinimumMediumEffort(
    provider: OpenAiCompatibleProvider,
    type: OpenAiProtocol,
    endpoint: string,
    model: string,
    status: number
  ): void {
    this.rememberLowLatencyParamFallback(
      this.getReasoningCompatibilityKey(provider, endpoint, model, type, "minimum-medium"),
      { provider, type, endpoint, model, minimumEffort: "medium", status }
    );
  }

  private rememberOpenAiOmitEffort(
    provider: OpenAiCompatibleProvider,
    type: OpenAiProtocol,
    endpoint: string,
    model: string,
    status: number
  ): void {
    this.rememberLowLatencyParamFallback(
      this.getReasoningCompatibilityKey(provider, endpoint, model, type, "omit-effort"),
      { provider, type, endpoint, model, omitEffort: true, status }
    );
  }

  private extractGeminiCandidateText(candidate: any): string {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) {
      return "";
    }

    return parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }

  private isUnsupportedLowLatencyParamError(
    message: string,
    rawText: string,
    parameterTokens: string[]
  ): boolean {
    const haystack = `${message} ${rawText}`.toLowerCase();
    if (!parameterTokens.some((token) => haystack.includes(token))) {
      return false;
    }

    return [
      "unknown parameter",
      "unsupported",
      "not supported",
      "unrecognized",
      "invalid",
      "not permitted",
      "extra_forbidden",
      "extra inputs are not permitted",
      "cannot find field",
      "unknown name",
    ].some((token) => haystack.includes(token));
  }

  private shouldRetryWithoutReasoningParameter(
    provider: OpenAiCompatibleProvider,
    type: OpenAiProtocol,
    status: number,
    payload: unknown,
    rawText: string,
    requestBody: Record<string, unknown>
  ): boolean {
    if (
      (provider !== "openai" &&
        provider !== "openrouter" &&
        provider !== "custom" &&
        provider !== "gemini-compatible") ||
      (type !== "responses" && type !== "chat")
    ) {
      return false;
    }

    if (!("reasoning" in requestBody) && !("reasoning_effort" in requestBody)) {
      return false;
    }

    if (status !== 400 && status !== 422) {
      return false;
    }

    const message = this.extractOpenAiErrorMessage(payload, status, rawText);
    return this.isUnsupportedLowLatencyParamError(message, rawText, [
      "reasoning",
      "reasoning_effort",
      "effort",
    ]);
  }

  private shouldRetryWithMediumReasoningEffort(
    status: number,
    parsedError: ParsedOpenAiError,
    requestBody: Record<string, unknown>
  ): boolean {
    if (status !== 400 && status !== 422) {
      return false;
    }

    const currentEffort = this.getOpenAiReasoningEffortFromBody(requestBody);
    if (!this.isBelowMediumEffort(currentEffort)) {
      return false;
    }

    const haystack = `${parsedError.message} ${parsedError.rawText}`.toLowerCase();
    if (!currentEffort || !haystack.includes(currentEffort) || !haystack.includes("medium")) {
      return false;
    }

    return (
      /(?:supported|allowed|valid|accepted)(?:\s+values?)?[^.\n]{0,120}\bmedium\b/.test(haystack) ||
      /(?:minimum|at least|must be)[^.\n]{0,80}\bmedium\b/.test(haystack)
    );
  }

  private isExplicitUnsupportedReasoningEffortValue(
    status: number,
    parsedError: ParsedOpenAiError,
    requestBody: Record<string, unknown>
  ): boolean {
    if (status !== 400 && status !== 422) {
      return false;
    }

    const currentEffort = this.getOpenAiReasoningEffortFromBody(requestBody);
    if (!currentEffort) {
      return false;
    }

    const haystack = `${parsedError.message} ${parsedError.rawText}`.toLowerCase();
    const mentionsEffortValue = haystack.includes(currentEffort);
    const mentionsEffortConcept = haystack.includes("effort") || haystack.includes("level");
    const rejectsValue = [
      "not supported",
      "unsupported",
      "invalid",
      "not allowed",
      "not accepted",
    ].some((token) => haystack.includes(token));
    return mentionsEffortValue && mentionsEffortConcept && rejectsValue;
  }

  private async performOpenAiCompatibleRequest(
    provider: OpenAiCompatibleProvider,
    type: OpenAiProtocol,
    endpoint: string,
    model: string,
    desiredEffort: ReasoningEffort | null,
    initialRequestBody: Record<string, unknown>,
    performRequest: (body: Record<string, unknown>) => Promise<Response>
  ): Promise<{ response: Response; parsedError: ParsedOpenAiError | null }> {
    let baseRequestBody = this.removeOpenAiReasoningEffort(initialRequestBody);
    const candidates = this.getOpenAiReasoningRequestCandidates(
      provider,
      type,
      endpoint,
      model,
      desiredEffort
    );
    let lastResponse: Response | null = null;
    let lastParsedError: ParsedOpenAiError | null = null;
    let pendingMinimumMediumStatus: number | null = null;

    for (let index = 0; index < candidates.length; index += 1) {
      let candidate = candidates[index];
      let requestBody = this.createOpenAiReasoningRequestBody(baseRequestBody, candidate, model);
      let response = await performRequest(requestBody);
      let parsedError = response.ok ? null : await this.parseOpenAiErrorResponse(response);

      if (
        !response.ok &&
        parsedError &&
        provider === "custom" &&
        this.shouldRetryCustomChatWithoutStream(
          provider,
          type,
          response.status,
          parsedError.payload,
          parsedError.rawText,
          requestBody
        )
      ) {
        baseRequestBody = { ...baseRequestBody };
        delete baseRequestBody.stream;
        requestBody = this.createOpenAiReasoningRequestBody(baseRequestBody, candidate, model);

        logger.logReasoning("OPENAI_CHAT_STREAM_FALLBACK", {
          endpoint,
          provider,
          status: response.status,
          reason: parsedError.message,
        });

        response = await performRequest(requestBody);
        parsedError = response.ok ? null : await this.parseOpenAiErrorResponse(response);
      }

      if (response.ok) {
        if (pendingMinimumMediumStatus !== null && candidate.parameter) {
          this.rememberOpenAiMinimumMediumEffort(
            provider,
            type,
            endpoint,
            model,
            pendingMinimumMediumStatus
          );
        }
        return { response, parsedError: null };
      }

      lastResponse = response;
      lastParsedError = parsedError;
      if (!parsedError || !candidate.parameter) {
        break;
      }
      const attemptedParameter = candidate.parameter;

      if (this.shouldRetryWithMediumReasoningEffort(response.status, parsedError, requestBody)) {
        pendingMinimumMediumStatus = response.status;
        candidate = { parameter: attemptedParameter, effort: "medium" };
        for (let remaining = index + 1; remaining < candidates.length; remaining += 1) {
          if (this.isBelowMediumEffort(candidates[remaining].effort)) {
            candidates[remaining] = { ...candidates[remaining], effort: "medium" };
          }
        }

        requestBody = this.createOpenAiReasoningRequestBody(baseRequestBody, candidate, model);
        response = await performRequest(requestBody);
        parsedError = response.ok ? null : await this.parseOpenAiErrorResponse(response);
        if (response.ok) {
          this.rememberOpenAiMinimumMediumEffort(
            provider,
            type,
            endpoint,
            model,
            pendingMinimumMediumStatus
          );
          return { response, parsedError: null };
        }
        lastResponse = response;
        lastParsedError = parsedError;
        if (!parsedError) {
          break;
        }
      }

      if (
        this.isExplicitUnsupportedReasoningEffortValue(response.status, parsedError, requestBody)
      ) {
        const noEffortBody = this.createOpenAiReasoningRequestBody(
          baseRequestBody,
          { parameter: null, effort: null },
          model
        );
        const noEffortResponse = await performRequest(noEffortBody);
        const noEffortParsedError = noEffortResponse.ok
          ? null
          : await this.parseOpenAiErrorResponse(noEffortResponse);
        if (noEffortResponse.ok) {
          this.rememberOpenAiOmitEffort(provider, type, endpoint, model, response.status);
          return { response: noEffortResponse, parsedError: null };
        }
        lastResponse = noEffortResponse;
        lastParsedError = noEffortParsedError;
        break;
      }

      if (
        this.shouldRetryWithoutReasoningParameter(
          provider,
          type,
          response.status,
          parsedError.payload,
          parsedError.rawText,
          requestBody
        )
      ) {
        this.rememberUnsupportedOpenAiReasoningParameter(
          provider,
          type,
          endpoint,
          model,
          attemptedParameter,
          response.status
        );
        logger.logReasoning("OPENAI_REASONING_PARAM_NEGOTIATION", {
          endpoint,
          provider,
          type,
          model,
          rejectedParameter: attemptedParameter,
          status: response.status,
          nextParameter: candidates[index + 1]?.parameter || null,
        });
        continue;
      }

      break;
    }

    if (!lastResponse) {
      throw new Error("OpenAI-compatible request negotiation produced no request");
    }
    return { response: lastResponse, parsedError: lastParsedError };
  }

  private shouldRetryWithoutGeminiThinkingConfig(
    status: number,
    payload: unknown,
    rawText: string,
    requestBody: { generationConfig?: Record<string, unknown> }
  ): boolean {
    if (status !== 400 && status !== 422) {
      return false;
    }

    if (!requestBody.generationConfig || !("thinkingConfig" in requestBody.generationConfig)) {
      return false;
    }

    const message = this.extractOpenAiErrorMessage(payload, status, rawText);
    return this.isUnsupportedLowLatencyParamError(message, rawText, [
      "thinking",
      "thinkingconfig",
      "thinkingbudget",
      "thinkinglevel",
    ]);
  }

  private getOfficialGoogleGeminiGenerateContentBase(rawBase: string): string {
    const requestBase = getGeminiRequestBaseUrl(rawBase) || rawBase;
    if (getGeminiEndpointFamily(rawBase) === "official-google" && /\/v1$/i.test(requestBase)) {
      return requestBase.replace(/\/v1$/i, "/v1beta");
    }
    return requestBase;
  }

  private shouldRetryOfficialGeminiWithV1Beta(
    status: number,
    payload: unknown,
    rawText: string,
    endpoint: string
  ): boolean {
    if (status !== 400 && status !== 422) {
      return false;
    }

    if (!/generativelanguage\.googleapis\.com\/v1\/models\//i.test(endpoint)) {
      return false;
    }

    const message = this.extractOpenAiErrorMessage(payload, status, rawText);
    return this.isUnsupportedLowLatencyParamError(message, rawText, [
      "systeminstruction",
      "system_instruction",
      "thinking",
      "thinkingconfig",
      "thinkingbudget",
      "thinkinglevel",
    ]);
  }

  private toOfficialGeminiV1BetaEndpoint(endpoint: string): string {
    return endpoint.replace(/\/v1\/models\//i, "/v1beta/models/");
  }

  private getEffectiveCloudPrompt(
    agentName: string | null,
    transcript: string,
    config: ReasoningConfig = {}
  ): string {
    return this.getCustomPrompt() || this.getResolvedSystemPrompt(agentName, transcript, config);
  }

  private async getProAccessState(
    forceRefresh = false
  ): Promise<{ allowed: boolean; status: LicenseStatusResult | null }> {
    const now = Date.now();
    if (!forceRefresh && now < this.proAccessCache.expiresAt) {
      return {
        allowed: this.proAccessCache.value,
        status: this.proAccessCache.status,
      };
    }

    if (typeof window === "undefined") {
      const status = {
        success: false,
        configured: false,
        status: "invalid" as const,
        isActive: false,
        keyPresent: false,
        error: "LICENSE_RUNTIME_UNAVAILABLE",
        message: "Pro access is unavailable because the desktop runtime bridge is missing.",
      };
      this.proAccessCache = {
        value: false,
        expiresAt: now + ReasoningService.PRO_ACCESS_CACHE_TTL_MS,
        status,
      };
      return { allowed: false, status };
    }

    if (!window.electronAPI?.licenseEnsureProAccess && !window.electronAPI?.licenseGetStatus) {
      const status = {
        success: false,
        configured: false,
        status: "invalid" as const,
        isActive: false,
        keyPresent: false,
        error: "LICENSE_RUNTIME_UNAVAILABLE",
        message: "Pro access is unavailable because the desktop runtime bridge is missing.",
      };
      this.proAccessCache = {
        value: false,
        expiresAt: now + ReasoningService.PRO_ACCESS_CACHE_TTL_MS,
        status,
      };
      return { allowed: false, status };
    }

    try {
      const status: LicenseStatusResult = window.electronAPI?.licenseEnsureProAccess
        ? await window.electronAPI.licenseEnsureProAccess()
        : window.electronAPI?.licenseGetStatus
          ? await window.electronAPI.licenseGetStatus()
          : {
              success: true,
              configured: false,
              status: "active",
              isActive: true,
              keyPresent: false,
              plan: null,
            };
      const allowed = Boolean(status?.isActive);
      this.proAccessCache = {
        value: allowed,
        expiresAt: now + ReasoningService.PRO_ACCESS_CACHE_TTL_MS,
        status: status || null,
      };
      return { allowed, status: status || null };
    } catch {
      const status = {
        success: false,
        configured: false,
        status: "invalid" as const,
        isActive: false,
        keyPresent: false,
        error: "LICENSE_CHECK_FAILED",
        message: "Failed to verify Pro access. Please open Settings > Account and retry.",
      };
      this.proAccessCache = {
        value: false,
        expiresAt: now + ReasoningService.PRO_ACCESS_CACHE_TTL_MS,
        status,
      };
      return { allowed: false, status };
    }
  }

  private createProRequiredError(status: LicenseStatusResult | null): Error {
    const message =
      (typeof status?.message === "string" ? status.message : null) ||
      "This feature requires Pro. Open Settings > Account to upgrade.";
    const error = new Error(message) as Error & {
      code?: string;
      title?: string;
      licenseStatus?: LicenseStatusResult | null;
    };
    error.code = "LICENSE_REQUIRED";
    error.title = "LICENSE_REQUIRED";
    error.licenseStatus = status;
    return error;
  }

  private extractOpenAiErrorMessage(payload: unknown, status: number, fallback: string): string {
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const directMessage = record.message;
      if (typeof directMessage === "string" && directMessage.trim()) {
        return directMessage;
      }

      const directError = record.error;
      if (typeof directError === "string" && directError.trim()) {
        return directError;
      }

      if (directError && typeof directError === "object") {
        const nestedError = directError as Record<string, unknown>;
        const nestedMessage = nestedError.message;
        if (typeof nestedMessage === "string" && nestedMessage.trim()) {
          return nestedMessage;
        }
        if (nestedMessage && typeof nestedMessage === "object") {
          const nestedMessageRecord = nestedMessage as Record<string, unknown>;
          const detail = nestedMessageRecord.detail;
          if (typeof detail === "string" && detail.trim()) {
            return detail;
          }
        }

        const nestedDetail = nestedError.detail;
        if (typeof nestedDetail === "string" && nestedDetail.trim()) {
          return nestedDetail;
        }
      }

      const detail = record.detail;
      if (typeof detail === "string" && detail.trim()) {
        return detail;
      }

      const reason = record.reason;
      if (typeof reason === "string" && reason.trim()) {
        return reason;
      }
    }

    return fallback || `OpenAI API error: ${status}`;
  }

  private async parseOpenAiErrorResponse(response: Response): Promise<ParsedOpenAiError> {
    const fallback = response.statusText || "";
    const rawText = await response.text().catch(() => "");

    if (!rawText) {
      return {
        payload: { error: fallback || `OpenAI API error: ${response.status}` },
        message: this.extractOpenAiErrorMessage(undefined, response.status, fallback),
        rawText: "",
      };
    }

    try {
      const payload = JSON.parse(rawText) as unknown;
      return {
        payload,
        message: this.extractOpenAiErrorMessage(payload, response.status, fallback),
        rawText,
      };
    } catch {
      return {
        payload: { error: rawText },
        message: this.extractOpenAiErrorMessage({ error: rawText }, response.status, fallback),
        rawText,
      };
    }
  }

  private shouldRetryCustomChatWithoutStream(
    provider: "openai" | "openrouter" | "custom",
    type: "responses" | "chat",
    status: number,
    payload: unknown,
    rawText: string,
    requestBody: Record<string, unknown>
  ): boolean {
    if (provider !== "custom" || type !== "chat" || requestBody.stream !== false) {
      return false;
    }

    if (status !== 400 && status !== 422) {
      return false;
    }

    const message = this.extractOpenAiErrorMessage(payload, status, rawText);
    const haystack = `${message} ${rawText}`.toLowerCase();

    if (!haystack.includes("stream")) {
      return false;
    }

    return [
      "unknown parameter",
      "unsupported",
      "not supported",
      "unrecognized",
      "invalid",
      "not permitted",
      "extra_forbidden",
      "extra inputs are not permitted",
    ].some((token) => haystack.includes(token));
  }

  private getProviderEndpointOverride(providerId: string): string | null {
    if (typeof window === "undefined" || !window.localStorage) return null;
    try {
      const raw = window.localStorage.getItem("providerEndpoints");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const value = parsed?.[providerId];
      if (typeof value === "string" && value.trim()) {
        const normalized = normalizeBaseUrl(value.trim());
        if (!normalized) return null;
        if (isSecureEndpoint(normalized)) return normalized;
        void logger.warn("Ignoring insecure provider endpoint override", {
          providerId,
          endpoint: normalized,
        });
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private normalizeProviderOverride(providerOverride?: string | null): string {
    const normalized = normalizeAvailableCloudProvider(providerOverride, "");
    return isLocalReasoningProviderId(normalized) ? "local" : normalized;
  }

  private getConfiguredOpenAIBase(providerOverride?: "openai" | "openrouter" | "custom"): string {
    if (typeof window === "undefined" || !window.localStorage) {
      return providerOverride === "openrouter"
        ? ReasoningService.OPENROUTER_BASE
        : API_ENDPOINTS.OPENAI_BASE;
    }

    try {
      const provider = providerOverride || window.localStorage.getItem("reasoningProvider") || "";
      const isCustomProvider = provider === "custom";
      const defaultEndpoint =
        provider === "openrouter" ? ReasoningService.OPENROUTER_BASE : API_ENDPOINTS.OPENAI_BASE;

      // Check per-provider endpoint override (from UI endpoint editor)
      if (!isCustomProvider) {
        const override = this.getProviderEndpointOverride(provider || "openai");
        if (override && override !== defaultEndpoint) {
          logger.logReasoning("CUSTOM_REASONING_ENDPOINT_CHECK", {
            hasCustomUrl: true,
            provider,
            reason: "Using per-provider endpoint override",
            overrideEndpoint: override,
          });
          return override;
        }
        logger.logReasoning("CUSTOM_REASONING_ENDPOINT_CHECK", {
          hasCustomUrl: false,
          provider,
          reason: "Provider is not 'custom', using default provider endpoint",
          defaultEndpoint,
        });
        return defaultEndpoint;
      }

      const stored = window.localStorage.getItem("cloudReasoningBaseUrl") || "";
      const trimmed = stored.trim();

      if (!trimmed) {
        logger.logReasoning("CUSTOM_REASONING_ENDPOINT_CHECK", {
          hasCustomUrl: false,
          provider,
          usingDefault: true,
          defaultEndpoint,
        });
        return defaultEndpoint;
      }

      const normalized = normalizeEndpointUrl(trimmed) || defaultEndpoint;

      logger.logReasoning("CUSTOM_REASONING_ENDPOINT_CHECK", {
        hasCustomUrl: true,
        provider,
        rawUrl: trimmed,
        normalizedUrl: normalized,
        defaultEndpoint,
      });

      const knownNonOpenAIUrls = [
        "api.groq.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "openrouter.ai",
      ];

      const isKnownNonOpenAI = knownNonOpenAIUrls.some((url) => normalized.includes(url));
      if (isKnownNonOpenAI) {
        logger.logReasoning("OPENAI_BASE_REJECTED", {
          reason: "Custom URL is a known non-OpenAI provider, using default OpenAI endpoint",
          attempted: normalized,
        });
        return defaultEndpoint;
      }

      if (!isSecureEndpoint(normalized)) {
        logger.logReasoning("OPENAI_BASE_REJECTED", {
          reason: "HTTPS required (HTTP allowed for local network only)",
          attempted: normalized,
        });
        return defaultEndpoint;
      }

      logger.logReasoning("CUSTOM_REASONING_ENDPOINT_RESOLVED", {
        customEndpoint: normalized,
        isCustom: true,
        provider,
      });

      return normalized;
    } catch (error) {
      logger.logReasoning("CUSTOM_REASONING_ENDPOINT_ERROR", {
        error: (error as Error).message,
        fallbackTo:
          providerOverride === "openrouter"
            ? ReasoningService.OPENROUTER_BASE
            : API_ENDPOINTS.OPENAI_BASE,
      });
      return providerOverride === "openrouter"
        ? ReasoningService.OPENROUTER_BASE
        : API_ENDPOINTS.OPENAI_BASE;
    }
  }

  private getConfiguredCustomReasoningEndpoint(): string {
    if (typeof window === "undefined" || !window.localStorage) {
      throw new Error("Custom endpoint is not available outside the renderer");
    }

    const raw = window.localStorage.getItem("cloudReasoningBaseUrl") || "";
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Custom endpoint URL is required");
    }

    const normalized = normalizeEndpointUrl(trimmed);
    if (!normalized || !normalized.includes("://")) {
      throw new Error("Custom endpoint URL must include http:// or https://");
    }

    if (!isSecureEndpoint(normalized)) {
      throw new Error("HTTPS required (HTTP allowed for local network only)");
    }

    return normalized;
  }

  private getOpenAIEndpointCandidates(
    base: string,
    protocolMode: "auto" | "chat" | "responses" = "auto",
    options: { preferChatInAuto?: boolean } = {}
  ): Array<{ url: string; type: "responses" | "chat" }> {
    const lower = base.toLowerCase();

    if (lower.endsWith("/responses") || lower.endsWith("/chat/completions")) {
      const type = lower.endsWith("/responses") ? "responses" : "chat";
      return [{ url: base, type }];
    }

    if (protocolMode === "chat") {
      return [{ url: buildApiUrl(base, "/chat/completions"), type: "chat" }];
    }

    if (protocolMode === "responses") {
      return [{ url: buildApiUrl(base, "/responses"), type: "responses" }];
    }

    const preference = this.getStoredOpenAiPreference(base);
    if (preference === "chat") {
      return [{ url: buildApiUrl(base, "/chat/completions"), type: "chat" }];
    }

    if (preference === "responses") {
      return [{ url: buildApiUrl(base, "/responses"), type: "responses" }];
    }

    const candidates: Array<{ url: string; type: "responses" | "chat" }> = options.preferChatInAuto
      ? [
          { url: buildApiUrl(base, "/chat/completions"), type: "chat" },
          { url: buildApiUrl(base, "/responses"), type: "responses" },
        ]
      : [
          { url: buildApiUrl(base, "/responses"), type: "responses" },
          { url: buildApiUrl(base, "/chat/completions"), type: "chat" },
        ];

    return candidates;
  }

  private getStoredOpenAiPreference(base: string): "responses" | "chat" | undefined {
    if (this.openAiEndpointPreference.has(base)) {
      return this.openAiEndpointPreference.get(base);
    }

    if (typeof window === "undefined" || !window.localStorage) {
      return undefined;
    }

    try {
      const raw = window.localStorage.getItem(ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY);
      if (!raw) {
        return undefined;
      }
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return undefined;
      }
      const value = parsed[base];
      if (value === "responses" || value === "chat") {
        this.openAiEndpointPreference.set(base, value);
        return value;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private rememberOpenAiPreference(base: string, preference: "responses" | "chat"): void {
    this.openAiEndpointPreference.set(base, preference);

    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      const raw = window.localStorage.getItem(ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const data = typeof parsed === "object" && parsed !== null ? parsed : {};
      data[base] = preference;
      window.localStorage.setItem(
        ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY,
        JSON.stringify(data)
      );
      this.emitOpenAiPreferenceChanged();
    } catch {}
  }

  getDetectedOpenAiPreference(base: string): "responses" | "chat" | undefined {
    return this.getStoredOpenAiPreference(normalizeBaseUrl(base));
  }

  clearDetectedOpenAiPreference(base?: string): void {
    const normalizedBase = base ? normalizeBaseUrl(base) : "";

    if (normalizedBase) {
      this.openAiEndpointPreference.delete(normalizedBase);
    } else {
      this.openAiEndpointPreference.clear();
    }

    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      if (!normalizedBase) {
        window.localStorage.removeItem(ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY);
        this.emitOpenAiPreferenceChanged();
        return;
      }

      const raw = window.localStorage.getItem(ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const data = typeof parsed === "object" && parsed !== null ? parsed : {};
      delete data[normalizedBase];
      if (Object.keys(data).length === 0) {
        window.localStorage.removeItem(ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY,
          JSON.stringify(data)
        );
      }
      this.emitOpenAiPreferenceChanged();
    } catch {}
  }

  private async getApiKey(provider: ApiKeyProvider): Promise<string> {
    // Bedrock and custom both bypass the SecureCache because they read multiple
    // values (access+secret) or hit a per-call IPC, so dedup them separately.
    if (provider !== "bedrock" && provider !== "custom") {
      const cached = this.apiKeyCache.get(provider);
      if (cached) {
        return cached;
      }
      const inflight = this.pendingApiKeyFetches.get(provider);
      if (inflight) {
        return inflight;
      }
      const fetchPromise = this.fetchApiKey(provider).finally(() => {
        this.pendingApiKeyFetches.delete(provider);
      });
      this.pendingApiKeyFetches.set(provider, fetchPromise);
      return fetchPromise;
    }
    return this.fetchApiKey(provider);
  }

  private async fetchApiKey(provider: ApiKeyProvider): Promise<string> {
    if (provider === "custom") {
      let customKey = "";
      try {
        customKey =
          (await window.electronAPI?.getCustomReasoningKey?.({ allowKeychain: true })) || "";
      } catch (err) {
        logger.logReasoning("CUSTOM_KEY_IPC_FALLBACK", { error: (err as Error)?.message });
      }
      if (!customKey || !customKey.trim()) {
        customKey = window.localStorage?.getItem("customReasoningApiKey") || "";
      }
      const trimmedKey = customKey.trim();

      logger.logReasoning("CUSTOM_KEY_RETRIEVAL", {
        provider,
        hasKey: !!trimmedKey,
      });

      return trimmedKey;
    }

    // Bedrock uses access key + secret key, not a single API key
    if (provider === "bedrock") {
      const accessKey = window.localStorage?.getItem("bedrockAccessKeyId") || "";
      const secretKey = window.localStorage?.getItem("bedrockSecretAccessKey") || "";
      if (!accessKey.trim() || !secretKey.trim()) {
        throw new Error("AWS Bedrock credentials not configured");
      }
      // Return access key as the "api key" – processWithBedrock reads both separately
      return accessKey.trim();
    }

    let apiKey: string | undefined;

    logger.logReasoning(`${provider.toUpperCase()}_KEY_RETRIEVAL`, {
      provider,
      fromCache: false,
      cacheSize: this.apiKeyCache.size || 0,
    });

    {
      try {
        const keyGetters = {
          openai: () => window.electronAPI.getOpenAIKey({ allowKeychain: true }),
          openrouter: () => window.electronAPI.getOpenRouterKey({ allowKeychain: true }),
          anthropic: () => window.electronAPI.getAnthropicKey({ allowKeychain: true }),
          gemini: () => window.electronAPI.getGeminiKey({ allowKeychain: true }),
          groq: () => window.electronAPI.getGroqKey({ allowKeychain: true }),
          cerebras: () => window.electronAPI.getCerebrasKey({ allowKeychain: true }),
        };
        apiKey = (await keyGetters[provider]()) ?? undefined;

        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCHED`, {
          provider,
          hasKey: !!apiKey,
        });

        if (apiKey) {
          this.apiKeyCache.set(provider, apiKey);
        }
      } catch (error) {
        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCH_ERROR`, {
          provider,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
      }
    }

    // Fallback to localStorage if IPC returned empty
    if (!apiKey && typeof window !== "undefined" && window.localStorage) {
      const localStorageKeys: Record<string, string> = {
        openai: "openaiApiKey",
        openrouter: "openrouterApiKey",
        anthropic: "anthropicApiKey",
        gemini: "geminiApiKey",
        groq: "groqApiKey",
        cerebras: "cerebrasApiKey",
      };
      const lsKey = localStorageKeys[provider];
      if (lsKey) {
        const lsValue = (window.localStorage.getItem(lsKey) || "").trim();
        if (lsValue) {
          logger.logReasoning(`${provider.toUpperCase()}_KEY_LOCALSTORAGE_FALLBACK`, {
            provider,
            hasKey: true,
          });
          apiKey = lsValue;
          this.apiKeyCache.set(provider, apiKey);
        }
      }
    }

    if (!apiKey) {
      const errorMsg = `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key not configured`;
      logger.logReasoning(`${provider.toUpperCase()}_KEY_MISSING`, {
        provider,
        error: errorMsg,
      });
      throw new Error(errorMsg);
    }

    return apiKey;
  }

  private async callChatCompletionsApi(
    endpoint: string,
    apiKey: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig,
    providerName: string
  ): Promise<string> {
    const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
    const userPrompt = text;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const requestBody: any = {
      model,
      messages,
      temperature: config.temperature ?? 0.3,
      max_tokens:
        config.maxTokens ||
        Math.max(
          4096,
          this.calculateMaxTokens(
            text.length,
            TOKEN_LIMITS.MIN_TOKENS,
            TOKEN_LIMITS.MAX_TOKENS,
            TOKEN_LIMITS.TOKEN_MULTIPLIER
          )
        ),
    };

    if (providerName.toLowerCase() === "groq") {
      const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, config);
      const reasoningEffort = getGroqReasoningEffort(model, reasoningPolicy);
      if (reasoningEffort) {
        requestBody.reasoning_effort = reasoningEffort;
      }
    }

    if (providerName.toLowerCase() === "cerebras") {
      const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, config);
      const reasoningEffort = getCerebrasReasoningEffort(model, reasoningPolicy);
      if (reasoningEffort) {
        requestBody.reasoning_effort = reasoningEffort;
      }
    }

    logger.logReasoning(`${providerName.toUpperCase()}_REQUEST`, {
      endpoint,
      model,
      hasApiKey: !!apiKey,
      requestBody: JSON.stringify(requestBody).substring(0, 200),
    });

    // Streaming fast-path for chat-completions providers (Groq and Cerebras). Adds
    // `stream: true`, parses SSE delta chunks, emits via onProgress. Falls
    // through to the non-stream withRetry path on any failure.
    if (typeof config.onProgress === "function") {
      try {
        const streamed = await this.streamChatCompletions(
          endpoint,
          { ...requestBody, stream: true },
          apiKey,
          config.onProgress,
          config.signal
        );
        if (streamed && streamed.trim()) {
          logger.logReasoning(`${providerName.toUpperCase()}_STREAM_SUCCESS`, {
            model,
            responseLength: streamed.length,
          });
          return streamed.trim();
        }
        logger.logReasoning(`${providerName.toUpperCase()}_STREAM_EMPTY_FALLBACK`, { model });
      } catch (streamError) {
        this.throwIfAborted(config.signal);
        logger.logReasoning(`${providerName.toUpperCase()}_STREAM_FALLBACK`, {
          model,
          error: (streamError as Error).message,
        });
      }
    }

    const response = await withRetry(async () => {
      const request = this.createLinkedRequestController(30000, config.signal);
      try {
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        };
        const res = await this.fetchReasoningEndpoint(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: request.controller.signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          let errorData: any = { error: res.statusText };

          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { error: errorText || res.statusText };
          }

          logger.logReasoning(`${providerName.toUpperCase()}_API_ERROR_DETAIL`, {
            status: res.status,
            statusText: res.statusText,
            error: errorData,
            errorMessage: errorData.error?.message || errorData.message || errorData.error,
            fullResponse: errorText.substring(0, 500),
          });

          const errorMessage =
            errorData.error?.message ||
            errorData.message ||
            errorData.error ||
            `${providerName} API error: ${res.status}`;
          throw this.createHttpError(errorMessage, res.status, res.statusText);
        }

        const jsonResponse = await res.json();

        logger.logReasoning(`${providerName.toUpperCase()}_RAW_RESPONSE`, {
          hasResponse: !!jsonResponse,
          responseKeys: jsonResponse ? Object.keys(jsonResponse) : [],
          hasChoices: !!jsonResponse?.choices,
          choicesLength: jsonResponse?.choices?.length || 0,
          fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
        });

        return jsonResponse;
      } catch (error) {
        this.throwIfAborted(config.signal);
        if ((error as Error).name === "AbortError") {
          throw new Error("Request timed out after 30s");
        }
        throw error;
      } finally {
        request.cleanup();
      }
    }, createApiRetryStrategy());

    if (!response.choices || !response.choices[0]) {
      logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE_ERROR`, {
        model,
        response: JSON.stringify(response).substring(0, 500),
        hasChoices: !!response.choices,
        choicesCount: response.choices?.length || 0,
      });
      throw new Error(`Invalid response structure from ${providerName} API`);
    }

    const choice = response.choices[0];
    const responseText = choice.message?.content?.trim() || "";

    if (!responseText) {
      logger.logReasoning(`${providerName.toUpperCase()}_EMPTY_RESPONSE`, {
        model,
        finishReason: choice.finish_reason,
        hasMessage: !!choice.message,
        response: JSON.stringify(choice).substring(0, 500),
      });
      throw new Error(`${providerName} returned empty response`);
    }

    logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE`, {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
    });

    return responseText;
  }

  /**
   * Streams an OpenAI-compatible chat-completions endpoint (used by Groq
   * today). Accumulates `choices[0].delta.content` and emits the running
   * total via onProgress.
   */
  private async streamChatCompletions(
    endpoint: string,
    body: Record<string, unknown>,
    apiKey: string,
    onProgress: (partial: string) => void,
    parentSignal?: AbortSignal
  ): Promise<string> {
    const request = this.createLinkedRequestController(60000, parentSignal);

    // Single shared state across direct-fetch and main-process-proxy paths;
    // removes the duplicate throttle/accumulator we previously declared inside
    // and outside the try block.
    const throttle = createProgressThrottle(onProgress, 33);
    const state = { accumulated: "", streamError: null as Error | null };
    const consumePayload = (payload: string) => {
      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      const delta = event?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        state.accumulated += delta;
        throttle.emit(state.accumulated);
      }
      const errorMessage =
        typeof event?.error?.message === "string" ? event.error.message : undefined;
      if (errorMessage) {
        state.streamError = new Error(errorMessage);
      }
    };

    let response: Response;
    try {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      };

      response = await this.fetchReasoningStream(
        endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.controller.signal,
          stream: true,
        },
        {
          onPayload: consumePayload,
          flush: () => {
            if (state.accumulated) throttle.flush(state.accumulated);
          },
        }
      );

      if (this.isProxyResponse(response) && response.ok) {
        request.cleanup();
        if (state.streamError) throw state.streamError;
        return state.accumulated;
      }
    } catch (error) {
      request.cleanup();
      this.throwIfAborted(parentSignal);
      if ((error as Error).name === "AbortError") {
        throw new Error("Chat-completions stream timed out after 60s");
      }
      throw error;
    }

    if (!response.ok) {
      request.cleanup();
      const errorText = await response.text();
      let errorMessage = response.statusText;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage =
          errorData?.error?.message || errorData?.message || errorText || response.statusText;
      } catch {
        errorMessage = errorText || response.statusText;
      }
      throw new Error(errorMessage);
    }

    try {
      for await (const payload of parseSseStream(response)) {
        consumePayload(payload);
        if (state.streamError) throw state.streamError;
      }
    } finally {
      request.cleanup();
    }

    if (state.accumulated) throttle.flush(state.accumulated);
    return state.accumulated;
  }

  async processText(
    text: string,
    model: string = "",
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    this.throwIfAborted(config.signal);
    const trimmedModel = model?.trim?.() || "";
    if (!trimmedModel) {
      throw new Error("No reasoning model selected");
    }
    const providerOverride = this.normalizeProviderOverride(config.providerOverride);
    const provider =
      providerOverride && providerOverride !== "auto"
        ? providerOverride
        : getModelProvider(trimmedModel);
    const effectiveConfig = this.getEffectiveConfig(text, trimmedModel, provider, {
      ...config,
      onProgress: this.getCancellableProgress(config.onProgress, config.signal),
    });
    const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, effectiveConfig);
    const proAccess = await this.getProAccessState();

    if (!proAccess.allowed && config.allowProPreview !== true) {
      throw this.createProRequiredError(proAccess.status);
    }

    logger.logReasoning("PROVIDER_SELECTION", {
      model: trimmedModel,
      provider,
      providerOverride: providerOverride || null,
      promptMode: effectiveConfig.promptMode || "default",
      disableThinking: effectiveConfig.disableThinking ?? false,
      reasoningProfile: reasoningPolicy.profile,
      reasoningComplexity: reasoningPolicy.complexity,
      agentName,
      hasConfig: Object.keys(config).length > 0,
      textLength: text.length,
      contextUsed: effectiveConfig.contextUsed || false,
      hasContextText: !!effectiveConfig.contextText,
      hasContextSummary: !!effectiveConfig.contextSummary,
      timestamp: new Date().toISOString(),
    });

    this.activeProcessingCount += 1;
    this.isProcessing = true;
    try {
      let result: string;
      const startTime = Date.now();

      logger.logReasoning("ROUTING_TO_PROVIDER", {
        provider,
        model,
      });

      switch (provider) {
        case "openai":
        case "openrouter":
        case "custom":
          result = await this.processWithOpenAI(text, trimmedModel, agentName, effectiveConfig);
          break;
        case "anthropic":
          result = await this.processWithAnthropic(text, trimmedModel, agentName, effectiveConfig);
          break;
        case "local":
          result = await this.processWithLocal(text, trimmedModel, agentName, effectiveConfig);
          break;
        case "gemini":
          result = await this.processWithGemini(text, trimmedModel, agentName, effectiveConfig);
          break;
        case "groq":
          result = await this.processWithGroq(text, model, agentName, effectiveConfig);
          break;
        case "cerebras":
          result = await this.processWithCerebras(text, trimmedModel, agentName, effectiveConfig);
          break;
        case CHORDVOX_CLOUD_PROVIDER:
          result = await this.processWithChordVoxCloud(text, model, agentName, effectiveConfig);
          break;
        case "bedrock":
          result = await this.processWithBedrock(text, trimmedModel, agentName, effectiveConfig);
          break;
        default:
          throw new Error(`Unsupported reasoning provider: ${provider}`);
      }

      const processingTime = Date.now() - startTime;
      this.throwIfAborted(effectiveConfig.signal);

      logger.logReasoning("PROVIDER_SUCCESS", {
        provider,
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
      });

      return result;
    } catch (error) {
      logger.logReasoning("PROVIDER_ERROR", {
        provider,
        model,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      throw error;
    } finally {
      this.activeProcessingCount = Math.max(0, this.activeProcessingCount - 1);
      this.isProcessing = this.activeProcessingCount > 0;
    }
  }

  private async processWithCustomGeminiGenerateContent(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    const endpointSource = this.getConfiguredCustomReasoningEndpoint();
    const endpoint = buildGeminiGenerateContentUrl(endpointSource, model);
    if (!endpoint) {
      throw new Error("Custom Gemini generateContent endpoint could not be resolved");
    }

    logger.logReasoning("CUSTOM_GEMINI_START", {
      model,
      agentName,
      endpoint,
      hasApiKey: false,
    });

    const apiKey = await this.getApiKey("custom");

    logger.logReasoning("CUSTOM_GEMINI_API_KEY", {
      hasApiKey: !!apiKey,
    });

    try {
      const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
      const userPrompt = text;
      const thinkingFallbackKey = this.getLowLatencyParamFallbackKey(
        "custom-gemini",
        endpoint,
        model,
        "thinkingConfig"
      );
      const skipThinkingConfig = this.isLowLatencyParamFallbackActive(thinkingFallbackKey);

      const generationConfig: Record<string, unknown> = {
        temperature: config.temperature ?? 0.3,
        maxOutputTokens:
          config.maxTokens ||
          Math.max(
            2000,
            this.calculateMaxTokens(
              text.length,
              TOKEN_LIMITS.MIN_TOKENS_GEMINI,
              TOKEN_LIMITS.MAX_TOKENS_GEMINI,
              TOKEN_LIMITS.TOKEN_MULTIPLIER
            )
          ),
      };

      const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, config);
      const thinkingConfig = getGeminiThinkingConfig(model, reasoningPolicy);
      if (thinkingConfig && !skipThinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
      }

      const requestBody: GeminiGenerateContentRequestBody = {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig,
      };

      const response = await withRetry(async () => {
        logger.logReasoning("CUSTOM_GEMINI_REQUEST", {
          endpoint,
          model,
          hasApiKey: !!apiKey,
          systemPromptLength: systemPrompt.length,
          userPromptLength: userPrompt.length,
          requestBody: JSON.stringify(requestBody).substring(0, 200),
        });

        const request = this.createLinkedRequestController(30000, config.signal);

        try {
          const performRequest = (body: GeminiGenerateContentRequestBody) => {
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (apiKey) {
              headers["x-goog-api-key"] = apiKey;
            }

            return this.fetchReasoningEndpoint(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: request.controller.signal,
            });
          };

          let res = await performRequest(requestBody);

          if (!res.ok) {
            let parsedError = await this.parseOpenAiErrorResponse(res);

            if (
              this.shouldRetryWithoutGeminiThinkingConfig(
                res.status,
                parsedError.payload,
                parsedError.rawText,
                requestBody
              )
            ) {
              const retryBody: GeminiGenerateContentRequestBody = {
                ...requestBody,
                generationConfig: { ...requestBody.generationConfig },
              };
              delete retryBody.generationConfig.thinkingConfig;
              this.rememberLowLatencyParamFallback(thinkingFallbackKey, {
                provider: "custom-gemini",
                endpoint,
                model,
                parameter: "thinkingConfig",
                status: res.status,
              });

              logger.logReasoning("CUSTOM_GEMINI_THINKING_CONFIG_FALLBACK", {
                endpoint,
                model,
                status: res.status,
                reason: parsedError.message,
              });

              res = await performRequest(retryBody);
              if (res.ok) {
                return (await res.json()) as Record<string, unknown>;
              }
              parsedError = await this.parseOpenAiErrorResponse(res);
            }

            logger.logReasoning("CUSTOM_GEMINI_API_ERROR_DETAIL", {
              status: res.status,
              statusText: res.statusText,
              error: parsedError.payload,
              errorMessage: parsedError.message,
              fullResponse: parsedError.rawText.substring(0, 500),
            });

            throw this.createHttpError(
              parsedError.message || `Gemini API error: ${res.status}`,
              res.status,
              res.statusText
            );
          }

          const jsonResponse = (await res.json()) as Record<string, unknown>;
          logger.logReasoning("CUSTOM_GEMINI_RAW_RESPONSE", {
            hasResponse: !!jsonResponse,
            responseKeys: Object.keys(jsonResponse),
            hasCandidates: Array.isArray(jsonResponse.candidates),
            candidatesLength: Array.isArray(jsonResponse.candidates)
              ? jsonResponse.candidates.length
              : 0,
            fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
          });

          return jsonResponse;
        } catch (error) {
          this.throwIfAborted(config.signal);
          if ((error as Error).name === "AbortError") {
            throw new Error("Request timed out after 30s");
          }
          throw error;
        } finally {
          request.cleanup();
        }
      }, createApiRetryStrategy());

      const candidates = Array.isArray(response.candidates) ? response.candidates : [];
      const candidate = candidates[0] as Record<string, unknown> | undefined;
      if (!candidate) {
        logger.logReasoning("CUSTOM_GEMINI_RESPONSE_ERROR", {
          model,
          response: JSON.stringify(response).substring(0, 500),
          candidateCount: candidates.length,
        });
        throw new Error("Invalid response structure from Gemini-compatible endpoint");
      }

      const content = candidate.content as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const textPart = parts.find(
        (part): part is { text: string } =>
          typeof part === "object" &&
          part !== null &&
          typeof (part as { text?: unknown }).text === "string" &&
          Boolean((part as { text: string }).text.trim())
      );

      if (!textPart) {
        const finishReason =
          typeof candidate.finishReason === "string" ? candidate.finishReason : undefined;
        logger.logReasoning("CUSTOM_GEMINI_EMPTY_RESPONSE", {
          model,
          finishReason,
          hasContent: !!content,
          hasParts: parts.length > 0,
          response: JSON.stringify(candidate).substring(0, 500),
        });

        if (finishReason === "MAX_TOKENS") {
          throw new Error(
            "Gemini reached token limit before generating response. Try a shorter input or increase max tokens."
          );
        }
        throw new Error("Gemini-compatible endpoint returned empty response");
      }

      const rawResponseText = textPart.text.trim();
      const fallbackToOriginal = this.shouldFallbackGeminiFastCleanup(
        text,
        rawResponseText,
        config
      );
      const responseText = fallbackToOriginal ? text.trim() : rawResponseText;
      const usageMetadata = response.usageMetadata as Record<string, unknown> | undefined;

      logger.logReasoning("CUSTOM_GEMINI_RESPONSE", {
        model,
        responseLength: responseText.length,
        rawResponseLength: rawResponseText.length,
        tokensUsed:
          typeof usageMetadata?.totalTokenCount === "number" ? usageMetadata.totalTokenCount : 0,
        success: true,
        fallbackToOriginal,
      });

      return responseText;
    } catch (error) {
      logger.logReasoning("CUSTOM_GEMINI_ERROR", {
        model,
        endpoint,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  }

  private async processWithOpenAI(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    const providerOverride = this.normalizeProviderOverride(config.providerOverride);
    const storedProvider = this.normalizeProviderOverride(
      window.localStorage?.getItem("reasoningProvider")
    );
    const effectiveProvider =
      providerOverride === "custom" ||
      providerOverride === "openrouter" ||
      providerOverride === "openai"
        ? providerOverride
        : storedProvider === "custom"
          ? "custom"
          : storedProvider === "openrouter"
            ? "openrouter"
            : "openai";
    const isCustomProvider = effectiveProvider === "custom";
    const customProtocol = isCustomProvider ? this.getCustomReasoningProtocol() : "auto";

    if (isCustomProvider && customProtocol === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL) {
      return this.processWithCustomGeminiGenerateContent(text, model, agentName, config);
    }

    logger.logReasoning("OPENAI_START", {
      model,
      agentName,
      provider: effectiveProvider,
      providerOverride: providerOverride || null,
      isCustomProvider,
      customProtocol,
      hasApiKey: false, // Will update after fetching
    });

    const apiKey = await this.getApiKey(effectiveProvider);

    logger.logReasoning("OPENAI_API_KEY", {
      hasApiKey: !!apiKey,
    });

    try {
      const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
      const userPrompt = text;

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      const isOlderModel = model && (model.startsWith("gpt-4") || model.startsWith("gpt-3"));
      const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, config);
      const reasoningEffort =
        effectiveProvider === "openai"
          ? getOpenAiReasoningEffort(model, reasoningPolicy)
          : effectiveProvider === "openrouter"
            ? getOpenRouterReasoningEffort(reasoningPolicy)
            : effectiveProvider === "custom"
              ? getCustomOpenAiReasoningEffort(model, reasoningPolicy)
              : null;
      const shouldSendTemperature =
        effectiveProvider !== "openai" || !isOpenAiReasoningModel(model);

      const openAiBase = this.getConfiguredOpenAIBase(effectiveProvider);
      const protocolMode: "auto" | "chat" | "responses" =
        effectiveProvider === "custom" && customProtocol !== CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL
          ? customProtocol
          : "auto";
      const endpointCandidates = this.getOpenAIEndpointCandidates(openAiBase, protocolMode, {
        preferChatInAuto: effectiveProvider === "custom" || effectiveProvider === "openrouter",
      });
      const isCustomEndpoint = openAiBase !== API_ENDPOINTS.OPENAI_BASE;

      logger.logReasoning("OPENAI_ENDPOINTS", {
        base: openAiBase,
        isCustomEndpoint,
        protocolMode,
        candidates: endpointCandidates.map((candidate) => candidate.url),
        preference: this.getStoredOpenAiPreference(openAiBase) || null,
      });

      if (isCustomEndpoint) {
        logger.logReasoning("CUSTOM_TEXT_CLEANUP_REQUEST", {
          customBase: openAiBase,
          model,
          textLength: text.length,
          hasApiKey: !!apiKey,
        });
      }

      // Streaming fast-path: only OpenAI Responses API, only when caller asks
      // for incremental progress. On any failure, fall through to the
      // existing non-stream withRetry path below.
      if (
        typeof config.onProgress === "function" &&
        effectiveProvider === "openai" &&
        endpointCandidates[0]?.type === "responses"
      ) {
        try {
          const reasoningFallbackKey = this.getLowLatencyParamFallbackKey(
            effectiveProvider,
            endpointCandidates[0].url,
            model,
            "reasoning"
          );
          const skipReasoningParam = this.isLowLatencyParamFallbackActive(reasoningFallbackKey);
          const streamBody: Record<string, unknown> = {
            model,
            input: messages,
            store: false,
            stream: true,
          };
          if (typeof config.maxTokens === "number") {
            streamBody.max_output_tokens = config.maxTokens;
          }
          if (!skipReasoningParam) {
            this.applyOpenAiReasoningEffort(streamBody, "reasoning", reasoningEffort);
          }

          const streamed = await this.streamOpenAiResponses(
            endpointCandidates[0].url,
            streamBody,
            apiKey,
            config.onProgress,
            config.signal
          );
          if (streamed && streamed.trim()) {
            this.rememberOpenAiPreference(openAiBase, "responses");
            logger.logReasoning("OPENAI_STREAM_SUCCESS", {
              model,
              responseLength: streamed.length,
            });
            return streamed.trim();
          }
          logger.logReasoning("OPENAI_STREAM_EMPTY_FALLBACK", { model });
        } catch (streamError) {
          this.throwIfAborted(config.signal);
          logger.logReasoning("OPENAI_STREAM_FALLBACK", {
            model,
            error: (streamError as Error).message,
          });
          // fall through to non-stream withRetry path
        }
      }

      // Skip streaming for `custom` providers: many OpenAI-compatible relays
      // return non-SSE JSON even when `stream: true` is requested, which would
      // make us wait the full 60s timeout before falling back to the non-stream
      // withRetry path (2x latency regression). The non-stream path below
      // already forces `requestBody.stream = false` for custom providers.
      if (
        typeof config.onProgress === "function" &&
        endpointCandidates[0]?.type === "chat" &&
        effectiveProvider !== "custom"
      ) {
        try {
          const chatCandidate = endpointCandidates[0];
          const reasoningParameter = this.getOpenAiReasoningParameter(
            effectiveProvider,
            chatCandidate.type
          );
          const reasoningFallbackKey = this.getLowLatencyParamFallbackKey(
            effectiveProvider,
            chatCandidate.url,
            model,
            reasoningParameter || "reasoning"
          );
          const skipReasoningParam = this.isLowLatencyParamFallbackActive(reasoningFallbackKey);
          const streamBody: Record<string, unknown> = {
            model,
            messages,
            stream: true,
          };

          if (typeof config.maxTokens === "number") {
            streamBody.max_tokens = config.maxTokens;
          }
          if (shouldSendTemperature && (isOlderModel || typeof config.temperature === "number")) {
            streamBody.temperature = config.temperature ?? 0.3;
          }
          if (!skipReasoningParam) {
            this.applyOpenAiReasoningEffort(streamBody, reasoningParameter, reasoningEffort);
          }

          const streamed = await this.streamChatCompletions(
            chatCandidate.url,
            streamBody,
            apiKey,
            config.onProgress,
            config.signal
          );
          if (streamed && streamed.trim()) {
            this.rememberOpenAiPreference(openAiBase, "chat");
            logger.logReasoning("OPENAI_CHAT_STREAM_SUCCESS", {
              model,
              provider: effectiveProvider,
              responseLength: streamed.length,
            });
            return streamed.trim();
          }
          logger.logReasoning("OPENAI_CHAT_STREAM_EMPTY_FALLBACK", {
            model,
            provider: effectiveProvider,
          });
        } catch (streamError) {
          this.throwIfAborted(config.signal);
          logger.logReasoning("OPENAI_CHAT_STREAM_FALLBACK", {
            model,
            provider: effectiveProvider,
            error: (streamError as Error).message,
          });
        }
      }

      const response = await withRetry(async () => {
        let lastError: Error | null = null;

        for (let index = 0; index < endpointCandidates.length; index += 1) {
          const { url: endpoint, type } = endpointCandidates[index];
          const hasFallbackEndpoint = index < endpointCandidates.length - 1;
          const request = this.createLinkedRequestController(30000, config.signal);
          try {
            const requestBody: Record<string, unknown> = { model };

            if (type === "responses") {
              requestBody.input = messages;
              requestBody.store = false;
              if (typeof config.maxTokens === "number") {
                requestBody.max_output_tokens = config.maxTokens;
              }
            } else {
              requestBody.messages = messages;
              if (effectiveProvider === "custom") {
                requestBody.stream = false;
              }
              if (typeof config.maxTokens === "number") {
                requestBody.max_tokens = config.maxTokens;
              }
              if (
                shouldSendTemperature &&
                (isOlderModel || typeof config.temperature === "number")
              ) {
                requestBody.temperature = config.temperature ?? 0.3;
              }
            }

            const performRequest = (body: Record<string, unknown>) =>
              this.fetchReasoningEndpoint(endpoint, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal: request.controller.signal,
              });

            const negotiatedRequest = await this.performOpenAiCompatibleRequest(
              effectiveProvider,
              type,
              endpoint,
              model,
              reasoningEffort,
              requestBody,
              performRequest
            );
            const res = negotiatedRequest.response;

            if (!res.ok) {
              const parsedError =
                negotiatedRequest.parsedError || (await this.parseOpenAiErrorResponse(res));
              const errorMessage = parsedError.message;

              const isUnsupportedEndpoint =
                (res.status === 404 || res.status === 405) && hasFallbackEndpoint;

              if (isUnsupportedEndpoint) {
                lastError = new Error(errorMessage);
                if (type === "responses") {
                  this.rememberOpenAiPreference(openAiBase, "chat");
                }
                logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                  attemptedEndpoint: endpoint,
                  error: errorMessage,
                  fromProtocol: type,
                  toProtocol: endpointCandidates[index + 1]?.type,
                });
                continue;
              }

              throw this.createHttpError(errorMessage, res.status, res.statusText);
            }

            this.rememberOpenAiPreference(openAiBase, type);
            return res.json();
          } catch (error) {
            this.throwIfAborted(config.signal);
            if ((error as Error).name === "AbortError") {
              throw new Error("Request timed out after 30s");
            }
            lastError = error as Error;
            if (type === "responses") {
              logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                attemptedEndpoint: endpoint,
                error: (error as Error).message,
              });
              continue;
            }
            throw error;
          } finally {
            request.cleanup();
          }
        }

        throw lastError || new Error("No OpenAI endpoint responded");
      }, createApiRetryStrategy());

      const isResponsesApi = Array.isArray(response?.output);
      const isChatCompletions = Array.isArray(response?.choices);

      logger.logReasoning("OPENAI_RAW_RESPONSE", {
        model,
        format: isResponsesApi ? "responses" : isChatCompletions ? "chat_completions" : "unknown",
        hasOutput: isResponsesApi,
        outputLength: isResponsesApi ? response.output.length : 0,
        outputTypes: isResponsesApi ? response.output.map((item: any) => item.type) : undefined,
        hasChoices: isChatCompletions,
        choicesLength: isChatCompletions ? response.choices.length : 0,
        usage: response.usage,
      });

      let responseText = "";

      if (isResponsesApi) {
        for (const item of response.output) {
          if (item.type === "message" && item.content) {
            for (const content of item.content) {
              if (content.type === "output_text" && content.text) {
                responseText = content.text.trim();
                break;
              }
            }
            if (responseText) break;
          }
        }
      }

      if (!responseText && typeof response?.output_text === "string") {
        responseText = response.output_text.trim();
      }

      if (!responseText && isChatCompletions) {
        for (const choice of response.choices) {
          const message = choice?.message ?? choice?.delta;
          const content = message?.content;

          if (typeof content === "string" && content.trim()) {
            responseText = content.trim();
            break;
          }

          if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part?.text === "string" && part.text.trim()) {
                responseText = part.text.trim();
                break;
              }
            }
          }

          if (responseText) break;

          if (typeof choice?.text === "string" && choice.text.trim()) {
            responseText = choice.text.trim();
            break;
          }
        }
      }

      logger.logReasoning("OPENAI_RESPONSE", {
        model,
        responseLength: responseText.length,
        tokensUsed: response.usage?.total_tokens || 0,
        success: responseText.length > 0,
        isEmpty: responseText.length === 0,
      });

      if (!responseText) {
        logger.logReasoning("OPENAI_EMPTY_RESPONSE", {
          model,
          originalTextLength: text.length,
          reason: "Empty response from API",
        });
        throw new Error("OpenAI returned empty response");
      }

      return responseText;
    } catch (error) {
      logger.logReasoning("OPENAI_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  }

  /**
   * Streams an OpenAI Responses API call and emits the accumulating text via
   * onProgress as `response.output_text.delta` events arrive. Resolves with
   * the final accumulated string when the stream completes.
   *
   * Throws on HTTP errors, abort, or stream-level `response.error` events so
   * the caller can fall back to the non-stream path.
   */
  private async streamOpenAiResponses(
    endpoint: string,
    body: Record<string, unknown>,
    apiKey: string,
    onProgress: (partial: string) => void,
    parentSignal?: AbortSignal
  ): Promise<string> {
    const request = this.createLinkedRequestController(60000, parentSignal);

    const throttle = createProgressThrottle(onProgress, 33);
    const state = {
      accumulated: "",
      streamError: null as Error | null,
      completed: false,
    };
    const consumePayload = (payload: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "response.output_text.delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta) {
          state.accumulated += delta;
          throttle.emit(state.accumulated);
        }
      } else if (eventType === "response.error") {
        const errObj = event.error as { message?: string } | undefined;
        state.streamError = new Error(errObj?.message || "OpenAI stream error");
      } else if (eventType === "response.completed") {
        state.completed = true;
      }
    };

    let response: Response;
    try {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      };

      response = await this.fetchReasoningStream(
        endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.controller.signal,
          stream: true,
        },
        {
          onPayload: consumePayload,
          flush: () => {
            if (state.accumulated) throttle.flush(state.accumulated);
          },
        }
      );

      if (this.isProxyResponse(response) && response.ok) {
        request.cleanup();
        if (state.streamError) throw state.streamError;
        return state.accumulated;
      }
    } catch (error) {
      request.cleanup();
      this.throwIfAborted(parentSignal);
      if ((error as Error).name === "AbortError") {
        throw new Error("OpenAI stream timed out after 60s");
      }
      throw error;
    }

    if (!response.ok) {
      request.cleanup();
      const parsedError = await this.parseOpenAiErrorResponse(response);
      throw new Error(parsedError.message);
    }

    try {
      for await (const payload of parseSseStream(response)) {
        consumePayload(payload);
        if (state.streamError) throw state.streamError;
        if (state.completed) break;
      }
    } finally {
      request.cleanup();
    }

    if (state.accumulated) throttle.flush(state.accumulated);
    return state.accumulated;
  }

  private async processWithAnthropic(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("ANTHROPIC_START", {
      model,
      agentName,
      environment: typeof window !== "undefined" ? "browser" : "node",
    });

    if (typeof window !== "undefined" && window.electronAPI) {
      const startTime = Date.now();

      logger.logReasoning("ANTHROPIC_IPC_CALL", {
        model,
        textLength: text.length,
      });

      const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
      const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, config);
      const effort = getAnthropicOutputEffort(model, reasoningPolicy);
      const requestId = this.createReasoningProxyRequestId();
      const cancelOnAbort = this.attachProxyCancelOnAbort(requestId, config.signal);
      let result: Awaited<ReturnType<typeof window.electronAPI.processAnthropicReasoning>>;
      try {
        result = await this.waitForAbortable(
          window.electronAPI.processAnthropicReasoning(text, model, agentName, {
            requestId,
            systemPrompt,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            contextSize: config.contextSize,
            effort,
          }),
          config.signal
        );
      } finally {
        cancelOnAbort();
      }

      const processingTime = Date.now() - startTime;

      if (result.success && typeof result.text === "string" && result.text.trim()) {
        logger.logReasoning("ANTHROPIC_SUCCESS", {
          model,
          processingTimeMs: processingTime,
          resultLength: result.text.length,
        });
        return result.text.trim();
      } else {
        logger.logReasoning("ANTHROPIC_ERROR", {
          model,
          processingTimeMs: processingTime,
          error: result.error,
        });
        throw new Error(result.error || "Anthropic reasoning returned no text");
      }
    } else {
      logger.logReasoning("ANTHROPIC_UNAVAILABLE", {
        reason: "Not in Electron environment",
      });
      throw new Error("Anthropic reasoning is not available in this environment");
    }
  }

  private async processWithLocal(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("LOCAL_START", {
      model,
      agentName,
      environment: typeof window !== "undefined" ? "browser" : "node",
    });

    if (typeof window !== "undefined" && window.electronAPI) {
      const startTime = Date.now();

      logger.logReasoning("LOCAL_IPC_CALL", {
        model,
        textLength: text.length,
      });

      const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
      const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, config);
      const thinkingBudgetTokens = getLocalThinkingBudget(model, reasoningPolicy);
      const requestId = this.createReasoningProxyRequestId();
      const cancelOnAbort = this.attachProxyCancelOnAbort(requestId, config.signal);
      let result: Awaited<ReturnType<typeof window.electronAPI.processLocalReasoning>>;
      try {
        result = await this.waitForAbortable(
          window.electronAPI.processLocalReasoning(text, model, agentName, {
            requestId,
            systemPrompt,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            contextSize: config.contextSize,
            thinkingBudgetTokens,
          }),
          config.signal
        );
      } finally {
        cancelOnAbort();
      }

      const processingTime = Date.now() - startTime;

      if (result.success && typeof result.text === "string" && result.text.trim()) {
        logger.logReasoning("LOCAL_SUCCESS", {
          model,
          processingTimeMs: processingTime,
          resultLength: result.text.length,
        });
        return result.text.trim();
      } else {
        logger.logReasoning("LOCAL_ERROR", {
          model,
          processingTimeMs: processingTime,
          error: result.error,
        });
        throw new Error(result.error || "Local reasoning returned no text");
      }
    } else {
      logger.logReasoning("LOCAL_UNAVAILABLE", {
        reason: "Not in Electron environment",
      });
      throw new Error("Local reasoning is not available in this environment");
    }
  }

  private async getOpenAiCompatibleGeminiApiKey(): Promise<string> {
    return this.getGeminiCompatibleApiKey();
  }

  private async getGeminiCompatibleApiKey(): Promise<string> {
    const customKey = (await this.getApiKey("custom")).trim();
    if (customKey) {
      return customKey;
    }
    return this.getApiKey("gemini");
  }

  private async processWithOpenAiCompatibleGeminiEndpoint(
    text: string,
    model: string,
    agentName: string | null,
    config: ReasoningConfig,
    baseUrl: string
  ): Promise<string> {
    const apiKey = await this.getOpenAiCompatibleGeminiApiKey();
    const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ];
    const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, config);
    const reasoningEffort = getGeminiOpenAiReasoningEffort(model, reasoningPolicy);
    const endpointCandidates = this.getOpenAIEndpointCandidates(baseUrl, "auto", {
      preferChatInAuto: true,
    });

    logger.logReasoning("GEMINI_OPENAI_COMPAT_START", {
      model,
      base: baseUrl,
      hasApiKey: !!apiKey,
      candidates: endpointCandidates.map((candidate) => candidate.url),
      preference: this.getStoredOpenAiPreference(baseUrl) || null,
    });

    const response = await withRetry(async () => {
      let lastError: Error | null = null;

      for (let index = 0; index < endpointCandidates.length; index += 1) {
        const { url: endpoint, type } = endpointCandidates[index];
        const hasFallbackEndpoint = index < endpointCandidates.length - 1;
        const request = this.createLinkedRequestController(30000, config.signal);

        try {
          const requestBody: Record<string, unknown> = { model };

          if (type === "responses") {
            requestBody.input = messages;
            requestBody.store = false;
            if (typeof config.maxTokens === "number") {
              requestBody.max_output_tokens = config.maxTokens;
            }
          } else {
            requestBody.messages = messages;
            requestBody.stream = false;
            if (typeof config.maxTokens === "number") {
              requestBody.max_tokens = config.maxTokens;
            }
            if (typeof config.temperature === "number") {
              requestBody.temperature = config.temperature;
            }
          }

          logger.logReasoning("GEMINI_OPENAI_COMPAT_REQUEST", {
            endpoint,
            type,
            model,
            hasApiKey: !!apiKey,
            systemPromptLength: systemPrompt.length,
            userPromptLength: text.length,
          });

          const performRequest = (body: Record<string, unknown>) =>
            this.fetchReasoningEndpoint(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(body),
              signal: request.controller.signal,
            });

          const negotiatedRequest = await this.performOpenAiCompatibleRequest(
            "gemini-compatible",
            type,
            endpoint,
            model,
            reasoningEffort,
            requestBody,
            performRequest
          );
          const res = negotiatedRequest.response;

          if (!res.ok) {
            const parsedError =
              negotiatedRequest.parsedError || (await this.parseOpenAiErrorResponse(res));

            const isUnsupportedEndpoint =
              (res.status === 404 || res.status === 405) && hasFallbackEndpoint;

            if (isUnsupportedEndpoint) {
              lastError = new Error(parsedError.message);
              if (type === "responses") {
                this.rememberOpenAiPreference(baseUrl, "chat");
              }
              logger.logReasoning("GEMINI_OPENAI_COMPAT_ENDPOINT_FALLBACK", {
                attemptedEndpoint: endpoint,
                error: parsedError.message,
                fromProtocol: type,
                toProtocol: endpointCandidates[index + 1]?.type,
              });
              continue;
            }

            logger.logReasoning("GEMINI_OPENAI_COMPAT_ERROR_DETAIL", {
              status: res.status,
              statusText: res.statusText,
              error: parsedError.payload,
              errorMessage: parsedError.message,
              fullResponse: parsedError.rawText.substring(0, 500),
            });

            throw this.createHttpError(parsedError.message, res.status, res.statusText);
          }

          this.rememberOpenAiPreference(baseUrl, type);
          return res.json();
        } catch (error) {
          this.throwIfAborted(config.signal);
          if ((error as Error).name === "AbortError") {
            throw new Error("Request timed out after 30s");
          }
          lastError = error as Error;
          if (type === "responses" && hasFallbackEndpoint) {
            logger.logReasoning("GEMINI_OPENAI_COMPAT_ENDPOINT_FALLBACK", {
              attemptedEndpoint: endpoint,
              error: (error as Error).message,
              fromProtocol: type,
              toProtocol: endpointCandidates[index + 1]?.type,
            });
            continue;
          }
          throw error;
        } finally {
          request.cleanup();
        }
      }

      throw lastError || new Error("No OpenAI-compatible Gemini endpoint responded");
    }, createApiRetryStrategy());

    const isResponsesApi = Array.isArray(response?.output);
    const isChatCompletions = Array.isArray(response?.choices);
    let responseText = "";

    if (isResponsesApi) {
      for (const item of response.output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const content of item.content) {
            if (content?.type === "output_text" && typeof content.text === "string") {
              responseText = content.text.trim();
              break;
            }
          }
          if (responseText) break;
        }
      }
    }

    if (!responseText && typeof response?.output_text === "string") {
      responseText = response.output_text.trim();
    }

    if (!responseText && isChatCompletions) {
      for (const choice of response.choices) {
        const message = choice?.message ?? choice?.delta;
        const content = message?.content;
        if (typeof content === "string" && content.trim()) {
          responseText = content.trim();
          break;
        }
        if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part?.text === "string" && part.text.trim()) {
              responseText = part.text.trim();
              break;
            }
          }
        }
        if (responseText) break;
      }
    }

    logger.logReasoning("GEMINI_OPENAI_COMPAT_RESPONSE", {
      model,
      format: isResponsesApi ? "responses" : isChatCompletions ? "chat_completions" : "unknown",
      responseLength: responseText.length,
      tokensUsed: response?.usage?.total_tokens || 0,
    });

    if (!responseText) {
      throw new Error("OpenAI-compatible Gemini endpoint returned empty response");
    }

    return responseText;
  }

  private async processWithGemini(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("GEMINI_START", {
      model,
      agentName,
      hasApiKey: false,
    });

    try {
      const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
      const userPrompt = text;

      const rawGeminiBase = this.getProviderEndpointOverride("gemini") || API_ENDPOINTS.GEMINI;
      const geminiEndpointFamily = getGeminiEndpointFamily(rawGeminiBase);
      const rawGeminiRequestBase = getGeminiRequestBaseUrl(rawGeminiBase) || rawGeminiBase;
      const geminiBase = this.getOfficialGoogleGeminiGenerateContentBase(rawGeminiBase);
      if (geminiBase !== rawGeminiRequestBase) {
        logger.logReasoning("GEMINI_OFFICIAL_ENDPOINT_NORMALIZED", {
          model,
          from: rawGeminiRequestBase,
          to: geminiBase,
          reason: "official-generate-content-v1beta",
        });
      }
      if (isOpenAiCompatibleGeminiEndpoint(geminiBase)) {
        logger.logReasoning("GEMINI_OPENAI_COMPAT_ROUTE", {
          model,
          base: geminiBase,
        });
        return this.processWithOpenAiCompatibleGeminiEndpoint(
          text,
          model,
          agentName,
          config,
          geminiBase
        );
      }

      const apiKey =
        geminiEndpointFamily === "compatible"
          ? await this.getGeminiCompatibleApiKey()
          : await this.getApiKey("gemini");

      logger.logReasoning("GEMINI_API_KEY", {
        hasApiKey: !!apiKey,
        endpointFamily: geminiEndpointFamily,
        keySource: geminiEndpointFamily === "compatible" ? "custom_or_gemini" : "gemini",
      });

      const geminiEndpoint = `${geminiBase}/models/${model}:generateContent`;
      const thinkingFallbackKey = this.getLowLatencyParamFallbackKey(
        "gemini",
        geminiEndpoint,
        model,
        "thinkingConfig"
      );
      const skipThinkingConfig = this.isLowLatencyParamFallbackActive(thinkingFallbackKey);

      const generationConfig: Record<string, unknown> = {
        temperature: config.temperature ?? 0.3,
        maxOutputTokens:
          config.maxTokens ||
          Math.max(
            2000,
            this.calculateMaxTokens(
              text.length,
              TOKEN_LIMITS.MIN_TOKENS_GEMINI,
              TOKEN_LIMITS.MAX_TOKENS_GEMINI,
              TOKEN_LIMITS.TOKEN_MULTIPLIER
            )
          ),
      };

      const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, config);
      const thinkingConfig = getGeminiThinkingConfig(model, reasoningPolicy);
      if (thinkingConfig && !skipThinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
      }

      const requestBody: {
        systemInstruction: { parts: Array<{ text: string }> };
        contents: Array<{ role: string; parts: Array<{ text: string }> }>;
        generationConfig: Record<string, unknown>;
      } = {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig,
      };

      // Streaming fast-path. Uses :streamGenerateContent?alt=sse. Same body
      // shape. Falls through to the non-stream withRetry path on any failure.
      if (typeof config.onProgress === "function") {
        try {
          const streamEndpoint = `${geminiBase}/models/${model}:streamGenerateContent?alt=sse`;
          const streamed = await this.streamGemini(
            streamEndpoint,
            requestBody,
            apiKey,
            config.onProgress,
            config.signal
          );
          if (streamed && streamed.trim()) {
            logger.logReasoning("GEMINI_STREAM_SUCCESS", {
              model,
              responseLength: streamed.length,
            });
            return streamed.trim();
          }
          logger.logReasoning("GEMINI_STREAM_EMPTY_FALLBACK", { model });
        } catch (streamError) {
          this.throwIfAborted(config.signal);
          logger.logReasoning("GEMINI_STREAM_FALLBACK", {
            model,
            error: (streamError as Error).message,
          });
        }
      }

      let response: any;
      try {
        response = await withRetry(async () => {
          logger.logReasoning("GEMINI_REQUEST", {
            endpoint: geminiEndpoint,
            model,
            hasApiKey: !!apiKey,
            systemPromptLength: systemPrompt.length,
            userPromptLength: userPrompt.length,
            requestBody: JSON.stringify(requestBody).substring(0, 200),
          });

          const request = this.createLinkedRequestController(30000, config.signal);
          try {
            const performRequest = (body: typeof requestBody, endpoint = geminiEndpoint) =>
              this.fetchReasoningEndpoint(endpoint, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": apiKey,
                },
                body: JSON.stringify(body),
                signal: request.controller.signal,
              });

            let res = await performRequest(requestBody);

            if (!res.ok) {
              let parsedError = await this.parseOpenAiErrorResponse(res);

              if (
                this.shouldRetryOfficialGeminiWithV1Beta(
                  res.status,
                  parsedError.payload,
                  parsedError.rawText,
                  geminiEndpoint
                )
              ) {
                const betaEndpoint = this.toOfficialGeminiV1BetaEndpoint(geminiEndpoint);
                logger.logReasoning("GEMINI_OFFICIAL_V1BETA_RETRY", {
                  endpoint: geminiEndpoint,
                  retryEndpoint: betaEndpoint,
                  model,
                  status: res.status,
                  reason: parsedError.message,
                });
                res = await performRequest(requestBody, betaEndpoint);
                if (res.ok) {
                  return res.json();
                }
                parsedError = await this.parseOpenAiErrorResponse(res);
              }

              if (
                this.shouldRetryWithoutGeminiThinkingConfig(
                  res.status,
                  parsedError.payload,
                  parsedError.rawText,
                  requestBody
                )
              ) {
                const retryBody = {
                  ...requestBody,
                  generationConfig: { ...requestBody.generationConfig },
                };
                delete retryBody.generationConfig.thinkingConfig;
                this.rememberLowLatencyParamFallback(thinkingFallbackKey, {
                  provider: "gemini",
                  endpoint: geminiEndpoint,
                  model,
                  parameter: "thinkingConfig",
                  status: res.status,
                });

                logger.logReasoning("GEMINI_THINKING_CONFIG_FALLBACK", {
                  endpoint: geminiEndpoint,
                  model,
                  status: res.status,
                  reason: parsedError.message,
                });

                res = await performRequest(retryBody);
                if (res.ok) {
                  return res.json();
                }
                parsedError = await this.parseOpenAiErrorResponse(res);
              }

              logger.logReasoning("GEMINI_API_ERROR_DETAIL", {
                status: res.status,
                statusText: res.statusText,
                error: parsedError.payload,
                errorMessage: parsedError.message,
                fullResponse: parsedError.rawText.substring(0, 500),
              });

              throw this.createHttpError(
                parsedError.message || `Gemini API error: ${res.status}`,
                res.status,
                res.statusText
              );
            }

            const jsonResponse = await res.json();

            logger.logReasoning("GEMINI_RAW_RESPONSE", {
              hasResponse: !!jsonResponse,
              responseKeys: jsonResponse ? Object.keys(jsonResponse) : [],
              hasCandidates: !!jsonResponse?.candidates,
              candidatesLength: jsonResponse?.candidates?.length || 0,
              fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
            });

            const firstCandidate = jsonResponse?.candidates?.[0];
            if (
              firstCandidate &&
              !this.extractGeminiCandidateText(firstCandidate) &&
              requestBody.generationConfig &&
              "thinkingConfig" in requestBody.generationConfig
            ) {
              const retryBody = {
                ...requestBody,
                generationConfig: { ...requestBody.generationConfig },
              };
              delete retryBody.generationConfig.thinkingConfig;
              this.rememberLowLatencyParamFallback(thinkingFallbackKey, {
                provider: "gemini",
                endpoint: geminiEndpoint,
                model,
                parameter: "thinkingConfig",
                status: 200,
              });

              logger.logReasoning("GEMINI_EMPTY_THINKING_CONFIG_FALLBACK", {
                endpoint: geminiEndpoint,
                model,
                finishReason: firstCandidate.finishReason,
              });

              const retryRes = await performRequest(retryBody);
              if (retryRes.ok) {
                const retryJsonResponse = await retryRes.json();
                logger.logReasoning("GEMINI_RAW_RESPONSE_AFTER_EMPTY_FALLBACK", {
                  hasResponse: !!retryJsonResponse,
                  responseKeys: retryJsonResponse ? Object.keys(retryJsonResponse) : [],
                  hasCandidates: !!retryJsonResponse?.candidates,
                  candidatesLength: retryJsonResponse?.candidates?.length || 0,
                  fullResponse: JSON.stringify(retryJsonResponse).substring(0, 500),
                });
                return retryJsonResponse;
              }
            }

            return jsonResponse;
          } catch (error) {
            this.throwIfAborted(config.signal);
            if ((error as Error).name === "AbortError") {
              throw new Error("Request timed out after 30s");
            }
            throw error;
          } finally {
            request.cleanup();
          }
        }, createApiRetryStrategy());
      } catch (fetchError) {
        logger.logReasoning("GEMINI_FETCH_ERROR", {
          error: (fetchError as Error).message,
          stack: (fetchError as Error).stack,
        });
        throw fetchError;
      }

      if (!response.candidates || !response.candidates[0]) {
        logger.logReasoning("GEMINI_RESPONSE_ERROR", {
          model,
          response: JSON.stringify(response).substring(0, 500),
          hasCandidate: !!response.candidates,
          candidateCount: response.candidates?.length || 0,
        });
        throw new Error("Invalid response structure from Gemini API");
      }

      const candidate = response.candidates[0];
      const rawResponseText = this.extractGeminiCandidateText(candidate);
      if (!rawResponseText) {
        logger.logReasoning("GEMINI_EMPTY_RESPONSE", {
          model,
          finishReason: candidate.finishReason,
          hasContent: !!candidate.content,
          hasParts: !!candidate.content?.parts,
          response: JSON.stringify(candidate).substring(0, 500),
        });

        if (candidate.finishReason === "MAX_TOKENS") {
          throw new Error(
            "Gemini reached token limit before generating response. Try a shorter input or increase max tokens."
          );
        }
        throw new Error("Gemini returned empty response");
      }

      const fallbackToOriginal = this.shouldFallbackGeminiFastCleanup(
        text,
        rawResponseText,
        config
      );
      const responseText = fallbackToOriginal ? text.trim() : rawResponseText;

      if (fallbackToOriginal) {
        logger.logReasoning("GEMINI_FAST_CLEANUP_FALLBACK", {
          model,
          originalLength: text.length,
          responseLength: rawResponseText.length,
          originalPreview: text.substring(0, 100),
          responsePreview: rawResponseText.substring(0, 100),
        });
      }

      logger.logReasoning("GEMINI_RESPONSE", {
        model,
        responseLength: responseText.length,
        rawResponseLength: rawResponseText.length,
        tokensUsed: response.usageMetadata?.totalTokenCount || 0,
        success: true,
        fallbackToOriginal,
      });

      return responseText;
    } catch (error) {
      logger.logReasoning("GEMINI_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  }

  /**
   * Streams Gemini's streamGenerateContent SSE endpoint, accumulating text
   * parts and emitting via onProgress. Throws on MAX_TOKENS so the caller
   * can fall back to non-stream (which may have a larger token ceiling).
   */
  private async streamGemini(
    endpoint: string,
    body: unknown,
    apiKey: string,
    onProgress: (partial: string) => void,
    parentSignal?: AbortSignal
  ): Promise<string> {
    const request = this.createLinkedRequestController(60000, parentSignal);

    const throttle = createProgressThrottle(onProgress, 33);
    const state = {
      accumulated: "",
      maxTokensHit: false,
      streamError: null as Error | null,
    };
    const consumePayload = (payload: string) => {
      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      const candidate = event?.candidates?.[0];
      const parts = candidate?.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part?.text === "string" && part.text) {
            state.accumulated += part.text;
          }
        }
        if (state.accumulated) throttle.emit(state.accumulated);
      }
      if (candidate?.finishReason === "MAX_TOKENS") {
        state.maxTokensHit = true;
      }
      const errorMessage =
        typeof event?.error?.message === "string" ? event.error.message : undefined;
      if (errorMessage) {
        state.streamError = new Error(errorMessage);
      }
    };

    let response: Response;
    try {
      const headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        Accept: "text/event-stream",
      };

      response = await this.fetchReasoningStream(
        endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.controller.signal,
          stream: true,
        },
        {
          onPayload: consumePayload,
          flush: () => {
            if (state.accumulated) throttle.flush(state.accumulated);
          },
        }
      );

      if (this.isProxyResponse(response) && response.ok) {
        request.cleanup();
        if (state.streamError) throw state.streamError;
        if (state.maxTokensHit && !state.accumulated.trim()) {
          throw new Error("Gemini stream hit MAX_TOKENS before producing text");
        }
        return state.accumulated;
      }
    } catch (error) {
      request.cleanup();
      this.throwIfAborted(parentSignal);
      if ((error as Error).name === "AbortError") {
        throw new Error("Gemini stream timed out after 60s");
      }
      throw error;
    }

    if (!response.ok) {
      request.cleanup();
      const parsedError = await this.parseOpenAiErrorResponse(response);
      throw new Error(parsedError.message);
    }

    try {
      for await (const payload of parseSseStream(response)) {
        consumePayload(payload);
        if (state.streamError) throw state.streamError;
      }
    } finally {
      request.cleanup();
    }

    if (state.maxTokensHit && !state.accumulated.trim()) {
      throw new Error("Gemini stream hit MAX_TOKENS before producing text");
    }

    if (state.accumulated) throttle.flush(state.accumulated);
    return state.accumulated;
  }

  private async processWithGroq(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("GROQ_START", { model, agentName });

    const apiKey = await this.getApiKey("groq");

    try {
      const groqBase = this.getProviderEndpointOverride("groq") || API_ENDPOINTS.GROQ_BASE;
      const endpoint = buildApiUrl(groqBase, "/chat/completions");
      return await this.callChatCompletionsApi(
        endpoint,
        apiKey,
        model,
        text,
        agentName,
        config,
        "Groq"
      );
    } catch (error) {
      logger.logReasoning("GROQ_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  }

  private async processWithCerebras(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("CEREBRAS_START", { model, agentName });

    const apiKey = await this.getApiKey("cerebras");

    try {
      const cerebrasBase =
        this.getProviderEndpointOverride("cerebras") || ReasoningService.CEREBRAS_BASE;
      const endpoint = buildApiUrl(cerebrasBase, "/chat/completions");
      return await this.callChatCompletionsApi(
        endpoint,
        apiKey,
        model,
        text,
        agentName,
        config,
        "Cerebras"
      );
    } catch (error) {
      logger.logReasoning("CEREBRAS_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  }

  private async processWithBedrock(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("BEDROCK_START", { model, agentName });

    const accessKeyId = (window.localStorage?.getItem("bedrockAccessKeyId") || "").trim();
    const secretAccessKey = (window.localStorage?.getItem("bedrockSecretAccessKey") || "").trim();
    const region = (window.localStorage?.getItem("bedrockRegion") || "us-east-1").trim();
    const sessionToken =
      (window.localStorage?.getItem("bedrockSessionToken") || "").trim() || undefined;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error("AWS Bedrock credentials not configured");
    }

    try {
      const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
      const userPrompt = text;

      const configuredBedrockBase = this.getProviderEndpointOverride("bedrock");
      const configuredIsGeneratedAwsEndpoint =
        !!configuredBedrockBase &&
        /^https:\/\/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i.test(configuredBedrockBase);
      const bedrockBase =
        configuredBedrockBase && !configuredIsGeneratedAwsEndpoint
          ? configuredBedrockBase
          : `https://bedrock-runtime.${region}.amazonaws.com`;
      const endpoint = `${bedrockBase}/model/${model}/converse`;

      const requestBody = JSON.stringify({
        system: [{ text: systemPrompt }],
        messages: [{ role: "user", content: [{ text: userPrompt }] }],
        inferenceConfig: {
          temperature: config.temperature ?? 0.3,
          maxTokens:
            config.maxTokens ||
            Math.max(
              4096,
              this.calculateMaxTokens(
                text.length,
                TOKEN_LIMITS.MIN_TOKENS,
                TOKEN_LIMITS.MAX_TOKENS,
                TOKEN_LIMITS.TOKEN_MULTIPLIER
              )
            ),
        },
      });

      logger.logReasoning("BEDROCK_REQUEST", {
        endpoint,
        model,
        region,
        requestPreview: requestBody.substring(0, 200),
      });

      const signed = await signRequest({
        method: "POST",
        url: endpoint,
        region,
        service: "bedrock",
        accessKeyId,
        secretAccessKey,
        sessionToken,
        body: requestBody,
        headers: { "content-type": "application/json" },
      });

      const response = await withRetry(async () => {
        const request = this.createLinkedRequestController(30000, config.signal);
        try {
          const res = await fetch(signed.url, {
            method: "POST",
            headers: signed.headers,
            body: requestBody,
            signal: request.controller.signal,
          });

          if (!res.ok) {
            const errorText = await res.text();
            let errorData: any = { error: res.statusText };
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: errorText || res.statusText };
            }
            const errorMessage =
              errorData.message ||
              errorData.error?.message ||
              errorData.error ||
              `Bedrock API error: ${res.status}`;
            throw this.createHttpError(errorMessage, res.status, res.statusText);
          }

          return await res.json();
        } catch (error) {
          this.throwIfAborted(config.signal);
          if ((error as Error).name === "AbortError") {
            throw new Error("Bedrock request timed out after 30s");
          }
          throw error;
        } finally {
          request.cleanup();
        }
      }, createApiRetryStrategy());

      // Bedrock Converse API response format
      let responseText = "";
      if (response?.output?.message?.content) {
        for (const block of response.output.message.content) {
          if (block.text) {
            responseText += block.text;
          }
        }
      }
      // Fallback: OpenAI-compatible response format
      if (!responseText && response?.choices?.[0]?.message?.content) {
        responseText = response.choices[0].message.content;
      }

      responseText = responseText.trim();

      logger.logReasoning("BEDROCK_RESPONSE", {
        model,
        responseLength: responseText.length,
        usage: response.usage,
        success: !!responseText,
      });

      if (!responseText) {
        throw new Error("Bedrock returned empty response");
      }

      return responseText;
    } catch (error) {
      logger.logReasoning("BEDROCK_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  }

  private async processWithChordVoxCloud(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    if (!isHostedCloudModeEnabled("chordvox_cloud")) {
      const error = new Error(
        "ChordVox hosted cloud is not available. Configure a local model or BYOK provider."
      ) as Error & { code?: string };
      error.code = "HOSTED_CLOUD_UNAVAILABLE";
      throw error;
    }

    logger.logReasoning("CHORDVOX_CLOUD_START", { model, agentName });

    try {
      const customDictionary = this.getCustomDictionary();
      const language = this.getPreferredLanguage();
      const locale = this.getUiLanguage();
      const reasoningPolicy = this.getRequestReasoningPolicy(text, agentName, config);

      const result = await runRequestWithoutAccount(async () => {
        const res = await (window as any).electronAPI.cloudReason(text, {
          model,
          agentName,
          customDictionary,
          customPrompt: this.getEffectiveCloudPrompt(agentName, text, config),
          language,
          locale,
          disableThinking: reasoningPolicy.profile === "fast-cleanup",
          temperature: config.temperature ?? 0.1,
        });

        if (!res.success) {
          const err: any = new Error(res.error || "ChordVox cloud reasoning failed");
          err.code = res.code;
          throw err;
        }

        return res;
      });

      logger.logReasoning("CHORDVOX_CLOUD_SUCCESS", {
        model: result.model,
        provider: result.provider,
        resultLength: result.text.length,
      });

      return result.text;
    } catch (error) {
      logger.logReasoning("CHORDVOX_CLOUD_ERROR", {
        model,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  protected getCustomDictionary(): string[] {
    try {
      const raw = localStorage.getItem("customDictionary");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private getCustomPrompt(): string | undefined {
    try {
      const raw = localStorage.getItem("customUnifiedPrompt");
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private getConfiguredReasoningTarget(): { provider: string; model: string } {
    const configuredModel = (window.localStorage?.getItem("reasoningModel") || "").trim();
    const configuredProvider = this.normalizeProviderOverride(
      window.localStorage?.getItem("reasoningProvider")
    );

    if (configuredProvider === "local" && configuredModel) {
      return { provider: "local", model: configuredModel };
    }

    const cloudReasoningMode = normalizeAvailableCloudMode(
      window.localStorage?.getItem("cloudReasoningMode"),
      "byok"
    );
    const isSignedIn = window.localStorage?.getItem("isSignedIn") === "true";

    if (isSignedIn && isHostedCloudModeEnabled(cloudReasoningMode)) {
      return { provider: CHORDVOX_CLOUD_PROVIDER, model: CHORDVOX_CLOUD_MODEL };
    }

    return {
      provider:
        configuredProvider && configuredProvider !== "auto"
          ? configuredProvider
          : getModelProvider(configuredModel),
      model: configuredModel,
    };
  }

  async prewarmFromSettings(force = false): Promise<boolean> {
    if (typeof window === "undefined" || !window.localStorage) {
      return false;
    }

    const now = Date.now();
    if (!force && this.reasoningWarmupPromise) {
      return this.reasoningWarmupPromise;
    }
    if (!force && now < this.reasoningWarmupExpiresAt) {
      return true;
    }

    this.reasoningWarmupPromise = (async () => {
      const enabledRaw = window.localStorage.getItem("useReasoningModel");
      const enabled = enabledRaw === "true";
      if (!enabled) {
        return false;
      }

      const proAccess = await this.getProAccessState();
      if (!proAccess.allowed) {
        return false;
      }

      const { provider, model } = this.getConfiguredReasoningTarget();
      if (!provider || (provider !== CHORDVOX_CLOUD_PROVIDER && !model)) {
        return false;
      }

      logger.logReasoning("REASONING_WARMUP_START", {
        provider,
        model: model || null,
        force,
      });

      switch (provider) {
        case "openai":
        case "openrouter":
          await this.getApiKey(provider as "openai" | "openrouter");
          this.getOpenAIEndpointCandidates(this.getConfiguredOpenAIBase(provider), "auto");
          break;
        case "anthropic":
        case "groq":
        case "cerebras":
        case "bedrock":
          await this.getApiKey(provider as "anthropic" | "groq" | "cerebras" | "bedrock");
          break;
        case "gemini": {
          const rawGeminiBase = this.getProviderEndpointOverride("gemini") || API_ENDPOINTS.GEMINI;
          const geminiEndpointFamily = getGeminiEndpointFamily(rawGeminiBase);
          const geminiBase = getGeminiRequestBaseUrl(rawGeminiBase) || rawGeminiBase;
          if (isOpenAiCompatibleGeminiEndpoint(geminiBase)) {
            await this.getOpenAiCompatibleGeminiApiKey();
          } else if (geminiEndpointFamily === "compatible") {
            await this.getGeminiCompatibleApiKey();
          } else {
            await this.getApiKey("gemini");
          }
          break;
        }
        case "custom":
          await this.getApiKey("custom");
          if (this.getCustomReasoningProtocol() === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL) {
            this.getConfiguredCustomReasoningEndpoint();
          } else {
            this.getConfiguredOpenAIBase("custom");
          }
          break;
        case "local":
          await window.electronAPI?.checkLocalReasoningAvailable?.();
          break;
        case CHORDVOX_CLOUD_PROVIDER:
          {
            const cloudUsage = window.electronAPI?.cloudUsage;
            if (!cloudUsage) break;
            await runRequestWithoutAccount(async () => {
              const res = await cloudUsage();
              if (!res?.success && res?.code) {
                const err: Error & { code?: string } = new Error(
                  res.error || "Cloud reasoning warmup failed"
                );
                err.code = res.code;
                throw err;
              }
              return res;
            });
          }
          break;
        default:
          return false;
      }

      this.reasoningWarmupExpiresAt = Date.now() + ReasoningService.REASONING_WARMUP_TTL_MS;
      logger.logReasoning("REASONING_WARMUP_SUCCESS", {
        provider,
        model: model || null,
      });
      return true;
    })()
      .catch((error) => {
        logger.logReasoning("REASONING_WARMUP_ERROR", {
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
        return false;
      })
      .finally(() => {
        this.reasoningWarmupPromise = null;
      });

    return this.reasoningWarmupPromise;
  }

  async isAvailable(
    provider?: string,
    options: ReasoningAvailabilityOptions = {}
  ): Promise<boolean> {
    try {
      const proAccess = await this.getProAccessState();
      if (!proAccess.allowed && options.allowProPreview !== true) {
        return false;
      }

      const getKeyWithFallback = async (
        ipcGetter: (() => Promise<string | null | undefined>) | undefined,
        localStorageKey: string
      ): Promise<string> => {
        let key = "";
        try {
          key = (await ipcGetter?.()) || "";
        } catch {
          /* ignore IPC errors */
        }
        if (!key && typeof window !== "undefined" && window.localStorage) {
          key = window.localStorage.getItem(localStorageKey) || "";
        }
        return key.trim();
      };

      const openaiKey = await getKeyWithFallback(
        async () => window.electronAPI?.getOpenAIKey?.({ allowKeychain: true }),
        "openaiApiKey"
      );
      const openrouterKey = await getKeyWithFallback(
        async () => window.electronAPI?.getOpenRouterKey?.({ allowKeychain: true }),
        "openrouterApiKey"
      );
      const anthropicKey = await getKeyWithFallback(
        async () => window.electronAPI?.getAnthropicKey?.({ allowKeychain: true }),
        "anthropicApiKey"
      );
      const geminiKey = await getKeyWithFallback(
        async () => window.electronAPI?.getGeminiKey?.({ allowKeychain: true }),
        "geminiApiKey"
      );
      const groqKey = await getKeyWithFallback(
        async () => window.electronAPI?.getGroqKey?.({ allowKeychain: true }),
        "groqApiKey"
      );
      const cerebrasKey = await getKeyWithFallback(
        async () => window.electronAPI?.getCerebrasKey?.({ allowKeychain: true }),
        "cerebrasApiKey"
      );
      const customReasoningKey = await getKeyWithFallback(
        async () => window.electronAPI?.getCustomReasoningKey?.({ allowKeychain: true }),
        "customReasoningApiKey"
      );
      const bedrockAccessKey = (window.localStorage?.getItem("bedrockAccessKeyId") || "").trim();
      const bedrockSecretKey = (
        window.localStorage?.getItem("bedrockSecretAccessKey") || ""
      ).trim();
      const localAvailable = await window.electronAPI?.checkLocalReasoningAvailable?.();
      const configuredProvider =
        this.normalizeProviderOverride(
          provider || window.localStorage?.getItem("reasoningProvider") || "auto"
        ) || "auto";
      const customEndpoint = (window.localStorage?.getItem("cloudReasoningBaseUrl") || "").trim();
      const rawGeminiBase = this.getProviderEndpointOverride("gemini") || API_ENDPOINTS.GEMINI;
      const geminiEndpointFamily = getGeminiEndpointFamily(rawGeminiBase);
      const geminiUsesCompatibleEndpoint = geminiEndpointFamily === "compatible";

      logger.logReasoning("API_KEY_CHECK", {
        provider: configuredProvider,
        hasOpenAI: !!openaiKey,
        hasOpenRouter: !!openrouterKey,
        hasAnthropic: !!anthropicKey,
        hasGemini: !!geminiKey,
        hasGroq: !!groqKey,
        hasCerebras: !!cerebrasKey,
        hasCustomReasoningKey: !!customReasoningKey,
        hasCustomEndpoint: !!customEndpoint,
        geminiEndpointFamily,
        hasBedrock: !!(bedrockAccessKey && bedrockSecretKey),
        hasLocal: !!localAvailable,
      });

      switch (configuredProvider) {
        case "openai":
          return !!openaiKey;
        case "openrouter":
          return !!openrouterKey;
        case "anthropic":
          return !!anthropicKey;
        case "gemini":
          return geminiUsesCompatibleEndpoint ? !!(customReasoningKey || geminiKey) : !!geminiKey;
        case "groq":
          return !!groqKey;
        case "cerebras":
          return !!cerebrasKey;
        case "bedrock":
          return !!(bedrockAccessKey && bedrockSecretKey);
        case "local":
          return !!localAvailable;
        case "custom":
          // Custom endpoint can be keyless; endpoint URL is the minimum requirement.
          return !!customEndpoint;
        case CHORDVOX_CLOUD_PROVIDER:
          // ChordVox cloud path handles auth errors at call-time.
          return true;
        case "auto":
        default:
          return !!(
            openaiKey ||
            openrouterKey ||
            anthropicKey ||
            geminiKey ||
            groqKey ||
            cerebrasKey ||
            customReasoningKey ||
            localAvailable ||
            customEndpoint
          );
      }
    } catch (error) {
      logger.logReasoning("API_KEY_CHECK_ERROR", {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
      });
      return false;
    }
  }

  clearApiKeyCache(
    provider?:
      | "openai"
      | "openrouter"
      | "anthropic"
      | "gemini"
      | "groq"
      | "cerebras"
      | "mistral"
      | "custom"
  ): void {
    if (provider) {
      if (provider !== "custom") {
        this.apiKeyCache.delete(provider);
        this.pendingApiKeyFetches.delete(provider as ApiKeyProvider);
      }
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider });
    } else {
      this.apiKeyCache.clear();
      this.pendingApiKeyFetches.clear();
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider: "all" });
    }
  }

  destroy(): void {
    if (this.cacheCleanupStop) {
      this.cacheCleanupStop();
    }
    if (this.localStorageChangeStop) {
      this.localStorageChangeStop();
      this.localStorageChangeStop = undefined;
    }
    this.pendingApiKeyFetches.clear();
  }
}

export default new ReasoningService();
