export const CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL = "gemini-generate-content" as const;

export type CustomReasoningProtocol =
  | "auto"
  | "chat"
  | "responses"
  | typeof CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL;

export function normalizeCustomReasoningProtocol(value: unknown): CustomReasoningProtocol {
  return value === "chat" ||
    value === "responses" ||
    value === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL
    ? value
    : "auto";
}
