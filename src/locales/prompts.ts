export interface PromptBundle {
  cleanupPrompt: string;
  fullPrompt: string;
  dictionarySuffix: string;
}

export type PromptLocale =
  | "en"
  | "es"
  | "fr"
  | "de"
  | "pt"
  | "it"
  | "ru"
  | "ja"
  | "zh-CN"
  | "zh-TW";

const promptLoaders: Record<PromptLocale, () => Promise<PromptBundle>> = {
  en: async () => (await import("./en/prompts.json")).default as PromptBundle,
  es: async () => (await import("./es/prompts.json")).default as PromptBundle,
  fr: async () => (await import("./fr/prompts.json")).default as PromptBundle,
  de: async () => (await import("./de/prompts.json")).default as PromptBundle,
  pt: async () => (await import("./pt/prompts.json")).default as PromptBundle,
  it: async () => (await import("./it/prompts.json")).default as PromptBundle,
  ru: async () => (await import("./ru/prompts.json")).default as PromptBundle,
  ja: async () => (await import("./ja/prompts.json")).default as PromptBundle,
  "zh-CN": async () => (await import("./zh-CN/prompts.json")).default as PromptBundle,
  "zh-TW": async () => (await import("./zh-TW/prompts.json")).default as PromptBundle,
};

export function loadPromptBundle(locale: PromptLocale): Promise<PromptBundle> {
  return promptLoaders[locale]();
}
