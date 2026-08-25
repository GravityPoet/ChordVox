import logger from "../utils/logger";
import contextSummaryService from "./ContextSummaryService";
import type { ContextCaptureResult, ContextPermissions } from "../types/electron";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ContextState {
  captureResult: ContextCaptureResult | null;
  visionSummary: string | null;
  visionUsed: boolean;
  visionMs: number;
  totalMs: number;
  error?: string;
}

export interface ContextCaptureOptions {
  enabled: boolean;
  textEnabled: boolean;
  visionEnabled: boolean;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  maxVisionWaitMs?: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_VISION_WAIT_MS = 5000;

// ─── ContextManager ───────────────────────────────────────────────────────────

export class ContextManager {
  private currentCapture: Promise<ContextState> | null = null;
  private captureStartTime: number = 0;
  private captureAbortController: AbortController | null = null;
  private captureSequence: number = 0;

  // ─── Main Capture Flow ───────────────────────────────────────────────────

  /**
   * Start context capture. This should be called when dictation starts.
   * Returns a promise that resolves when context is ready or timeout is reached.
   */
  startCapture(options: ContextCaptureOptions): Promise<ContextState> {
    this.cancelCapture();
    if (!options.enabled) {
      return Promise.resolve(this.getDisabledState());
    }

    this.captureStartTime = Date.now();
    const captureId = ++this.captureSequence;
    const controller = new AbortController();
    this.captureAbortController = controller;

    // Assign immediately so a short recording can always wait for this exact
    // capture, including while the permission check is still running.
    this.currentCapture = this.runCapture(options, controller.signal, captureId);

    // Return the capture promise
    return this.currentCapture;
  }

  private async runCapture(
    options: ContextCaptureOptions,
    signal: AbortSignal,
    captureId: number
  ): Promise<ContextState> {
    const permissions = await this.checkPermissions();
    if (signal.aborted || captureId !== this.captureSequence) {
      return this.getErrorState("cancelled");
    }

    if (permissions.platform !== "darwin") {
      return this.getErrorState("platform-unsupported");
    }

    const textEnabled = options.textEnabled && permissions.accessibility;
    const visionEnabled = options.visionEnabled && permissions.screenRecording;
    if (!textEnabled && !visionEnabled) {
      logger.logReasoning("CONTEXT_CAPTURE_NO_PERMISSIONS", {
        requestedText: options.textEnabled,
        requestedVision: options.visionEnabled,
        accessibility: permissions.accessibility,
        screenRecording: permissions.screenRecording,
      });
      return this.getErrorState("permission-denied");
    }

    return this.captureContextInBackground(
      { ...options, textEnabled, visionEnabled },
      signal,
      this.captureStartTime
    );
  }

  /**
   * Wait for context capture to complete. Called before reasoning starts.
   * If capture is still in progress, waits up to maxVisionWaitMs.
   */
  async waitForContext(
    maxVisionWaitMs: number = DEFAULT_MAX_VISION_WAIT_MS
  ): Promise<ContextState> {
    if (!this.currentCapture) {
      return this.getDisabledState();
    }

    try {
      // Wait for capture with timeout
      const result = await Promise.race([
        this.currentCapture,
        this.createTimeoutPromise(maxVisionWaitMs),
      ]);

      if (result.error === "vision-timeout") {
        this.cancelCapture();
      }

      return result;
    } catch (error) {
      logger.warn("Context capture wait failed", {
        error: (error as Error).message,
      });
      return this.getErrorState("vision-timeout");
    }
  }

  /**
   * Get the current context state for reasoning config.
   * Returns contextText and contextSummary if available.
   */
  getContextForReasoning(state: ContextState): {
    contextAppName?: string;
    contextWindowTitle?: string;
    contextText?: string;
    contextSummary?: string;
    contextUsed: boolean;
    contextSource: "appshot-context-v1";
  } {
    if (!state.captureResult) {
      return {
        contextUsed: false,
        contextSource: "appshot-context-v1",
      };
    }

    const { captureResult, visionSummary } = state;

    // Build context text from accessibility data
    const contextText = this.buildContextText(captureResult);

    return {
      contextAppName: captureResult.appName || undefined,
      contextWindowTitle: captureResult.windowTitle || undefined,
      contextText: contextText || undefined,
      contextSummary: visionSummary || undefined,
      contextUsed: !!(contextText || visionSummary),
      contextSource: "appshot-context-v1",
    };
  }

  // ─── Background Capture ──────────────────────────────────────────────────

  private async captureContextInBackground(
    options: ContextCaptureOptions,
    signal: AbortSignal,
    captureStartedAt: number
  ): Promise<ContextState> {
    try {
      if (signal.aborted) return this.getErrorState("cancelled");
      // Capture accessibility text and screenshot in parallel
      const captureResult = await this.captureFromMainProcess(options, signal);

      if (signal.aborted) return this.getErrorState("cancelled");

      if (!captureResult.layer1Success && !captureResult.layer2Success) {
        return {
          captureResult,
          visionSummary: null,
          visionUsed: false,
          visionMs: 0,
          totalMs: Date.now() - captureStartedAt,
          error: captureResult.fallbackReason,
        };
      }

      // If we have a screenshot, try to get vision summary
      let visionSummary: string | null = null;
      let visionUsed = false;
      let visionMs = 0;

      if (options.visionEnabled && captureResult.layer2Success && captureResult.screenshotBase64) {
        const visionStartTime = Date.now();

        try {
          const summaryResult = await contextSummaryService.generateSummary({
            appName: captureResult.appName,
            windowTitle: captureResult.windowTitle,
            visibleText: captureResult.visibleText,
            screenshotBase64: captureResult.screenshotBase64,
            screenshotMimeType: captureResult.screenshotMimeType,
            provider: options.provider,
            model: options.model,
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            signal,
          });

          visionSummary = summaryResult.summary;
          visionUsed = summaryResult.visionUsed;
          visionMs = Date.now() - visionStartTime;

          logger.logReasoning("CONTEXT_VISION_COMPLETE", {
            visionUsed,
            visionMs,
            summaryLength: visionSummary?.length || 0,
          });
        } catch (error) {
          visionMs = Date.now() - visionStartTime;
          logger.warn("Context vision failed", {
            error: (error as Error).message,
            visionMs,
          });
        }
      }

      const totalMs = Date.now() - captureStartedAt;

      logger.logReasoning("CONTEXT_CAPTURE_COMPLETE", {
        totalMs,
        layer1Success: captureResult.layer1Success,
        layer2Success: captureResult.layer2Success,
        visionUsed,
        visionMs,
        hasContextText: !!captureResult.visibleText,
        hasContextSummary: !!visionSummary,
      });

      return {
        captureResult,
        visionSummary,
        visionUsed,
        visionMs,
        totalMs,
      };
    } catch (error) {
      const totalMs = Date.now() - captureStartedAt;

      logger.warn("Context capture failed", {
        error: (error as Error).message,
        totalMs,
      });

      return {
        captureResult: null,
        visionSummary: null,
        visionUsed: false,
        visionMs: 0,
        totalMs,
        error: (error as Error).message,
      };
    }
  }

  // ─── Main Process Communication ──────────────────────────────────────────

  private async captureFromMainProcess(
    options: Pick<ContextCaptureOptions, "textEnabled" | "visionEnabled">,
    signal: AbortSignal
  ): Promise<ContextCaptureResult> {
    if (typeof window === "undefined" || !window.electronAPI?.captureContext) {
      return {
        layer1Success: false,
        layer2Success: false,
        fallbackReason: "disabled",
      };
    }

    try {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await window.electronAPI.captureContext({
        textEnabled: options.textEnabled,
        visionEnabled: options.visionEnabled,
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return result;
    } catch (error) {
      logger.warn("Main process context capture failed", {
        error: (error as Error).message,
      });
      return {
        layer1Success: false,
        layer2Success: false,
        fallbackReason: "capture-timeout",
      };
    }
  }

  private async checkPermissions(): Promise<ContextPermissions> {
    if (typeof window === "undefined" || !window.electronAPI?.checkContextPermissions) {
      return {
        accessibility: false,
        screenRecording: false,
        platform: "unknown",
      };
    }

    try {
      return await window.electronAPI.checkContextPermissions();
    } catch (error) {
      return {
        accessibility: false,
        screenRecording: false,
        platform: "unknown",
      };
    }
  }

  // ─── Context Text Building ───────────────────────────────────────────────

  private buildContextText(captureResult: ContextCaptureResult): string {
    const parts: string[] = [];

    if (captureResult.appName) {
      parts.push(`App: ${captureResult.appName}`);
    }

    if (captureResult.windowTitle) {
      parts.push(`Window: ${captureResult.windowTitle}`);
    }

    if (captureResult.visibleText) {
      // Truncate visible text
      const maxVisibleText = 1200;
      const truncatedText =
        captureResult.visibleText.length > maxVisibleText
          ? captureResult.visibleText.slice(0, maxVisibleText) + "..."
          : captureResult.visibleText;
      parts.push(`Visible text: ${truncatedText}`);
    }

    return parts.join("\n");
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private getDisabledState(): ContextState {
    return {
      captureResult: null,
      visionSummary: null,
      visionUsed: false,
      visionMs: 0,
      totalMs: 0,
      error: "disabled",
    };
  }

  private getErrorState(reason: string): ContextState {
    return {
      captureResult: null,
      visionSummary: null,
      visionUsed: false,
      visionMs: 0,
      totalMs: Date.now() - this.captureStartTime,
      error: reason,
    };
  }

  private createTimeoutPromise(ms: number): Promise<ContextState> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          captureResult: null,
          visionSummary: null,
          visionUsed: false,
          visionMs: 0,
          totalMs: ms,
          error: "vision-timeout",
        });
      }, ms);
    });
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  cancelCapture(): void {
    this.captureSequence += 1;
    this.captureAbortController?.abort();
    this.captureAbortController = null;
    this.currentCapture = null;
    this.captureStartTime = 0;
  }

  releaseCapture(): void {
    this.currentCapture = null;
    this.captureAbortController = null;
    this.captureStartTime = 0;
  }
}

// Singleton instance
const contextManager = new ContextManager();

export default contextManager;
