"use strict";

const ANTHROPIC_OUTPUT_EFFORTS = new Set(["low", "medium"]);

function normalizeAnthropicOutputEffort(value) {
  return ANTHROPIC_OUTPUT_EFFORTS.has(value) ? value : undefined;
}

function supportsAnthropicOutputEffort(model) {
  const normalized = String(model || "")
    .trim()
    .toLowerCase();
  return /^claude-(?:fable-5|mythos-(?:5|preview)|opus-4-[5-8]|sonnet-(?:5|4-6))/.test(normalized);
}

function buildAnthropicReasoningRequestBody({
  model,
  userPrompt,
  systemPrompt,
  maxTokens,
  temperature,
  effort,
}) {
  const requestBody = {
    model,
    messages: [{ role: "user", content: userPrompt }],
    system: systemPrompt,
    max_tokens: maxTokens,
    temperature,
  };
  const normalizedEffort = normalizeAnthropicOutputEffort(effort);
  if (normalizedEffort && supportsAnthropicOutputEffort(model)) {
    requestBody.output_config = { effort: normalizedEffort };
  }
  return requestBody;
}

function buildLlamaChatCompletionsBody(messages, options = {}) {
  const requestBody = {
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? 512,
    stream: false,
  };
  if (Number.isInteger(options.thinking_budget_tokens) && options.thinking_budget_tokens >= 0) {
    requestBody.thinking_budget_tokens = options.thinking_budget_tokens;
  }
  return requestBody;
}

module.exports = {
  buildAnthropicReasoningRequestBody,
  buildLlamaChatCompletionsBody,
  normalizeAnthropicOutputEffort,
  supportsAnthropicOutputEffort,
};
