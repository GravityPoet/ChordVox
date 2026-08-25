export const DEFAULT_CUSTOM_DICTIONARY = [
  "CC",
  "Claude Code",
  "OPENAI",
  "ChatGPT",
  "Gemini",
  "openclaw",
  "Claude",
  "codex",
] as const;

export const MAX_DICTIONARY_WORD_LENGTH = 64;
export const MAX_DICTIONARY_WORDS = 200;

const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/g;

function sanitizeWord(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.replace(CONTROL_CHARS_REGEX, " ").replace(/\s+/g, " ").trim();
  if (!stripped) return null;
  return stripped.length > MAX_DICTIONARY_WORD_LENGTH
    ? stripped.slice(0, MAX_DICTIONARY_WORD_LENGTH)
    : stripped;
}

export function normalizeDictionaryWords(words: readonly unknown[]): string[] {
  if (!Array.isArray(words)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const word of words) {
    if (normalized.length >= MAX_DICTIONARY_WORDS) break;
    const cleaned = sanitizeWord(word);
    if (!cleaned) continue;
    const dedupKey = cleaned.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    normalized.push(cleaned);
  }

  return normalized;
}
