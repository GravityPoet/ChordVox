import { getSystemPrompt, type PromptMode } from "../config/prompts";

export interface ReasoningConfig {
  maxTokens?: number;
  temperature?: number;
  contextSize?: number;
  /**
   * One-request prompt override used by Prompt Studio. It must never be
   * persisted as the production prompt just to run a test.
   */
  systemPromptOverride?: string;
  /**
   * Cancels the provider request and suppresses any later progress updates.
   */
  signal?: AbortSignal;
  providerOverride?: string;
  promptMode?: PromptMode;
  /** Legacy override: true forces the internal fast-cleanup policy. */
  disableThinking?: boolean;
  allowProPreview?: boolean;
  /**
   * Optional incremental progress callback for SSE streaming providers
   * (OpenAI Responses / Gemini / Groq). Called with the accumulated polish
   * text as new tokens arrive. Throttled to ~30fps in callee. Absence keeps
   * the existing non-stream code path.
   */
  onProgress?: (partial: string) => void;
  /**
   * Context-aware refinement: accessibility text from the current window.
   */
  contextText?: string;
  /**
   * Context-aware refinement: frontmost app name.
   */
  contextAppName?: string;
  /**
   * Context-aware refinement: frontmost window title.
   */
  contextWindowTitle?: string;
  /**
   * Context-aware refinement: Vision-generated summary of the current window.
   */
  contextSummary?: string;
  /**
   * Whether context was successfully captured and used.
   */
  contextUsed?: boolean;
  /**
   * Source identifier for context data.
   */
  contextSource?: "appshot-context-v1";
}

export abstract class BaseReasoningService {
  protected isProcessing = false;

  protected getCustomDictionary(): string[] {
    if (typeof window === "undefined" || !window.localStorage) return [];
    try {
      const raw = window.localStorage.getItem("customDictionary");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  protected getPreferredLanguage(): string {
    if (typeof window === "undefined" || !window.localStorage) return "auto";
    return window.localStorage.getItem("preferredLanguage") || "auto";
  }

  protected getUiLanguage(): string {
    if (typeof window === "undefined" || !window.localStorage) return "en";
    return window.localStorage.getItem("uiLanguage") || "en";
  }

  protected getSystemPrompt(
    agentName: string | null,
    transcript?: string,
    promptMode: PromptMode = "default"
  ): string {
    const language = this.getPreferredLanguage();
    const uiLanguage = this.getUiLanguage();
    return getSystemPrompt(
      agentName,
      this.getCustomDictionary(),
      language,
      transcript,
      uiLanguage,
      { promptMode }
    );
  }

  protected calculateMaxTokens(
    textLength: number,
    minTokens = 100,
    maxTokens = 2048,
    multiplier = 2
  ): number {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }

  abstract isAvailable(): Promise<boolean>;

  abstract processText(
    text: string,
    modelId: string,
    agentName?: string | null,
    config?: ReasoningConfig
  ): Promise<string>;
}
