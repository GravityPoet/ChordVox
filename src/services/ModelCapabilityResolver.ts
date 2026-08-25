import logger from "../utils/logger";
import { SecureCache } from "../utils/SecureCache";
import {
  buildApiUrl,
  buildGeminiGenerateContentUrl,
  getEndpointBaseUrl,
} from "../config/constants";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface VisionCapabilityResult {
  supported: boolean;
  provider: string;
  model: string;
  testedAt?: string;
  expiresAt?: string;
  error?: string;
}

interface CapabilityCacheEntry {
  supported: boolean;
  testedAt: number;
  expiresAt: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PROBE_TIMEOUT_MS = 5000;
const OPENROUTER_MODELS_CACHE_KEY = "openrouter-vision-models";
const CAPABILITY_CACHE_KEY_PREFIX = "vision-capability:";

// Known vision-capable model patterns
const OPENAI_VISION_PATTERNS = [
  /^gpt-4o/i,
  /^gpt-4-turbo/i,
  /^gpt-4-vision/i,
  /^gpt-5/i,
  /^o1/i,
  /^o3/i,
];

const ANTHROPIC_VISION_PATTERNS = [/^claude-3/i, /^claude-3\.5/i, /^claude-4/i];

const GEMINI_VISION_PATTERNS = [/^gemini-1\.5/i, /^gemini-2/i, /^gemini-2\.5/i, /^gemini-3/i];

const OPENROUTER_VISION_PATTERNS = [
  /^openai\/gpt-4o/i,
  /^openai\/gpt-4-turbo/i,
  /^openai\/gpt-5/i,
  /^anthropic\/claude-3/i,
  /^anthropic\/claude-4/i,
  /^google\/gemini-1\.5/i,
  /^google\/gemini-2/i,
  /^google\/gemini-3/i,
  /^meta-llama\/llama-4-scout/i,
];

const CUSTOM_VISION_PATTERNS = [
  ...OPENAI_VISION_PATTERNS,
  ...ANTHROPIC_VISION_PATTERNS,
  ...GEMINI_VISION_PATTERNS,
];

// ─── ModelCapabilityResolver ───────────────────────────────────────────────────

interface OpenRouterModelData {
  id: string;
  architecture?: {
    input_modalities?: string[];
  };
  [key: string]: any;
}

export class ModelCapabilityResolver {
  private capabilityCache: SecureCache<CapabilityCacheEntry>;
  private openRouterModelsCache: {
    models: Map<string, OpenRouterModelData>;
    expiresAt: number;
  } | null = null;

  constructor() {
    this.capabilityCache = new SecureCache();
  }

  // ─── Main Entry Point ─────────────────────────────────────────────────────

  async resolveVisionCapability(options: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
    probe?: boolean;
  }): Promise<VisionCapabilityResult> {
    const { provider, model, baseUrl, apiKey, probe = true } = options;
    const normalizedProvider = provider.toLowerCase().trim();
    const normalizedModel = model.toLowerCase().trim();
    const cacheKey = this.getCacheKey(normalizedProvider, normalizedModel, baseUrl);

    // A successful live test remains valid for seven days. This must happen
    // before the main-process probe or every dictation pays for another test.
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return {
        supported: cached.supported,
        provider: normalizedProvider,
        model: normalizedModel,
        testedAt: new Date(cached.testedAt).toISOString(),
        expiresAt: new Date(cached.expiresAt).toISOString(),
      };
    }

    // Context generation is itself the definitive vision request. Use static
    // capability knowledge there so the first dictation never makes a separate
    // paid probe immediately before the real screenshot summary.
    if (!probe) {
      return this.resolveKnownCapability(normalizedProvider, normalizedModel);
    }

    const mainProcessProbe =
      typeof window !== "undefined" ? window.electronAPI?.testVisionCapability : undefined;
    if (typeof mainProcessProbe === "function") {
      try {
        const result = await mainProcessProbe({
          provider: normalizedProvider,
          model: normalizedModel,
          baseUrl,
          apiKey,
        });
        if (this.shouldCacheResult(normalizedProvider, result)) {
          this.setInCache(cacheKey, result.supported);
        }
        return result;
      } catch (error) {
        logger.warn("Main-process vision probe failed; falling back to renderer resolver", {
          error: (error as Error).message,
        });
      }
    }

    // Resolve based on provider
    let result: VisionCapabilityResult;

    switch (normalizedProvider) {
      case "openrouter":
        result = await this.resolveOpenRouter(normalizedModel, baseUrl, apiKey);
        break;
      case "openai":
        result = await this.resolveOpenAI(normalizedModel, baseUrl, apiKey);
        break;
      case "anthropic":
        result = await this.resolveAnthropic(normalizedModel, apiKey);
        break;
      case "gemini":
        result = await this.resolveGemini(normalizedModel, baseUrl, apiKey);
        break;
      case "groq":
        result = this.resolveGroq(normalizedModel);
        break;
      case "custom":
        result = await this.resolveCustom(normalizedModel, baseUrl, apiKey);
        break;
      case "local":
        result = this.resolveLocal(normalizedModel);
        break;
      default:
        result = {
          supported: false,
          provider: normalizedProvider,
          model: normalizedModel,
          error: "Unknown provider",
        };
    }

    if (this.shouldCacheResult(normalizedProvider, result)) {
      this.setInCache(cacheKey, result.supported);
    }

    logger.logReasoning("VISION_CAPABILITY_RESOLVED", {
      provider: normalizedProvider,
      model: normalizedModel,
      supported: result.supported,
      error: result.error,
    });

    return result;
  }

  rememberVisionCapability(options: { provider: string; model: string; baseUrl?: string }): void {
    const provider = options.provider.toLowerCase().trim();
    const model = options.model.toLowerCase().trim();
    if (!provider || !model) return;
    this.setInCache(this.getCacheKey(provider, model, options.baseUrl), true);
  }

  private resolveKnownCapability(provider: string, model: string): VisionCapabilityResult {
    let supported = false;
    switch (provider) {
      case "openai":
        supported = this.matchesVisionPattern(model, OPENAI_VISION_PATTERNS);
        break;
      case "openrouter":
        supported = this.matchesVisionPattern(model, OPENROUTER_VISION_PATTERNS);
        break;
      case "anthropic":
        supported = this.matchesVisionPattern(model, ANTHROPIC_VISION_PATTERNS);
        break;
      case "gemini":
        supported = this.matchesVisionPattern(model, GEMINI_VISION_PATTERNS);
        break;
      case "custom":
        supported = this.matchesVisionPattern(model, CUSTOM_VISION_PATTERNS);
        break;
      default:
        supported = false;
    }
    return {
      supported,
      provider,
      model,
      error: supported
        ? "Known vision model; live probe skipped for context generation"
        : "Model does not match known vision patterns",
    };
  }

  // ─── Provider-Specific Resolvers ──────────────────────────────────────────

  private async resolveOpenRouter(
    model: string,
    baseUrl?: string,
    apiKey?: string
  ): Promise<VisionCapabilityResult> {
    const result: VisionCapabilityResult = {
      supported: false,
      provider: "openrouter",
      model,
    };

    const normalizedBaseUrl = getEndpointBaseUrl(baseUrl);
    if (normalizedBaseUrl && normalizedBaseUrl !== "https://openrouter.ai/api/v1") {
      if (!apiKey) {
        result.error = "OpenRouter-compatible override requires API key for capability probe";
        return result;
      }
      const probeResult = await this.probeVisionCapability(
        "openrouter",
        model,
        normalizedBaseUrl,
        apiKey
      );
      result.supported = probeResult;
      result.testedAt = new Date().toISOString();
      result.expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
      return result;
    }

    try {
      // Fetch model metadata from OpenRouter
      const models = await this.fetchOpenRouterModels(apiKey);
      const modelData = models.get(model);

      if (modelData) {
        // Check input_modalities for image support
        const inputModalities = modelData.architecture?.input_modalities || [];
        result.supported = inputModalities.includes("image");
        result.testedAt = new Date().toISOString();
        result.expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
      } else {
        // Model not found in metadata, try pattern matching
        result.supported = this.matchesVisionPattern(model, OPENAI_VISION_PATTERNS);
        result.error = "Model not found in OpenRouter metadata, using pattern matching";
      }
    } catch (error) {
      // Fallback to pattern matching
      result.supported = this.matchesVisionPattern(model, OPENAI_VISION_PATTERNS);
      result.error = `OpenRouter metadata fetch failed: ${(error as Error).message}`;
    }

    return result;
  }

  private async fetchOpenRouterModels(apiKey?: string): Promise<Map<string, any>> {
    const now = Date.now();

    // Check in-memory cache
    if (this.openRouterModelsCache && now < this.openRouterModelsCache.expiresAt) {
      return this.openRouterModelsCache.models;
    }

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch("https://openrouter.ai/api/v1/models", {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status}`);
      }

      const data = await response.json();
      const models = new Map<string, any>();

      if (Array.isArray(data.data)) {
        for (const model of data.data) {
          if (model.id) {
            models.set(model.id.toLowerCase(), model);
          }
        }
      }

      // Cache for 1 hour
      this.openRouterModelsCache = {
        models,
        expiresAt: now + 60 * 60 * 1000,
      };

      return models;
    } catch (error) {
      logger.warn("Failed to fetch OpenRouter models", {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  private async resolveOpenAI(
    model: string,
    baseUrl?: string,
    apiKey?: string
  ): Promise<VisionCapabilityResult> {
    const result: VisionCapabilityResult = {
      supported: false,
      provider: "openai",
      model,
    };

    // Pattern matching first
    const patternMatch = this.matchesVisionPattern(model, OPENAI_VISION_PATTERNS);
    if (!patternMatch) {
      result.error = "Model does not match known vision patterns";
      return result;
    }

    // Probe if we have credentials
    if (apiKey) {
      try {
        const probeResult = await this.probeVisionCapability("openai", model, baseUrl, apiKey);
        result.supported = probeResult;
        result.testedAt = new Date().toISOString();
        result.expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
      } catch (error) {
        result.supported = true; // Assume supported based on pattern match
        result.error = `Probe failed, assuming supported: ${(error as Error).message}`;
      }
    } else {
      // No credentials, trust pattern matching
      result.supported = true;
      result.error = "No API key provided, trusting pattern matching";
    }

    return result;
  }

  private async resolveAnthropic(model: string, apiKey?: string): Promise<VisionCapabilityResult> {
    const result: VisionCapabilityResult = {
      supported: false,
      provider: "anthropic",
      model,
    };

    // Pattern matching first
    const patternMatch = this.matchesVisionPattern(model, ANTHROPIC_VISION_PATTERNS);
    if (!patternMatch) {
      result.error = "Model does not match known vision patterns";
      return result;
    }

    // Probe if we have credentials
    if (apiKey) {
      try {
        const probeResult = await this.probeVisionCapability("anthropic", model, undefined, apiKey);
        result.supported = probeResult;
        result.testedAt = new Date().toISOString();
        result.expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
      } catch (error) {
        result.supported = true; // Assume supported based on pattern match
        result.error = `Probe failed, assuming supported: ${(error as Error).message}`;
      }
    } else {
      // No credentials, trust pattern matching
      result.supported = true;
      result.error = "No API key provided, trusting pattern matching";
    }

    return result;
  }

  private async resolveGemini(
    model: string,
    baseUrl?: string,
    apiKey?: string
  ): Promise<VisionCapabilityResult> {
    const result: VisionCapabilityResult = {
      supported: false,
      provider: "gemini",
      model,
    };

    // Pattern matching first
    const patternMatch = this.matchesVisionPattern(model, GEMINI_VISION_PATTERNS);
    if (!patternMatch) {
      result.error = "Model does not match known vision patterns";
      return result;
    }

    // Probe if we have credentials
    if (apiKey) {
      try {
        const probeResult = await this.probeVisionCapability("gemini", model, baseUrl, apiKey);
        result.supported = probeResult;
        result.testedAt = new Date().toISOString();
        result.expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
      } catch (error) {
        result.supported = true; // Assume supported based on pattern match
        result.error = `Probe failed, assuming supported: ${(error as Error).message}`;
      }
    } else {
      // No credentials, trust pattern matching
      result.supported = true;
      result.error = "No API key provided, trusting pattern matching";
    }

    return result;
  }

  private resolveGroq(model: string): VisionCapabilityResult {
    // Groq does not support vision as of first version
    return {
      supported: false,
      provider: "groq",
      model,
      error: "Groq does not support vision input",
    };
  }

  private async resolveCustom(
    model: string,
    baseUrl?: string,
    apiKey?: string
  ): Promise<VisionCapabilityResult> {
    const result: VisionCapabilityResult = {
      supported: false,
      provider: "custom",
      model,
    };

    const patternMatch = this.matchesVisionPattern(model, CUSTOM_VISION_PATTERNS);

    // Custom providers need explicit probing
    if (apiKey && baseUrl) {
      try {
        const probeResult = await this.probeVisionCapability("custom", model, baseUrl, apiKey);
        result.supported = probeResult;
        result.testedAt = new Date().toISOString();
        result.expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
      } catch (error) {
        result.supported = patternMatch;
        result.error = patternMatch
          ? `Probe failed, using known vision model match: ${(error as Error).message}`
          : `Probe failed: ${(error as Error).message}`;
      }
    } else {
      result.supported = patternMatch;
      result.error = patternMatch
        ? "Custom provider probe incomplete, using known vision model match"
        : "Custom provider requires API key and base URL for capability detection";
    }

    return result;
  }

  private resolveLocal(model: string): VisionCapabilityResult {
    // Local models default to unsupported for first version
    return {
      supported: false,
      provider: "local",
      model,
      error: "Local models do not support vision input in first version",
    };
  }

  // ─── Vision Probing ───────────────────────────────────────────────────────

  private async probeVisionCapability(
    provider: string,
    model: string,
    baseUrl?: string,
    apiKey?: string
  ): Promise<boolean> {
    // Generate a tiny test image (64x64 red pixel)
    const testImageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

    const testPrompt = "What color is this image? Reply with just the color name.";

    const response = await this.sendVisionRequest(
      provider,
      model,
      baseUrl,
      apiKey,
      testImageBase64,
      testPrompt
    );
    if (!response) {
      throw new Error("Vision probe returned empty response");
    }
    return true;
  }

  private async sendVisionRequest(
    provider: string,
    model: string,
    baseUrl: string | undefined,
    apiKey: string | undefined,
    imageBase64: string,
    prompt: string
  ): Promise<string | null> {
    if (!apiKey) {
      throw new Error("API key required for vision probe");
    }

    let endpoint: string;
    let headers: Record<string, string>;
    let body: string;

    switch (provider) {
      case "openai":
      case "openrouter":
      case "custom":
        endpoint = buildApiUrl(
          baseUrl ||
            (provider === "openrouter"
              ? "https://openrouter.ai/api/v1"
              : "https://api.openai.com/v1"),
          "/chat/completions"
        );
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        };
        body = JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${imageBase64}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 50,
        });
        break;

      case "anthropic":
        endpoint = "https://api.anthropic.com/v1/messages";
        headers = {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        };
        body = JSON.stringify({
          model,
          max_tokens: 50,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: imageBase64,
                  },
                },
              ],
            },
          ],
        });
        break;

      case "gemini":
        endpoint = buildGeminiGenerateContentUrl(
          baseUrl || "https://generativelanguage.googleapis.com",
          model
        );
        headers = {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        };
        body = JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: "image/png",
                    data: imageBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 50,
          },
        });
        break;

      default:
        throw new Error(`Unsupported provider for vision probe: ${provider}`);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Vision probe failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    // Extract response text based on provider
    switch (provider) {
      case "openai":
      case "openrouter":
      case "custom":
        return data.choices?.[0]?.message?.content || null;
      case "anthropic":
        return data.content?.[0]?.text || null;
      case "gemini":
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
      default:
        return null;
    }
  }

  // ─── Pattern Matching ─────────────────────────────────────────────────────

  private matchesVisionPattern(model: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(model));
  }

  // ─── Cache Management ─────────────────────────────────────────────────────

  private getCacheKey(provider: string, model: string, baseUrl?: string): string {
    const baseKey = `${CAPABILITY_CACHE_KEY_PREFIX}${provider}:${model}`;
    // Include baseUrl in cache key for BYOK endpoints
    if (baseUrl) {
      const normalizedBase = getEndpointBaseUrl(baseUrl).toLowerCase();
      if (normalizedBase) {
        return `${baseKey}:${normalizedBase}`;
      }
    }
    return baseKey;
  }

  private getFromCache(key: string): CapabilityCacheEntry | null {
    const cached = this.capabilityCache.get(key);
    if (!cached) return null;

    const now = Date.now();
    if (now >= cached.expiresAt) {
      this.capabilityCache.delete(key);
      return null;
    }

    return cached;
  }

  private setInCache(key: string, supported: boolean): void {
    const now = Date.now();
    this.capabilityCache.set(key, {
      supported,
      testedAt: now,
      expiresAt: now + CACHE_TTL_MS,
    });
  }

  private shouldCacheResult(provider: string, result: VisionCapabilityResult): boolean {
    if (result.supported || !result.error) {
      return true;
    }

    if (provider === "groq" || provider === "local") {
      return true;
    }

    return result.error === "Model does not match known vision patterns";
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  clearCache(): void {
    this.capabilityCache.clear();
    this.openRouterModelsCache = null;
  }

  clearCacheForProvider(provider: string): void {
    // Clear all cache entries for a specific provider
    const prefix = `${CAPABILITY_CACHE_KEY_PREFIX}${provider}:`;
    // Note: SecureCache doesn't have a prefix-based delete, so we clear all
    this.capabilityCache.clear();
  }
}

// Singleton instance
const modelCapabilityResolver = new ModelCapabilityResolver();

export default modelCapabilityResolver;
export type { CapabilityCacheEntry };
