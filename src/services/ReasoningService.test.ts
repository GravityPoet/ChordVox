import { afterEach, describe, expect, it, vi } from "vitest";
import ReasoningService from "./ReasoningService";

const originalWindow = globalThis.window;

function installRendererWindow(electronAPI: Record<string, unknown> = {}) {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      electronAPI,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    },
    configurable: true,
    writable: true,
  });
  return storage;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ReasoningService request isolation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
    }
  });

  it("runs independent renderer requests concurrently", async () => {
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });

    const completions: Array<(value: string) => void> = [];
    const processWithOpenAI = vi.spyOn(service, "processWithOpenAI").mockImplementation(
      ((text: string) =>
        new Promise<string>((resolve) => {
          completions.push((value) => resolve(value || text));
        })) as any
    );

    const first = ReasoningService.processText("first", "gpt-4o");
    await vi.waitFor(() => expect(processWithOpenAI).toHaveBeenCalledTimes(1));

    const second = ReasoningService.processText("second", "gpt-4o");
    await vi.waitFor(() => expect(processWithOpenAI).toHaveBeenCalledTimes(2));

    completions[1]("second polished");
    completions[0]("first polished");

    await expect(first).resolves.toBe("first polished");
    await expect(second).resolves.toBe("second polished");
  });

  it("refreshes a cached Cerebras key after another renderer changes it", async () => {
    let notifyRemoteStorageChange: ((payload: { key?: string }) => void) | undefined;
    const stopListening = vi.fn();
    let currentKey = "old-cerebras-key";
    const getCerebrasKey = vi.fn(async () => currentKey);

    installRendererWindow({
      getCerebrasKey,
      onLocalStorageChanged: (callback: (payload: { key?: string }) => void) => {
        notifyRemoteStorageChange = callback;
        return stopListening;
      },
    });
    vi.resetModules();
    const { default: isolatedReasoningService } = await import("./ReasoningService");
    const service = isolatedReasoningService as any;

    try {
      await expect(service.getApiKey("cerebras")).resolves.toBe("old-cerebras-key");
      currentKey = "new-cerebras-key";

      notifyRemoteStorageChange?.({ key: "reasoningProvider" });
      await expect(service.getApiKey("cerebras")).resolves.toBe("old-cerebras-key");
      notifyRemoteStorageChange?.({ key: "cerebrasApiKey" });
      await expect(service.getApiKey("cerebras")).resolves.toBe("new-cerebras-key");

      expect(getCerebrasKey).toHaveBeenCalledTimes(2);
    } finally {
      service.destroy();
    }

    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  it("uses a one-request system prompt override without reading production prompt storage", () => {
    const service = ReasoningService as any;
    const getSystemPrompt = vi.spyOn(service, "getSystemPrompt");

    const result = service.getResolvedSystemPrompt(null, "test transcript", {
      systemPromptOverride: "unsaved Prompt Studio draft",
    });

    expect(result).toBe("unsaved Prompt Studio draft");
    expect(getSystemPrompt).not.toHaveBeenCalled();
  });

  it("cancels an in-flight local reasoning IPC request", async () => {
    const processLocalReasoning = vi.fn(
      () =>
        new Promise(() => {
          // Deliberately pending until the renderer cancellation wins the race.
        })
    );
    const cancelReasoningProxyRequest = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(globalThis, "window", {
      value: {
        localStorage: {
          getItem: vi.fn().mockReturnValue(null),
        },
        electronAPI: {
          processLocalReasoning,
          cancelReasoningProxyRequest,
        },
      },
      configurable: true,
      writable: true,
    });

    const controller = new AbortController();
    const pending = (ReasoningService as any).processWithLocal("draft", "local-model", null, {
      systemPromptOverride: "test prompt",
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(processLocalReasoning).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelReasoningProxyRequest).toHaveBeenCalledWith({
      requestId: expect.any(String),
    });
  });

  it("sends none, low, and medium OpenAI effort for the two internal profiles", async () => {
    installRendererWindow();
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<{
      reasoning?: { effort?: string };
      max_output_tokens?: number;
    }> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      requestBodies.push(JSON.parse(options.body));
      return jsonResponse({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "cleaned" }],
          },
        ],
      });
    });

    await ReasoningService.processText("ordinary dictated text", "gpt-5.5", "ChordVox", {
      systemPromptOverride: "polish",
    });
    await ReasoningService.processText(
      "Hi ChordVox, write a professional launch email.",
      "gpt-5.5",
      "ChordVox",
      { systemPromptOverride: "polish" }
    );
    await ReasoningService.processText("fast dictated text", "gpt-5.5", "ChordVox", {
      promptMode: "fast-cleanup",
      systemPromptOverride: "polish",
    });

    expect(requestBodies.map((body) => body.reasoning?.effort)).toEqual(["low", "medium", "none"]);
    expect(requestBodies[2].max_output_tokens).toBeLessThanOrEqual(768);
  });

  it("uses Gemini 3 default temperature and low thinking for ordinary polish", async () => {
    installRendererWindow();
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<{
      generationConfig?: {
        temperature?: number;
        thinkingConfig?: { thinkingLevel?: string };
      };
    }> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      requestBodies.push(JSON.parse(options.body));
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: "cleaned" }] }, finishReason: "STOP" }],
      });
    });

    await ReasoningService.processText(
      "ordinary dictated text",
      "gemini-3-flash-preview",
      "ChordVox",
      { systemPromptOverride: "polish", providerOverride: "gemini" }
    );

    expect(requestBodies[0]?.generationConfig).toMatchObject({
      temperature: 1,
      thinkingConfig: { thinkingLevel: "low" },
    });
  });

  it("passes balanced effort and local thinking budgets through renderer IPC", async () => {
    const processAnthropicReasoning = vi.fn().mockResolvedValue({
      success: true,
      text: "cleaned",
    });
    const processLocalReasoning = vi.fn().mockResolvedValue({
      success: true,
      text: "cleaned",
    });
    installRendererWindow({ processAnthropicReasoning, processLocalReasoning });
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });

    await ReasoningService.processText("ordinary dictated text", "claude-sonnet-4-6", "ChordVox");
    await ReasoningService.processText(
      "Hi ChordVox, draft a launch email with three alternatives.",
      "claude-sonnet-4-6",
      "ChordVox"
    );
    await ReasoningService.processText("ordinary dictated text", "qwen3-8b-q5_k_m", "ChordVox");
    await ReasoningService.processText("fast dictated text", "qwen3-8b-q5_k_m", "ChordVox", {
      promptMode: "fast-cleanup",
    });

    expect(processAnthropicReasoning.mock.calls.map((call) => call[3].effort)).toEqual([
      "low",
      "medium",
    ]);
    expect(processLocalReasoning.mock.calls.map((call) => call[3].thinkingBudgetTokens)).toEqual([
      256, 0,
    ]);
  });

  it("negotiates OpenRouter from nested to scalar reasoning effort", async () => {
    installRendererWindow();
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      requestBodies.push(JSON.parse(options.body));
      if (requestBodies.length === 1) {
        return jsonResponse({ error: { message: "Unsupported reasoning parameter" } }, 400);
      }
      return jsonResponse({ choices: [{ message: { content: "cleaned" } }] });
    });

    await expect(
      ReasoningService.processText(
        "ordinary dictated text",
        "meta-llama/llama-3.3-70b-instruct",
        "ChordVox",
        { providerOverride: "openrouter", systemPromptOverride: "polish" }
      )
    ).resolves.toBe("cleaned");

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({ reasoning: { effort: "low" } });
    expect(requestBodies[1]).toMatchObject({ reasoning_effort: "low" });
    expect(requestBodies[1]).not.toHaveProperty("reasoning");
  });

  it("keeps Gemini 3.7 Flash and sends low effort for fast custom-compatible dictation", async () => {
    const storage = installRendererWindow();
    storage.set("reasoningProvider", "custom");
    storage.set("cloudReasoningBaseUrl", "https://example.test/v1");
    storage.set("customReasoningProtocol", "chat");
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const url = args[0] as string;
      const options = args[1] as { body: string };
      requests.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ choices: [{ message: { content: "cleaned" } }] });
    });

    await expect(
      ReasoningService.processText("ordinary dictated text", "gemini-3.7-flash-high", "ChordVox", {
        providerOverride: "custom",
        promptMode: "fast-cleanup",
        systemPromptOverride: "polish",
      })
    ).resolves.toBe("cleaned");

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://example.test/v1/chat/completions");
    expect(requests[0].body).toMatchObject({
      model: "gemini-3.7-flash-high",
      reasoning_effort: "low",
    });
    expect(requests[0].body.max_tokens).toBeLessThanOrEqual(768);
  });

  it("keeps fast custom-compatible dictation low after the user changes models", async () => {
    const storage = installRendererWindow();
    storage.set("reasoningProvider", "custom");
    storage.set("cloudReasoningBaseUrl", "https://example.test/v1");
    storage.set("customReasoningProtocol", "chat");
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      requestBodies.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content: "cleaned" } }] });
    });

    await expect(
      ReasoningService.processText("ordinary dictated text", "future-custom-model", "ChordVox", {
        providerOverride: "custom",
        promptMode: "fast-cleanup",
        systemPromptOverride: "polish",
      })
    ).resolves.toBe("cleaned");

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      model: "future-custom-model",
      reasoning_effort: "low",
    });
    expect(requestBodies[0].max_tokens).toBeLessThanOrEqual(768);
  });

  it("keeps the exact model while negotiating scalar to nested reasoning effort", async () => {
    const storage = installRendererWindow();
    storage.set("reasoningProvider", "custom");
    storage.set("cloudReasoningBaseUrl", "https://example.test/v1");
    storage.set("customReasoningProtocol", "chat");
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      requestBodies.push(JSON.parse(options.body));
      if (requestBodies.length === 1) {
        return jsonResponse({ error: { message: "Unsupported reasoning parameter" } }, 400);
      }
      return jsonResponse({ choices: [{ message: { content: "cleaned" } }] });
    });

    await expect(
      ReasoningService.processText("ordinary dictated text", "gemini-3.7-flash-high", "ChordVox", {
        providerOverride: "custom",
        promptMode: "fast-cleanup",
        systemPromptOverride: "polish",
      })
    ).resolves.toBe("cleaned");

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.map((body) => body.model)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-high",
    ]);
    expect(requestBodies[0]).toMatchObject({ reasoning_effort: "low" });
    expect(requestBodies[1]).toMatchObject({ reasoning: { effort: "low" } });
    expect(requestBodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("keeps the exact model and uses medium only when the server explicitly requires it", async () => {
    const storage = installRendererWindow();
    storage.set("reasoningProvider", "custom");
    storage.set("cloudReasoningBaseUrl", "https://medium-only.example.test/v1");
    storage.set("customReasoningProtocol", "chat");
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      requestBodies.push(JSON.parse(options.body));
      if (requestBodies.length === 1) {
        return jsonResponse(
          {
            error: {
              message: "Invalid reasoning effort 'low'. Supported values are: medium, high",
            },
          },
          400
        );
      }
      return jsonResponse({ choices: [{ message: { content: "cleaned" } }] });
    });

    const process = () =>
      ReasoningService.processText("ordinary dictated text", "gemini-3.7-flash-high", "ChordVox", {
        providerOverride: "custom",
        promptMode: "fast-cleanup",
        systemPromptOverride: "polish",
      });

    await expect(process()).resolves.toBe("cleaned");
    await expect(process()).resolves.toBe("cleaned");

    expect(requestBodies.map((body) => body.model)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-high",
    ]);
    expect(requestBodies[0]).toMatchObject({ reasoning_effort: "low" });
    expect(requestBodies[1]).toMatchObject({ reasoning_effort: "medium" });
    expect(requestBodies[2]).toMatchObject({ reasoning_effort: "medium" });
  });

  it("keeps the exact model and omits effort when the server only supports high", async () => {
    const storage = installRendererWindow();
    storage.set("reasoningProvider", "custom");
    storage.set("cloudReasoningBaseUrl", "https://high-only.example.test/v1");
    storage.set("customReasoningProtocol", "chat");
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      requestBodies.push(JSON.parse(options.body));
      if (requestBodies.length === 1) {
        return jsonResponse(
          { error: { message: 'level "low" not supported, valid levels: high' } },
          400
        );
      }
      return jsonResponse({ choices: [{ message: { content: "cleaned" } }] });
    });

    const process = () =>
      ReasoningService.processText("ordinary dictated text", "gemini-3.7-flash-high", "ChordVox", {
        providerOverride: "custom",
        promptMode: "fast-cleanup",
        systemPromptOverride: "polish",
      });

    await expect(process()).resolves.toBe("cleaned");
    await expect(process()).resolves.toBe("cleaned");

    expect(requestBodies.map((body) => body.model)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-high",
    ]);
    expect(requestBodies[0]).toMatchObject({ reasoning_effort: "low" });
    for (const requestBody of requestBodies.slice(1)) {
      expect(requestBody).not.toHaveProperty("reasoning");
      expect(requestBody).not.toHaveProperty("reasoning_effort");
    }
  });

  it("keeps the exact model and removes effort only after both parameter dialects fail", async () => {
    const storage = installRendererWindow();
    storage.set("reasoningProvider", "custom");
    storage.set("cloudReasoningBaseUrl", "https://no-effort.example.test/v1");
    storage.set("customReasoningProtocol", "chat");
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      requestBodies.push(JSON.parse(options.body));
      if (requestBodies.length < 3) {
        return jsonResponse({ error: { message: "Unsupported reasoning parameter" } }, 422);
      }
      return jsonResponse({ choices: [{ message: { content: "cleaned" } }] });
    });

    await expect(
      ReasoningService.processText("ordinary dictated text", "gemini-3.7-flash-high", "ChordVox", {
        providerOverride: "custom",
        promptMode: "fast-cleanup",
        systemPromptOverride: "polish",
      })
    ).resolves.toBe("cleaned");

    expect(requestBodies.map((body) => body.model)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-high",
    ]);
    expect(requestBodies[0]).toMatchObject({ reasoning_effort: "low" });
    expect(requestBodies[1]).toMatchObject({ reasoning: { effort: "low" } });
    expect(requestBodies[2]).not.toHaveProperty("reasoning");
    expect(requestBodies[2]).not.toHaveProperty("reasoning_effort");
  });

  it("remembers the compatible nested dialect without ever changing the model", async () => {
    const storage = installRendererWindow();
    storage.set("reasoningProvider", "custom");
    storage.set("cloudReasoningBaseUrl", "https://cached-scalar.example.test/v1");
    storage.set("customReasoningProtocol", "chat");
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      const body = JSON.parse(options.body) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return jsonResponse({ error: { message: "Unsupported reasoning parameter" } }, 400);
      }
      return jsonResponse({ choices: [{ message: { content: "cleaned" } }] });
    });

    const process = () =>
      ReasoningService.processText("ordinary dictated text", "gemini-3.7-flash-high", "ChordVox", {
        providerOverride: "custom",
        promptMode: "fast-cleanup",
        systemPromptOverride: "polish",
      });

    await expect(process()).resolves.toBe("cleaned");
    await expect(process()).resolves.toBe("cleaned");

    expect(requestBodies.map((body) => body.model)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-high",
    ]);
    expect(requestBodies[0]).toMatchObject({ reasoning_effort: "low" });
    expect(requestBodies[1]).toMatchObject({ reasoning: { effort: "low" } });
    expect(requestBodies[2]).toMatchObject({ reasoning: { effort: "low" } });
    expect(requestBodies[2]).not.toHaveProperty("reasoning_effort");
  });

  it.each([401, 429])("does not renegotiate the model or effort after HTTP %s", async (status) => {
    if (status === 429) {
      vi.useFakeTimers();
    }
    const storage = installRendererWindow();
    storage.set("reasoningProvider", "custom");
    storage.set("cloudReasoningBaseUrl", `https://http-${status}.example.test/v1`);
    storage.set("customReasoningProtocol", "chat");
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("test-key");

    const requestBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { body: string };
      requestBodies.push(JSON.parse(options.body));
      return jsonResponse({ error: { message: "request rejected" } }, status);
    });

    const pending = ReasoningService.processText(
      "ordinary dictated text",
      "gemini-3.7-flash-high",
      "ChordVox",
      {
        providerOverride: "custom",
        promptMode: "fast-cleanup",
        systemPromptOverride: "polish",
      }
    );
    const rejected = expect(pending).rejects.toThrow("request rejected");
    if (status === 429) {
      await vi.runAllTimersAsync();
    }
    await rejected;

    expect(requestBodies.length).toBeGreaterThan(0);
    for (const requestBody of requestBodies) {
      expect(requestBody).toMatchObject({
        model: "gemini-3.7-flash-high",
        reasoning_effort: "low",
      });
    }
  });

  it("falls back when a compatible endpoint rejects a reasoning parameter", () => {
    const service = ReasoningService as any;
    const errorPayload = { error: { message: "Unsupported reasoning parameter" } };

    expect(
      service.shouldRetryWithoutReasoningParameter(
        "openrouter",
        "chat",
        400,
        errorPayload,
        JSON.stringify(errorPayload),
        { reasoning: { effort: "low" } }
      )
    ).toBe(true);
    expect(
      service.shouldRetryWithoutReasoningParameter(
        "gemini-compatible",
        "chat",
        422,
        errorPayload,
        JSON.stringify(errorPayload),
        { reasoning_effort: "low" }
      )
    ).toBe(true);
    expect(
      service.shouldRetryWithoutReasoningParameter(
        "custom",
        "chat",
        400,
        errorPayload,
        JSON.stringify(errorPayload),
        { reasoning: { effort: "low" } }
      )
    ).toBe(true);
  });

  it("routes Cerebras through its OpenAI-compatible chat endpoint", async () => {
    installRendererWindow();
    const service = ReasoningService as any;
    vi.spyOn(service, "getProAccessState").mockResolvedValue({
      allowed: true,
      status: { isActive: true },
    });
    vi.spyOn(service, "getApiKey").mockResolvedValue("cerebras-test-key");

    let requestUrl = "";
    let requestHeaders: Record<string, string> = {};
    let requestBody: Record<string, unknown> = {};
    vi.spyOn(service, "fetchReasoningEndpoint").mockImplementation(async (...args: unknown[]) => {
      requestUrl = args[0] as string;
      const options = args[1] as { headers: Record<string, string>; body: string };
      requestHeaders = options.headers;
      requestBody = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: "cleaned" } }] });
    });

    await expect(
      ReasoningService.processText("ordinary dictated text", "gpt-oss-120b", "ChordVox", {
        providerOverride: "cerebras",
        systemPromptOverride: "polish",
      })
    ).resolves.toBe("cleaned");

    expect(requestUrl).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(requestHeaders.Authorization).toBe("Bearer cerebras-test-key");
    expect(requestBody).toMatchObject({
      model: "gpt-oss-120b",
      messages: [
        { role: "system", content: "polish" },
        { role: "user", content: "ordinary dictated text" },
      ],
    });
    expect(requestBody).toHaveProperty("reasoning_effort", "low");
    expect(requestBody).not.toHaveProperty("reasoning");
  });
});
