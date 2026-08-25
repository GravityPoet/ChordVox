/**
 * Centralised left-to-right vs right-to-left detection for the renderer.
 *
 * Adding a new RTL locale only requires registering it here; layout changes
 * (and any consumer that needs to mirror) can read the current direction
 * without each component repeating the language check.
 */

const RTL_LANGUAGES = new Set<string>([
  "ar",
  "ar-sa",
  "ar-eg",
  "fa",
  "fa-ir",
  "he",
  "he-il",
  "ur",
  "ur-pk",
  "ps",
  "yi",
]);

export type LanguageDirection = "ltr" | "rtl";

function normalizeLanguageTag(language: string | null | undefined): string {
  return String(language || "")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();
}

export function getLanguageDirection(language: string | null | undefined): LanguageDirection {
  const candidate = normalizeLanguageTag(language);
  if (!candidate) return "ltr";
  if (RTL_LANGUAGES.has(candidate)) return "rtl";
  const base = candidate.split("-")[0];
  return RTL_LANGUAGES.has(base) ? "rtl" : "ltr";
}

export function applyDocumentDirection(language: string | null | undefined): LanguageDirection {
  const direction = getLanguageDirection(language);
  if (typeof document !== "undefined" && document.documentElement) {
    if (document.documentElement.getAttribute("dir") !== direction) {
      document.documentElement.setAttribute("dir", direction);
    }
    const normalizedLanguage = normalizeLanguageTag(language);
    if (
      normalizedLanguage &&
      document.documentElement.getAttribute("lang") !== normalizedLanguage
    ) {
      document.documentElement.setAttribute("lang", normalizedLanguage);
    }
  }
  return direction;
}
