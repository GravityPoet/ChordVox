import { getModelProvider, getCloudModel } from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { SecureCache } from "../utils/SecureCache";
import { withRetry, createApiRetryStrategy } from "../utils/retry";
import {
  API_ENDPOINTS,
  TOKEN_LIMITS,
  buildApiUrl,
  normalizeBaseUrl,
  normalizeEndpointUrl,
} from "../config/constants";
import logger from "../utils/logger";
import { isSecureEndpoint } from "../utils/urlUtils";
import { withSessionRefresh } from "../lib/neonAuth";
import { signRequest } from "../utils/awsSigV4";
import {
  CHORDVOX_CLOUD_MODEL,
  CHORDVOX_CLOUD_PROVIDER,
  isChordVoxCloudMode,
  normalizeChordVoxProvider,
} from "../utils/chordvoxCloud";
import type { LicenseStatusResult } from "../types/electron";

class ReasoningService extends BaseReasoningService {
  private apiKeyCache: SecureCache<string>;
  private openAiEndpointPreference = new Map<string, "responses" | "chat">();
  private proAccessCache: { value: boolean; expiresAt: number; status: LicenseStatusResult | null };
  private static readonly OPENAI_ENDPOINT_PREF_STORAGE_KEY = "openAiEndpointPreference";
  private static readonly CUSTOM_REASONING_PROTOCOL_STORAGE_KEY = "customReasoningProtocol";
  private static readonly OPENAI_ENDPOINT_PREF_EVENT = "openai-endpoint-preference-changed";
  private static readonly OPENROUTER_BASE = "https://openrouter.ai/api/v1";
  private static readonly PRO_ACCESS_CACHE_TTL_MS = 5000;
  private static readonly REASONING_WARMUP_TTL_MS = 45000;
  private cacheCleanupStop: (() => void) | undefined;
  private processingQueue: Promise<void> = Promise.resolve();
  private reasoningWarmupPromise: Promise<boolean> | null = null;
  private reasoningWarmupExpiresAt = 0;

  constructor() {
    super();
    this.apiKeyCache = new SecureCache();
    this.proAccessCache = { value: true, expiresAt: 0, status: null };
    this.cacheCleanupStop = this.apiKeyCache.startAutoCleanup();

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.destroy());
    }
  }

  private emitOpenAiPreferenceChanged(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event(ReasoningService.OPENAI_ENDPOINT_PREF_EVENT));
  }

  private getCustomReasoningProtocol(): "auto" | "chat" | "responses" {
    if (typeof window === "undefined" || !window.localStorage) {
      return "auto";
    }
    const raw = window.localStorage.getItem(ReasoningService.CUSTOM_REASONING_PROTOCOL_STORAGE_KEY);
    return raw === "chat" || raw === "responses" ? raw : "auto";
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
    if (config.promptMode !== "fast-cleanup") {
      return config;
    }

    return {
      ...config,
      disableThinking: config.disableThinking ?? true,
      temperature: config.temperature ?? 0.1,
      maxTokens: config.maxTokens ?? this.getFastCleanupMaxTokens(text),
      providerOverride: config.providerOverride ?? provider ?? getModelProvider(model),
    };
  }

  private getResolvedSystemPrompt(
    agentName: string | null,
    transcript: string,
    config: ReasoningConfig = {}
  ): string {
    return this.getSystemPrompt(agentName, transcript, config.promptMode || "default");
  }

  private supportsGroqReasoningEffort(model: string): boolean {
    const normalized = String(model || "").trim().toLowerCase();
    return normalized.startsWith("qwen/qwen3");
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

    if (
      !window.electronAPI?.licenseEnsureProAccess &&
      !window.electronAPI?.licenseGetStatus
    ) {
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

  private async parseOpenAiErrorResponse(
    response: Response
  ): Promise<{ payload: unknown; message: string; rawText: string }> {
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
        return normalizeBaseUrl(value.trim()) || null;
      }
    } catch { /* ignore */ }
    return null;
  }

  private normalizeProviderOverride(providerOverride?: string | null): string {
    return normalizeChordVoxProvider(providerOverride);
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

  private getOpenAIEndpointCandidates(
    base: string,
    protocolMode: "auto" | "chat" | "responses" = "auto"
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

    const candidates: Array<{ url: string; type: "responses" | "chat" }> = [
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
    } catch { }
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
    } catch { }
  }

  private async getApiKey(
    provider: "openai" | "openrouter" | "anthropic" | "gemini" | "groq" | "bedrock" | "custom"
  ): Promise<string> {
    if (provider === "custom") {
      let customKey = "";
      try {
        customKey = (await window.electronAPI?.getCustomReasoningKey?.()) || "";
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
        keyLength: trimmedKey.length,
        keyPreview: trimmedKey ? `${trimmedKey.substring(0, 8)}...` : "none",
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

    let apiKey = this.apiKeyCache.get(provider);

    logger.logReasoning(`${provider.toUpperCase()}_KEY_RETRIEVAL`, {
      provider,
      fromCache: !!apiKey,
      cacheSize: this.apiKeyCache.size || 0,
    });

    if (!apiKey) {
      try {
        const keyGetters = {
          openai: () => window.electronAPI.getOpenAIKey(),
          openrouter: () => window.electronAPI.getOpenRouterKey(),
          anthropic: () => window.electronAPI.getAnthropicKey(),
          gemini: () => window.electronAPI.getGeminiKey(),
          groq: () => window.electronAPI.getGroqKey(),
        };
        apiKey = (await keyGetters[provider]()) ?? undefined;

        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCHED`, {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
          keyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : "none",
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
      };
      const lsKey = localStorageKeys[provider];
      if (lsKey) {
        const lsValue = (window.localStorage.getItem(lsKey) || "").trim();
        if (lsValue) {
          logger.logReasoning(`${provider.toUpperCase()}_KEY_LOCALSTORAGE_FALLBACK`, {
            provider,
            hasKey: true,
            keyLength: lsValue.length,
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

    // Disable thinking for providers we know accept the Groq-compatible flag.
    const modelDef = getCloudModel(model);
    if (
      providerName.toLowerCase() === "groq" &&
      this.supportsGroqReasoningEffort(model) &&
      (config.disableThinking || modelDef?.disableThinking)
    ) {
      requestBody.reasoning_effort = "none";
    }

    logger.logReasoning(`${providerName.toUpperCase()}_REQUEST`, {
      endpoint,
      model,
      hasApiKey: !!apiKey,
      requestBody: JSON.stringify(requestBody).substring(0, 200),
    });

    const response = await withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
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
          throw new Error(errorMessage);
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
        if ((error as Error).name === "AbortError") {
          throw new Error("Request timed out after 30s");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
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

  async processText(
    text: string,
    model: string = "",
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    const trimmedModel = model?.trim?.() || "";
    if (!trimmedModel) {
      throw new Error("No reasoning model selected");
    }
    const providerOverride = this.normalizeProviderOverride(config.providerOverride);
    const provider =
      providerOverride && providerOverride !== "auto"
        ? providerOverride
        : getModelProvider(trimmedModel);
    const effectiveConfig = this.getEffectiveConfig(text, trimmedModel, provider, config);
    const proAccess = await this.getProAccessState();

    if (!proAccess.allowed) {
      throw this.createProRequiredError(proAccess.status);
    }

    logger.logReasoning("PROVIDER_SELECTION", {
      model: trimmedModel,
      provider,
      providerOverride: providerOverride || null,
      promptMode: effectiveConfig.promptMode || "default",
      disableThinking: effectiveConfig.disableThinking ?? false,
      agentName,
      hasConfig: Object.keys(config).length > 0,
      textLength: text.length,
      timestamp: new Date().toISOString(),
    });

    const previousQueue = this.processingQueue;
    let releaseQueue: (() => void) | null = null;
    this.processingQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    try {
      await previousQueue.catch(() => undefined);
      this.isProcessing = true;

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
        case CHORDVOX_CLOUD_PROVIDER:
          result = await this.processWithChordVoxCloud(
            text,
            model,
            agentName,
            effectiveConfig
          );
          break;
        case "bedrock":
          result = await this.processWithBedrock(text, trimmedModel, agentName, effectiveConfig);
          break;
        default:
          throw new Error(`Unsupported reasoning provider: ${provider}`);
      }

      const processingTime = Date.now() - startTime;

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
      this.isProcessing = false;
      releaseQueue?.();
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

    logger.logReasoning("OPENAI_START", {
      model,
      agentName,
      provider: effectiveProvider,
      providerOverride: providerOverride || null,
      isCustomProvider,
      hasApiKey: false, // Will update after fetching
    });

    const apiKey = await this.getApiKey(effectiveProvider);

    logger.logReasoning("OPENAI_API_KEY", {
      hasApiKey: !!apiKey,
      keyLength: apiKey?.length || 0,
    });

    try {
      const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
      const userPrompt = text;

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      const isOlderModel = model && (model.startsWith("gpt-4") || model.startsWith("gpt-3"));

      const openAiBase = this.getConfiguredOpenAIBase(effectiveProvider);
      const protocolMode = effectiveProvider === "custom" ? this.getCustomReasoningProtocol() : "auto";
      const endpointCandidates = this.getOpenAIEndpointCandidates(openAiBase, protocolMode);
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
          apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : "(none)",
        });
      }

      const response = await withRetry(async () => {
        let lastError: Error | null = null;

        for (const { url: endpoint, type } of endpointCandidates) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          try {
            const requestBody: Record<string, unknown> = { model };

            if (type === "responses") {
              requestBody.input = messages;
              requestBody.store = false;
            } else {
              requestBody.messages = messages;
              if (effectiveProvider === "custom") {
                requestBody.stream = false;
              }
              if (typeof config.maxTokens === "number") {
                requestBody.max_tokens = config.maxTokens;
              }
              if (isOlderModel || typeof config.temperature === "number") {
                requestBody.temperature = config.temperature ?? 0.3;
              }
            }

            const performRequest = (body: Record<string, unknown>) =>
              fetch(endpoint, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
              });

            let res = await performRequest(requestBody);

            if (!res.ok) {
              let parsedError = await this.parseOpenAiErrorResponse(res);

              if (
                this.shouldRetryCustomChatWithoutStream(
                  effectiveProvider,
                  type,
                  res.status,
                  parsedError.payload,
                  parsedError.rawText,
                  requestBody
                )
              ) {
                const retryBody = { ...requestBody };
                delete retryBody.stream;

                logger.logReasoning("OPENAI_CHAT_STREAM_FALLBACK", {
                  endpoint,
                  provider: effectiveProvider,
                  status: res.status,
                  reason: parsedError.message,
                });

                res = await performRequest(retryBody);
                if (res.ok) {
                  this.rememberOpenAiPreference(openAiBase, type);
                  return res.json();
                }
                parsedError = await this.parseOpenAiErrorResponse(res);
              }

              const errorMessage = parsedError.message;

              const isUnsupportedEndpoint =
                (res.status === 404 || res.status === 405) && type === "responses";

              if (isUnsupportedEndpoint) {
                lastError = new Error(errorMessage);
                this.rememberOpenAiPreference(openAiBase, "chat");
                logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                  attemptedEndpoint: endpoint,
                  error: errorMessage,
                });
                continue;
              }

              throw new Error(errorMessage);
            }

            this.rememberOpenAiPreference(openAiBase, type);
            return res.json();
          } catch (error) {
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
            clearTimeout(timeoutId);
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
        success: true,
        isEmpty: responseText.length === 0,
      });

      if (!responseText) {
        logger.logReasoning("OPENAI_EMPTY_RESPONSE_FALLBACK", {
          model,
          originalTextLength: text.length,
          reason: "Empty response from API",
        });
        return text;
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
      const result = await window.electronAPI.processAnthropicReasoning(text, model, agentName, {
        ...config,
        systemPrompt,
      });

      const processingTime = Date.now() - startTime;

      if (result.success) {
        logger.logReasoning("ANTHROPIC_SUCCESS", {
          model,
          processingTimeMs: processingTime,
          resultLength: result.text.length,
        });
        return result.text;
      } else {
        logger.logReasoning("ANTHROPIC_ERROR", {
          model,
          processingTimeMs: processingTime,
          error: result.error,
        });
        throw new Error(result.error);
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
      const result = await window.electronAPI.processLocalReasoning(text, model, agentName, {
        ...config,
        systemPrompt,
      });

      const processingTime = Date.now() - startTime;

      if (result.success) {
        logger.logReasoning("LOCAL_SUCCESS", {
          model,
          processingTimeMs: processingTime,
          resultLength: result.text.length,
        });
        return result.text;
      } else {
        logger.logReasoning("LOCAL_ERROR", {
          model,
          processingTimeMs: processingTime,
          error: result.error,
        });
        throw new Error(result.error);
      }
    } else {
      logger.logReasoning("LOCAL_UNAVAILABLE", {
        reason: "Not in Electron environment",
      });
      throw new Error("Local reasoning is not available in this environment");
    }
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

    const apiKey = await this.getApiKey("gemini");

    logger.logReasoning("GEMINI_API_KEY", {
      hasApiKey: !!apiKey,
      keyLength: apiKey?.length || 0,
    });

    try {
      const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
      const userPrompt = text;

      const requestBody = {
        contents: [
          {
            parts: [
              {
                text: `${systemPrompt}\n\n${userPrompt}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: config.temperature || 0.3,
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
        },
      };

      let response: any;
      try {
        response = await withRetry(async () => {
          const geminiBase = this.getProviderEndpointOverride("gemini") || API_ENDPOINTS.GEMINI;
          logger.logReasoning("GEMINI_REQUEST", {
            endpoint: `${geminiBase}/models/${model}:generateContent`,
            model,
            hasApiKey: !!apiKey,
            requestBody: JSON.stringify(requestBody).substring(0, 200),
          });

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          try {
            const res = await fetch(`${geminiBase}/models/${model}:generateContent`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });

            if (!res.ok) {
              const errorText = await res.text();
              let errorData: any = { error: res.statusText };

              try {
                errorData = JSON.parse(errorText);
              } catch {
                errorData = { error: errorText || res.statusText };
              }

              logger.logReasoning("GEMINI_API_ERROR_DETAIL", {
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
                `Gemini API error: ${res.status}`;
              throw new Error(errorMessage);
            }

            const jsonResponse = await res.json();

            logger.logReasoning("GEMINI_RAW_RESPONSE", {
              hasResponse: !!jsonResponse,
              responseKeys: jsonResponse ? Object.keys(jsonResponse) : [],
              hasCandidates: !!jsonResponse?.candidates,
              candidatesLength: jsonResponse?.candidates?.length || 0,
              fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
            });

            return jsonResponse;
          } catch (error) {
            if ((error as Error).name === "AbortError") {
              throw new Error("Request timed out after 30s");
            }
            throw error;
          } finally {
            clearTimeout(timeoutId);
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
      if (!candidate.content?.parts?.[0]?.text) {
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

      const responseText = candidate.content.parts[0].text.trim();

      logger.logReasoning("GEMINI_RESPONSE", {
        model,
        responseLength: responseText.length,
        tokensUsed: response.usageMetadata?.totalTokenCount || 0,
        success: true,
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
    const sessionToken = (window.localStorage?.getItem("bedrockSessionToken") || "").trim() || undefined;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error("AWS Bedrock credentials not configured");
    }

    try {
      const systemPrompt = this.getResolvedSystemPrompt(agentName, text, config);
      const userPrompt = text;

      const bedrockBase = this.getProviderEndpointOverride("bedrock") ||
        `https://bedrock-runtime.${region}.amazonaws.com`;
      const endpoint = `${bedrockBase}/model/${model}/converse`;

      const requestBody = JSON.stringify({
        system: [{ text: systemPrompt }],
        messages: [
          { role: "user", content: [{ text: userPrompt }] },
        ],
        inferenceConfig: {
          temperature: config.temperature ?? 0.3,
          maxTokens: config.maxTokens || Math.max(
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        try {
          const res = await fetch(signed.url, {
            method: "POST",
            headers: signed.headers,
            body: requestBody,
            signal: controller.signal,
          });

          if (!res.ok) {
            const errorText = await res.text();
            let errorData: any = { error: res.statusText };
            try { errorData = JSON.parse(errorText); } catch { errorData = { error: errorText || res.statusText }; }
            const errorMessage = errorData.message || errorData.error?.message || errorData.error || `Bedrock API error: ${res.status}`;
            throw new Error(errorMessage);
          }

          return await res.json();
        } catch (error) {
          if ((error as Error).name === "AbortError") {
            throw new Error("Bedrock request timed out after 60s");
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
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
    logger.logReasoning("CHORDVOX_CLOUD_START", { model, agentName });

    try {
      const customDictionary = this.getCustomDictionary();
      const language = this.getPreferredLanguage();
      const locale = this.getUiLanguage();

      // Use withSessionRefresh to handle AUTH_EXPIRED automatically
      const result = await withSessionRefresh(async () => {
        const res = await (window as any).electronAPI.cloudReason(text, {
          model,
          agentName,
          customDictionary,
          customPrompt: this.getEffectiveCloudPrompt(agentName, text, config),
          language,
          locale,
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

    const cloudReasoningMode = String(
      window.localStorage?.getItem("cloudReasoningMode") || "byok"
    )
      .trim()
      .toLowerCase();
    const isSignedIn = window.localStorage?.getItem("isSignedIn") === "true";

    if (isSignedIn && isChordVoxCloudMode(cloudReasoningMode)) {
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
      const enabled = enabledRaw === "true" || (!!enabledRaw && enabledRaw !== "false");
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
        case "gemini":
        case "groq":
        case "bedrock":
          await this.getApiKey(provider as "anthropic" | "gemini" | "groq" | "bedrock");
          break;
        case "custom":
          await this.getApiKey("custom");
          this.getConfiguredOpenAIBase("custom");
          break;
        case "local":
          await window.electronAPI?.checkLocalReasoningAvailable?.();
          break;
        case CHORDVOX_CLOUD_PROVIDER:
          if (window.electronAPI?.cloudUsage) {
            await withSessionRefresh(async () => {
              const res = await window.electronAPI.cloudUsage();
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

  async isAvailable(provider?: string): Promise<boolean> {
    try {
      const proAccess = await this.getProAccessState();
      if (!proAccess.allowed) {
        return false;
      }

      const getKeyWithFallback = async (
        ipcGetter: (() => Promise<string | null | undefined>) | undefined,
        localStorageKey: string
      ): Promise<string> => {
        let key = "";
        try {
          key = (await ipcGetter?.()) || "";
        } catch { /* ignore IPC errors */ }
        if (!key && typeof window !== "undefined" && window.localStorage) {
          key = window.localStorage.getItem(localStorageKey) || "";
        }
        return key.trim();
      };

      const openaiKey = await getKeyWithFallback(window.electronAPI?.getOpenAIKey, "openaiApiKey");
      const openrouterKey = await getKeyWithFallback(window.electronAPI?.getOpenRouterKey, "openrouterApiKey");
      const anthropicKey = await getKeyWithFallback(window.electronAPI?.getAnthropicKey, "anthropicApiKey");
      const geminiKey = await getKeyWithFallback(window.electronAPI?.getGeminiKey, "geminiApiKey");
      const groqKey = await getKeyWithFallback(window.electronAPI?.getGroqKey, "groqApiKey");
      const customReasoningKey = await getKeyWithFallback(window.electronAPI?.getCustomReasoningKey, "customReasoningApiKey");
      const bedrockAccessKey = (window.localStorage?.getItem("bedrockAccessKeyId") || "").trim();
      const bedrockSecretKey = (window.localStorage?.getItem("bedrockSecretAccessKey") || "").trim();
      const localAvailable = await window.electronAPI?.checkLocalReasoningAvailable?.();
      const configuredProvider = String(
        provider || window.localStorage?.getItem("reasoningProvider") || "auto"
      )
        .trim()
        .toLowerCase();
      const customEndpoint = (window.localStorage?.getItem("cloudReasoningBaseUrl") || "").trim();

      logger.logReasoning("API_KEY_CHECK", {
        provider: configuredProvider,
        hasOpenAI: !!openaiKey,
        hasOpenRouter: !!openrouterKey,
        hasAnthropic: !!anthropicKey,
        hasGemini: !!geminiKey,
        hasGroq: !!groqKey,
        hasCustomReasoningKey: !!customReasoningKey,
        hasCustomEndpoint: !!customEndpoint,
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
          return !!geminiKey;
        case "groq":
          return !!groqKey;
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
          return !!(openaiKey || openrouterKey || anthropicKey || geminiKey || groqKey || localAvailable || customEndpoint);
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
    provider?: "openai" | "openrouter" | "anthropic" | "gemini" | "groq" | "mistral" | "custom"
  ): void {
    if (provider) {
      if (provider !== "custom") {
        this.apiKeyCache.delete(provider);
      }
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider });
    } else {
      this.apiKeyCache.clear();
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider: "all" });
    }
  }

  destroy(): void {
    if (this.cacheCleanupStop) {
      this.cacheCleanupStop();
    }
  }
}

export default new ReasoningService();
