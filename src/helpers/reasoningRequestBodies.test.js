import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  buildAnthropicReasoningRequestBody,
  buildLlamaChatCompletionsBody,
} = require("./reasoningRequestBodies.js");

describe("reasoning request bodies", () => {
  it("adds only supported Anthropic output effort", () => {
    const base = {
      model: "claude-sonnet-4-6",
      userPrompt: "draft",
      systemPrompt: "polish",
      maxTokens: 512,
      temperature: 0.1,
    };

    expect(buildAnthropicReasoningRequestBody({ ...base, effort: "low" })).toMatchObject({
      output_config: { effort: "low" },
    });
    expect(buildAnthropicReasoningRequestBody({ ...base, effort: "high" })).not.toHaveProperty(
      "output_config"
    );
    expect(
      buildAnthropicReasoningRequestBody({
        ...base,
        model: "claude-haiku-4-5",
        effort: "low",
      })
    ).not.toHaveProperty("output_config");
  });

  it("preserves a zero llama.cpp thinking budget and omits an absent one", () => {
    const messages = [{ role: "user", content: "draft" }];

    expect(buildLlamaChatCompletionsBody(messages, { thinking_budget_tokens: 0 })).toMatchObject({
      thinking_budget_tokens: 0,
    });
    expect(buildLlamaChatCompletionsBody(messages)).not.toHaveProperty("thinking_budget_tokens");
  });
});
