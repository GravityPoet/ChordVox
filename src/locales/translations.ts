import type enTranslation from "./en/translation.json";

export type TranslationBundle = typeof enTranslation;
export type TranslationLocale =
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

const translationLoaders: Record<TranslationLocale, () => Promise<TranslationBundle>> = {
  en: async () => (await import("./en/translation.json")).default as TranslationBundle,
  es: async () => (await import("./es/translation.json")).default as unknown as TranslationBundle,
  fr: async () => (await import("./fr/translation.json")).default as unknown as TranslationBundle,
  de: async () => (await import("./de/translation.json")).default as unknown as TranslationBundle,
  pt: async () => (await import("./pt/translation.json")).default as unknown as TranslationBundle,
  it: async () => (await import("./it/translation.json")).default as unknown as TranslationBundle,
  ru: async () => (await import("./ru/translation.json")).default as unknown as TranslationBundle,
  ja: async () => (await import("./ja/translation.json")).default as unknown as TranslationBundle,
  "zh-CN": async () =>
    (await import("./zh-CN/translation.json")).default as unknown as TranslationBundle,
  "zh-TW": async () =>
    (await import("./zh-TW/translation.json")).default as unknown as TranslationBundle,
};

export function loadTranslationBundle(locale: TranslationLocale): Promise<TranslationBundle> {
  return translationLoaders[locale]();
}
