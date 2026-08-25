const modelManager = require("../helpers/modelManagerBridge").default;
const debugLogger = require("../helpers/debugLogger");

class LocalReasoningService {
  constructor(manager = modelManager, logger = debugLogger, options = {}) {
    this.modelManager = manager;
    this.debugLogger = logger;
    this.maxQueueLength = Math.max(1, Number(options.maxQueueLength) || 8);
    this.requestQueue = [];
    this.activeRequest = null;
    this.processing = false;
    this.drainPromise = Promise.resolve();
  }

  async isAvailable() {
    try {
      await this.modelManager.ensureLlamaCpp();
      const models = await this.modelManager.getAllModels();
      return models.some((model) => model.isDownloaded);
    } catch {
      return false;
    }
  }

  processText(text, modelId, config = {}) {
    if (config.signal?.aborted) {
      return Promise.reject(this.createAbortError());
    }

    return new Promise((resolve, reject) => {
      const request = {
        text,
        modelId,
        config,
        resolve,
        reject,
        settled: false,
        onAbort: null,
      };

      request.onAbort = () => {
        if (request.settled) return;
        const index = this.requestQueue.indexOf(request);
        if (index !== -1) {
          this.requestQueue.splice(index, 1);
          request.settled = true;
          request.reject(this.createAbortError());
          this.debugLogger.logReasoning("LOCAL_BRIDGE_QUEUE_CANCELLED", {
            modelId,
            queueLength: this.requestQueue.length,
          });
          return;
        }

        // Active requests are cancelled cooperatively by forwarding the same
        // AbortSignal to modelManager.runInference. We do not resolve/reject
        // here; the manager owns the active operation and will settle it.
      };
      config.signal?.addEventListener?.("abort", request.onAbort, { once: true });

      // Bound memory and latency under bursty UI traffic. When the queue is
      // full, supersede the oldest waiting request (never the active one) so
      // the newest user action wins instead of growing an unbounded Promise
      // chain.
      if (this.requestQueue.length >= this.maxQueueLength) {
        const superseded = this.requestQueue.shift();
        this.settleQueuedRequest(
          superseded,
          this.createQueueError(
            "ERR_LOCAL_REASONING_SUPERSEDED",
            "Local reasoning request superseded"
          )
        );
      }

      this.requestQueue.push(request);
      this.startQueueDrain();
    });
  }

  createAbortError() {
    const error = new Error("Local reasoning was cancelled");
    error.name = "AbortError";
    error.code = "ERR_LOCAL_REASONING_CANCELLED";
    return error;
  }

  createQueueError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  settleQueuedRequest(request, error) {
    if (!request || request.settled) return;
    request.settled = true;
    request.config.signal?.removeEventListener?.("abort", request.onAbort);
    request.reject(error);
  }

  startQueueDrain() {
    if (this.processing) return;

    this.processing = true;
    this.drainPromise = (async () => {
      while (this.requestQueue.length > 0) {
        const request = this.requestQueue.shift();
        if (!request || request.settled) continue;

        request.config.signal?.removeEventListener?.("abort", request.onAbort);
        if (request.config.signal?.aborted) {
          this.settleQueuedRequest(request, this.createAbortError());
          continue;
        }

        this.activeRequest = request;
        try {
          const result = await this.processTextSerially(
            request.text,
            request.modelId,
            request.config
          );
          if (!request.settled) {
            request.settled = true;
            request.resolve(result);
          }
        } catch (error) {
          if (!request.settled) {
            request.settled = true;
            request.reject(error);
          }
        } finally {
          this.activeRequest = null;
        }
      }
    })().finally(() => {
      this.processing = false;
      // A request can be queued by an abort callback between the final loop
      // check and this finally handler. Start another drain if needed.
      if (this.requestQueue.length > 0) this.startQueueDrain();
    });
  }

  async processTextSerially(text, modelId, config = {}) {
    if (config.signal?.aborted) {
      throw this.createAbortError();
    }

    this.debugLogger.logReasoning("LOCAL_BRIDGE_START", {
      modelId,
      textLength: text.length,
      hasConfig: Object.keys(config).length > 0,
    });

    const startTime = Date.now();

    try {
      const inferenceConfig = {
        maxTokens: config.maxTokens || this.calculateMaxTokens(text.length),
        temperature: config.temperature ?? 0.7,
        topK: config.topK || 40,
        topP: config.topP || 0.9,
        repeatPenalty: config.repeatPenalty || 1.1,
        contextSize: config.contextSize || 4096,
        threads: config.threads || 4,
        systemPrompt: config.systemPrompt || "",
        thinkingBudgetTokens: config.thinkingBudgetTokens,
        signal: config.signal,
      };

      this.debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
        modelId,
        config: inferenceConfig,
      });

      const result = await this.modelManager.runInference(modelId, text, inferenceConfig);

      const processingTime = Date.now() - startTime;

      this.debugLogger.logReasoning("LOCAL_BRIDGE_SUCCESS", {
        modelId,
        processingTimeMs: processingTime,
        resultLength: result.length,
        resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      this.debugLogger.logReasoning("LOCAL_BRIDGE_ERROR", {
        modelId,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    }
  }

  calculateMaxTokens(textLength, minTokens = 100, maxTokens = 2048, multiplier = 2) {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

module.exports = {
  default: new LocalReasoningService(),
  LocalReasoningService,
};
