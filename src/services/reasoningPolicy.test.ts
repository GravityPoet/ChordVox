import { describe, expect, it } from "vitest";
import {
  getAnthropicOutputEffort,
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
} from "./reasoningPolicy";

const ordinary = resolveReasoningPolicy({
  text: "Please clean up this short dictated message.",
  agentName: "ChordVox",
  promptMode: "default",
});
const complex = resolveReasoningPolicy({
  text: "Hi ChordVox, write a professional launch email and include three alternatives.",
  agentName: "ChordVox",
  promptMode: "default",
});
const fast = resolveReasoningPolicy({
  text: "Hi ChordVox, write a launch email.",
  agentName: "ChordVox",
  promptMode: "fast-cleanup",
});

describe("reasoning policy profiles", () => {
  it("keeps normal polish balanced and only promotes direct agent requests", () => {
    expect(ordinary).toEqual({ profile: "balanced", complexity: "standard" });
    expect(complex).toEqual({ profile: "balanced", complexity: "complex" });
    expect(
      resolveReasoningPolicy({
        text: "Hi, ChordVox, summarize this into three bullets.",
        agentName: "ChordVox",
      })
    ).toEqual({ profile: "balanced", complexity: "complex" });
    expect(
      resolveReasoningPolicy({
        text: "I told ChordVox that the project is useful.",
        agentName: "ChordVox",
      })
    ).toEqual({ profile: "balanced", complexity: "standard" });
    expect(
      resolveReasoningPolicy({
        text: "I said hi ChordVox, summarize it, but that was only a quote.",
        agentName: "ChordVox",
      })
    ).toEqual({ profile: "balanced", complexity: "standard" });
    expect(
      resolveReasoningPolicy({
        text: "请 ChordVox，分析这段话并给出三个选项。",
        agentName: "ChordVox",
      })
    ).toEqual({ profile: "balanced", complexity: "complex" });
  });

  it("makes fast-cleanup and legacy disableThinking requests strictly fast", () => {
    expect(fast).toEqual({ profile: "fast-cleanup", complexity: "standard" });
    expect(
      resolveReasoningPolicy({
        text: "Hi ChordVox, write a launch email.",
        agentName: "ChordVox",
        disableThinking: true,
      })
    ).toEqual({ profile: "fast-cleanup", complexity: "standard" });
  });
});

describe("provider low-latency mappings", () => {
  it("maps OpenAI and OpenRouter to none, low, and medium", () => {
    for (const model of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2"]) {
      expect(getOpenAiReasoningEffort(model, fast)).toBe("none");
      expect(getOpenAiReasoningEffort(model, ordinary)).toBe("low");
      expect(getOpenAiReasoningEffort(model, complex)).toBe("medium");
    }
    expect(getOpenAiReasoningEffort("gpt-4.1", ordinary)).toBeNull();
    expect(getOpenRouterReasoningEffort(fast)).toBe("none");
    expect(getOpenRouterReasoningEffort(ordinary)).toBe("low");
    expect(getOpenRouterReasoningEffort(complex)).toBe("medium");
  });

  it("never asks OpenAI for effort above medium and tunes future models automatically", () => {
    expect(getOpenAiReasoningEffort("gpt-5", fast)).toBe("minimal");
    expect(getOpenAiReasoningEffort("gpt-5-2025-08-07", fast)).toBe("minimal");
    expect(getOpenAiReasoningEffort("gpt-5.1", fast)).toBe("none");
    expect(getOpenAiReasoningEffort("gpt-5.4-mini", fast)).toBe("none");
    expect(getOpenAiReasoningEffort("gpt-5.5-pro", fast)).toBe("medium");
    expect(getOpenAiReasoningEffort("gpt-5.5-pro", ordinary)).toBe("medium");
    expect(getOpenAiReasoningEffort("gpt-5-pro", fast)).toBe("medium");
    expect(getOpenAiReasoningEffort("gpt-5-pro", complex)).toBe("medium");
    expect(getOpenAiReasoningEffort("future-reasoning-model", fast)).toBe("low");
    expect(getOpenAiReasoningEffort("future-reasoning-model", ordinary)).toBe("low");
    expect(getOpenAiReasoningEffort("future-reasoning-model", complex)).toBe("medium");
    expect(getOpenAiReasoningEffort("gpt-5.2-codex", ordinary)).toBeNull();
    expect(getOpenAiReasoningEffort("gpt-5.2-chat-latest", ordinary)).toBeNull();
    expect(isOpenAiReasoningModel("gpt-5.5-pro")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-5.2-chat-latest")).toBe(false);
  });

  it("uses each Gemini family's lowest supported controls", () => {
    expect(getGeminiThinkingConfig("gemini-2.5-flash", fast)).toEqual({ thinkingBudget: 0 });
    expect(getGeminiThinkingConfig("gemini-2.5-flash", ordinary)).toEqual({
      thinkingBudget: 512,
    });
    expect(getGeminiThinkingConfig("gemini-2.5-flash", complex)).toEqual({
      thinkingBudget: 1024,
    });
    expect(getGeminiThinkingConfig("gemini-2.5-pro", fast)).toEqual({ thinkingBudget: 128 });
    expect(getGeminiThinkingConfig("gemini-3.1-pro-preview", fast)).toEqual({
      thinkingLevel: "low",
    });
    expect(getGeminiThinkingConfig("gemini-3-flash-preview", fast)).toEqual({
      thinkingLevel: "minimal",
    });
    expect(getGeminiThinkingConfig("gemini-3-flash-preview", ordinary)).toEqual({
      thinkingLevel: "low",
    });
    expect(getGeminiThinkingConfig("gemini-3-flash-preview", complex)).toEqual({
      thinkingLevel: "medium",
    });
    expect(getGeminiThinkingConfig("gemini-3.1-flash-lite-preview", fast)).toEqual({
      thinkingLevel: "minimal",
    });
    expect(getGeminiThinkingConfig("gemini-3.1-flash-lite-preview", ordinary)).toEqual({
      thinkingLevel: "low",
    });
    expect(getGeminiThinkingConfig("gemini-3.1-flash-lite-preview", complex)).toEqual({
      thinkingLevel: "medium",
    });
    expect(getGeminiThinkingConfig("gemini-3-pro-preview", complex)).toEqual({
      thinkingLevel: "low",
    });
    expect(getGeminiOpenAiReasoningEffort("gemini-2.5-flash", fast)).toBe("none");
    expect(getGeminiOpenAiReasoningEffort("gemini-3.1-pro-preview", fast)).toBe("low");
    expect(getGeminiThinkingConfig("gemini-4-flash-preview", fast)).toEqual({
      thinkingLevel: "low",
    });
    expect(getGeminiThinkingConfig("gemini-4-flash-preview", complex)).toEqual({
      thinkingLevel: "medium",
    });
    expect(getGeminiOpenAiReasoningEffort("gemini-4-flash-preview", fast)).toBe("low");
    expect(getGeminiOpenAiReasoningEffort("gemini-4-flash-preview", complex)).toBe("medium");
  });

  it("applies the task effort to every custom compatible model without a model whitelist", () => {
    expect(getCustomOpenAiReasoningEffort("gemini-3.7-flash-high", fast)).toBe("low");
    expect(getCustomOpenAiReasoningEffort("gemini-3.7-flash-high", ordinary)).toBe("low");
    expect(getCustomOpenAiReasoningEffort("gemini-3.7-flash-high", complex)).toBe("medium");
    expect(getCustomOpenAiReasoningEffort("custom-model", fast)).toBe("low");
    expect(getCustomOpenAiReasoningEffort("custom-model", ordinary)).toBe("low");
    expect(getCustomOpenAiReasoningEffort("custom-model", complex)).toBe("medium");
  });

  it("uses Groq model-specific effort values", () => {
    expect(getGroqReasoningEffort("qwen/qwen3-32b", ordinary)).toBe("none");
    expect(getGroqReasoningEffort("qwen/qwen3-32b", complex)).toBe("default");
    expect(getGroqReasoningEffort("openai/gpt-oss-120b", fast)).toBe("low");
    expect(getGroqReasoningEffort("openai/gpt-oss-120b", complex)).toBe("medium");
    expect(getGroqReasoningEffort("llama-3.3-70b-versatile", ordinary)).toBeNull();
    expect(getGroqReasoningEffort("groq/compound", ordinary)).toBeNull();
  });

  it("keeps Anthropic and local reasoning at bounded low-latency levels", () => {
    expect(getAnthropicOutputEffort("claude-opus-4-7", ordinary)).toBe("low");
    expect(getAnthropicOutputEffort("claude-opus-4-8", ordinary)).toBe("low");
    expect(getAnthropicOutputEffort("claude-sonnet-4-6", complex)).toBe("medium");
    expect(getAnthropicOutputEffort("claude-haiku-4-5", ordinary)).toBeNull();
    expect(getLocalThinkingBudget("qwen3-8b-q5_k_m", fast)).toBe(0);
    expect(getLocalThinkingBudget("qwen3-8b-q5_k_m", ordinary)).toBe(256);
    expect(getLocalThinkingBudget("gpt-oss-20b-mxfp4", complex)).toBe(1024);
    expect(getLocalThinkingBudget("qwen2.5-7b-instruct-q5_k_m", ordinary)).toBeNull();
  });

  it("uses Gemini 3's recommended default temperature unless explicitly overridden", () => {
    expect(getReasoningTemperature("gemini-3.1-pro-preview")).toBe(1);
    expect(getReasoningTemperature("gemini-2.5-flash")).toBe(0.1);
    expect(getReasoningTemperature("gemini-3-flash-preview", 0.4)).toBe(0.4);
  });
});
