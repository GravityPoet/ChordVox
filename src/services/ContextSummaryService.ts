import logger from "../utils/logger";
import modelCapabilityResolver from "./ModelCapabilityResolver";
import { buildApiUrl, buildGeminiGenerateContentUrl } from "../config/constants";
import type { ContextCaptureResult } from "../types/electron";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ContextSummaryRequest {
  appName?: string;
  windowTitle?: string;
  visibleText?: string;
  screenshotBase64?: string;
  screenshotMimeType?: "image/png" | "image/jpeg" | "image/webp";
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface ContextSummaryResult {
  summary: string | null;
  visionUsed: boolean;
  visionMs?: number;
  error?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const VISION_TIMEOUT_MS = 5000;
const MAX_SUMMARY_WORDS = 100;
const MAX_VISIBLE_TEXT_CHARS = 1200;

// ─── Vision Prompt ─────────────────────────────────────────────────────────────

const VISION_PROMPT_TEMPLATE = `You are a screen context analyzer for a voice dictation app.

App: {appName}
Window: {windowTitle}
Accessible text:
{visibleText}

Analyze the screenshot and produce a concise context summary.

Rules:
- Focus on what the user is likely doing now.
- Use accessible text as ground truth.
- Extract only context relevant to the user's next dictated text.
- Do not over-describe the screen.
- Do not invent facts.
- Keep the summary under 100 words.`;

// ─── ContextSummaryService ─────────────────────────────────────────────────────

export class ContextSummaryService {
  // ─── Main Entry Point ─────────────────────────────────────────────────────

  async generateSummary(request: ContextSummaryRequest): Promise<ContextSummaryResult> {
    const startTime = Date.now();

    // Check if vision is supported for this provider/model
    const capability = await modelCapabilityResolver.resolveVisionCapability({
      provider: request.provider,
      model: request.model,
      baseUrl: request.baseUrl,
      apiKey: request.apiKey,
      probe: false,
    });

    if (!capability.supported) {
      logger.logReasoning("CONTEXT_SUMMARY_TEXT_ONLY_FALLBACK", {
        provider: request.provider,
        model: request.model,
        error: capability.error,
      });

      return {
        summary: null,
        visionUsed: false,
      };
    }

    // Generate summary using vision
    try {
      const summary = await this.callVisionApi(request);
      const visionMs = Date.now() - startTime;

      logger.logReasoning("CONTEXT_SUMMARY_GENERATED", {
        provider: request.provider,
        model: request.model,
        visionMs,
        summaryLength: summary?.length || 0,
      });

      if (summary) {
        modelCapabilityResolver.rememberVisionCapability({
          provider: request.provider,
          model: request.model,
          baseUrl: request.baseUrl,
        });
      }

      return {
        summary,
        visionUsed: true,
        visionMs,
      };
    } catch (error) {
      const visionMs = Date.now() - startTime;

      logger.logReasoning("CONTEXT_SUMMARY_FAILED", {
        provider: request.provider,
        model: request.model,
        visionMs,
        error: (error as Error).message,
      });

      return {
        summary: null,
        visionUsed: false,
        visionMs,
        error: (error as Error).message,
      };
    }
  }

  // ─── Vision API Calls ─────────────────────────────────────────────────────

  private async callVisionApi(request: ContextSummaryRequest): Promise<string | null> {
    const { provider, model, baseUrl, apiKey, screenshotBase64, screenshotMimeType } = request;

    if (!screenshotBase64) {
      throw new Error("No screenshot provided for vision analysis");
    }

    // Build the prompt with context
    const prompt = this.buildPrompt(request);

    // Call the appropriate vision API
    const response = await this.sendVisionRequest(
      provider,
      model,
      baseUrl,
      apiKey,
      screenshotBase64,
      screenshotMimeType || "image/jpeg",
      prompt,
      request.signal
    );

    // Truncate summary if too long
    if (response) {
      return this.truncateSummary(response);
    }

    return null;
  }

  private buildPrompt(request: ContextSummaryRequest): string {
    const { appName, windowTitle, visibleText } = request;

    // Truncate visible text to save tokens
    const truncatedText = this.truncateVisibleText(visibleText);

    return VISION_PROMPT_TEMPLATE.replace("{appName}", appName || "Unknown")
      .replace("{windowTitle}", windowTitle || "Unknown")
      .replace("{visibleText}", truncatedText || "(No accessible text available)");
  }

  private truncateVisibleText(text?: string): string {
    if (!text) return "";

    if (text.length <= MAX_VISIBLE_TEXT_CHARS) {
      return text;
    }

    // Truncate and add ellipsis
    return text.slice(0, MAX_VISIBLE_TEXT_CHARS) + "...";
  }

  private truncateSummary(summary: string): string {
    const words = summary.split(/\s+/);

    if (words.length <= MAX_SUMMARY_WORDS) {
      return summary;
    }

    return words.slice(0, MAX_SUMMARY_WORDS).join(" ") + "...";
  }

  // ─── Provider-Specific Vision Requests ────────────────────────────────────

  private async sendVisionRequest(
    provider: string,
    model: string,
    baseUrl: string | undefined,
    apiKey: string,
    imageBase64: string,
    mimeType: string,
    prompt: string,
    parentSignal?: AbortSignal
  ): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
    const abortFromParent = () => controller.abort();
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) controller.abort();

    try {
      let endpoint: string;
      let headers: Record<string, string>;
      let body: string;

      switch (provider) {
        case "openai":
        case "openrouter":
        case "custom":
          endpoint = this.getOpenAIEndpoint(provider, baseUrl);
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
                      url: `data:${mimeType};base64,${imageBase64}`,
                    },
                  },
                ],
              },
            ],
            max_tokens: 300,
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
            max_tokens: 300,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: mimeType,
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
                      mime_type: mimeType,
                      data: imageBase64,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: 300,
            },
          });
          break;

        default:
          throw new Error(`Unsupported provider for vision: ${provider}`);
      }

      const data = await this.postJson(endpoint, headers, body, controller.signal);

      return this.extractResponseText(provider, data);
    } finally {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  private async postJson(
    endpoint: string,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal
  ): Promise<any> {
    if (signal.aborted) {
      throw this.createAbortError();
    }

    const proxy =
      typeof window !== "undefined" ? window.electronAPI?.proxyReasoningRequest : undefined;

    if (typeof proxy === "function") {
      const requestId = `context-vision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const cancelOnAbort = this.attachProxyCancelOnAbort(requestId, signal);
      let result: Awaited<ReturnType<typeof proxy>>;
      try {
        result = await proxy({
          requestId,
          url: endpoint,
          method: "POST",
          headers,
          body,
          stream: false,
        });
      } finally {
        cancelOnAbort();
      }

      if (!result?.success) {
        throw new Error(result?.message || result?.error || "Context vision proxy request failed");
      }

      const status = result.status ?? 502;
      const responseBody = result.body || "";
      if (status < 200 || status >= 300) {
        throw new Error(`Vision API error: ${status} ${responseBody.slice(0, 500)}`);
      }

      return JSON.parse(responseBody || "{}");
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Vision API error: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  private createAbortError(): Error {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }

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

  private getOpenAIEndpoint(provider: string, baseUrl?: string): string {
    return buildApiUrl(
      baseUrl ||
        (provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1"),
      "/chat/completions"
    );
  }

  private extractResponseText(provider: string, data: any): string | null {
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
}

// Singleton instance
const contextSummaryService = new ContextSummaryService();

export default contextSummaryService;
