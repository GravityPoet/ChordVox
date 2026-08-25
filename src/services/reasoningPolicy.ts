import { isDirectAgentRequest, type PromptMode } from "../config/prompts";

export type ReasoningProfile = "fast-cleanup" | "balanced";
export type ReasoningComplexity = "standard" | "complex";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export interface ReasoningPolicy {
  profile: ReasoningProfile;
  complexity: ReasoningComplexity;
}

interface ReasoningPolicyInput {
  text: string;
  agentName?: string | null;
  promptMode?: PromptMode;
  disableThinking?: boolean;
}

function normalizeModel(model: string): string {
  return String(model || "")
    .trim()
    .toLowerCase();
}

function getTaskReasoningEffort(policy: ReasoningPolicy): "low" | "medium" {
  // Product invariant: effort follows the task, never a user-selected model.
  // Ordinary work stays low; only an explicit complex request may reach medium.
  return policy.profile === "balanced" && policy.complexity === "complex" ? "medium" : "low";
}

export function resolveReasoningPolicy({
  text,
  agentName,
  promptMode,
  disableThinking,
}: ReasoningPolicyInput): ReasoningPolicy {
  const profile: ReasoningProfile =
    promptMode === "fast-cleanup" || disableThinking === true ? "fast-cleanup" : "balanced";
  const complexity: ReasoningComplexity =
    profile === "balanced" && isDirectAgentRequest(text, agentName) ? "complex" : "standard";

  return { profile, complexity };
}

function getOpenAiMinimumReasoningEffort(model: string): ReasoningEffort | null {
  const normalized = normalizeModel(model);

  // Chat aliases expose the ChatGPT snapshot rather than configurable reasoning.
  if (normalized.includes("-chat")) return null;

  // Pro models cannot be dialed down to the normal low-latency levels.
  if (/^gpt-5-pro(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalized)) return "high";
  if (/^gpt-5\.(?:2|4|5)-pro(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalized)) {
    return "medium";
  }

  // Codex variants have their own model-specific ranges and are not polish models.
  if (normalized.includes("-codex")) return null;

  // The original GPT-5 generation has no `none` level; `minimal` is its floor.
  if (
    /^gpt-5(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalized) ||
    /^gpt-5-(?:mini|nano)(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalized)
  ) {
    return "minimal";
  }

  // GPT-5.1, 5.2, 5.4, 5.5 and 5.6 general-purpose families support `none`.
  if (/^gpt-5\.(?:1|2|4|5|6)(?:$|-)/.test(normalized)) return "none";

  return null;
}

export function isOpenAiReasoningModel(model: string): boolean {
  const normalized = normalizeModel(model);
  return normalized.startsWith("gpt-5") && !normalized.includes("-chat");
}

export function getOpenAiReasoningEffort(
  model: string,
  policy: ReasoningPolicy
): ReasoningEffort | null {
  const minimumEffort = getOpenAiMinimumReasoningEffort(model);
  if (!minimumEffort) {
    const normalized = normalizeModel(model);
    const knownNonTunableModel =
      normalized.includes("-chat") ||
      normalized.includes("-codex") ||
      /^gpt-(?:3|4)(?:\.|-|$)/.test(normalized);
    return knownNonTunableModel ? null : getTaskReasoningEffort(policy);
  }
  if (minimumEffort === "high" || minimumEffort === "medium") return "medium";
  if (policy.profile === "fast-cleanup") return minimumEffort;
  return getTaskReasoningEffort(policy);
}

export function getOpenRouterReasoningEffort(policy: ReasoningPolicy): ReasoningEffort {
  if (policy.profile === "fast-cleanup") return "none";
  return getTaskReasoningEffort(policy);
}

export function getGeminiThinkingConfig(
  model: string,
  policy: ReasoningPolicy
): Record<string, unknown> | null {
  const normalized = normalizeModel(model);

  if (normalized.includes("gemini-2.5") && normalized.includes("flash")) {
    if (policy.profile === "fast-cleanup") return { thinkingBudget: 0 };
    return { thinkingBudget: policy.complexity === "complex" ? 1024 : 512 };
  }

  if (normalized.includes("gemini-2.5") && normalized.includes("pro")) {
    if (policy.profile === "fast-cleanup") return { thinkingBudget: 128 };
    return { thinkingBudget: policy.complexity === "complex" ? 1024 : 512 };
  }

  if (!normalized.includes("gemini")) return null;

  if (!normalized.includes("gemini-3")) {
    return { thinkingLevel: getTaskReasoningEffort(policy) };
  }

  if (normalized.includes("flash-lite-image")) {
    return { thinkingLevel: "minimal" };
  }

  const legacyPro = normalized.includes("gemini-3-pro") && !normalized.includes("gemini-3.1-pro");
  if (legacyPro) {
    return { thinkingLevel: "low" };
  }

  if (policy.profile === "fast-cleanup") {
    return { thinkingLevel: normalized.includes("pro") ? "low" : "minimal" };
  }

  return { thinkingLevel: getTaskReasoningEffort(policy) };
}

export function getGeminiOpenAiReasoningEffort(
  model: string,
  policy: ReasoningPolicy
): ReasoningEffort | null {
  const normalized = normalizeModel(model);
  if (!normalized.includes("gemini")) return null;

  if (!normalized.includes("gemini-2.5") && !normalized.includes("gemini-3")) {
    return getTaskReasoningEffort(policy);
  }

  if (policy.profile === "fast-cleanup") {
    if (normalized.includes("gemini-2.5") && normalized.includes("flash")) return "none";
    if (normalized.includes("flash-lite-image")) return "minimal";
    return normalized.includes("pro") ? "low" : "minimal";
  }

  if (
    normalized.includes("flash-lite-image") ||
    (normalized.includes("gemini-3-pro") && !normalized.includes("gemini-3.1-pro"))
  ) {
    return normalized.includes("flash-lite-image") ? "minimal" : "low";
  }

  return getTaskReasoningEffort(policy);
}

export function getCustomOpenAiReasoningEffort(
  _model: string,
  policy: ReasoningPolicy
): ReasoningEffort | null {
  // Custom OpenAI-compatible routes negotiate the task-level low/medium effort
  // across protocol dialects, then keep the same model and omit effort if needed.
  return getTaskReasoningEffort(policy);
}

export function getGroqReasoningEffort(
  model: string,
  policy: ReasoningPolicy
): "none" | "default" | "low" | "medium" | null {
  const normalized = normalizeModel(model);

  if (normalized.startsWith("qwen/qwen3")) {
    return policy.profile === "balanced" && policy.complexity === "complex" ? "default" : "none";
  }

  if (normalized.startsWith("openai/gpt-oss")) {
    return getTaskReasoningEffort(policy);
  }

  return null;
}

export function getCerebrasReasoningEffort(
  model: string,
  policy: ReasoningPolicy
): "none" | "low" | "medium" | null {
  const normalized = normalizeModel(model);

  if (normalized === "gemma-4-31b") {
    return policy.profile === "fast-cleanup" ? "none" : getTaskReasoningEffort(policy);
  }

  if (normalized === "gpt-oss-120b") {
    return getTaskReasoningEffort(policy);
  }

  return null;
}

export function getAnthropicOutputEffort(
  model: string,
  policy: ReasoningPolicy
): "low" | "medium" | null {
  const normalized = normalizeModel(model);
  const supportsEffort =
    /^claude-(?:fable-5|mythos-(?:5|preview)|opus-4-[5-8]|sonnet-(?:5|4-6))/.test(normalized);
  if (!supportsEffort) return null;

  return getTaskReasoningEffort(policy);
}

export function getLocalThinkingBudget(model: string, policy: ReasoningPolicy): number | null {
  const normalized = normalizeModel(model);
  if (!normalized.startsWith("qwen3-") && !normalized.startsWith("gpt-oss-")) return null;

  if (policy.profile === "fast-cleanup") return 0;
  return policy.complexity === "complex" ? 1024 : 256;
}

export function getReasoningTemperature(model: string, explicitTemperature?: number): number {
  if (typeof explicitTemperature === "number") return explicitTemperature;
  return normalizeModel(model).includes("gemini-3") ? 1 : 0.1;
}
