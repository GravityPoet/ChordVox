const i18next = require("i18next");

const SUPPORTED_UI_LANGUAGES = ["en", "es", "fr", "de", "pt", "it", "ru", "ja", "zh-CN", "zh-TW"];

const localeLoaders = {
  en: () => ({
    translation: require("../locales/en/translation.json"),
    prompts: require("../locales/en/prompts.json"),
  }),
  es: () => ({
    translation: require("../locales/es/translation.json"),
    prompts: require("../locales/es/prompts.json"),
  }),
  fr: () => ({
    translation: require("../locales/fr/translation.json"),
    prompts: require("../locales/fr/prompts.json"),
  }),
  de: () => ({
    translation: require("../locales/de/translation.json"),
    prompts: require("../locales/de/prompts.json"),
  }),
  pt: () => ({
    translation: require("../locales/pt/translation.json"),
    prompts: require("../locales/pt/prompts.json"),
  }),
  it: () => ({
    translation: require("../locales/it/translation.json"),
    prompts: require("../locales/it/prompts.json"),
  }),
  ru: () => ({
    translation: require("../locales/ru/translation.json"),
    prompts: require("../locales/ru/prompts.json"),
  }),
  ja: () => ({
    translation: require("../locales/ja/translation.json"),
    prompts: require("../locales/ja/prompts.json"),
  }),
  "zh-CN": () => ({
    translation: require("../locales/zh-CN/translation.json"),
    prompts: require("../locales/zh-CN/prompts.json"),
  }),
  "zh-TW": () => ({
    translation: require("../locales/zh-TW/translation.json"),
    prompts: require("../locales/zh-TW/prompts.json"),
  }),
};

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeEnglishFallback(base, locale) {
  const merged = { ...base };

  for (const [key, localeValue] of Object.entries(locale)) {
    const baseValue = merged[key];
    merged[key] =
      isPlainObject(baseValue) && isPlainObject(localeValue)
        ? mergeEnglishFallback(baseValue, localeValue)
        : localeValue;
  }

  return merged;
}

function normalizeUiLanguage(language) {
  const candidate = (language || "").trim();

  // Check full language-region code first (e.g. "zh-CN", "zh-TW")
  const normalized = candidate.replace("_", "-");
  const fullMatch = SUPPORTED_UI_LANGUAGES.find(
    (lang) => lang.toLowerCase() === normalized.toLowerCase()
  );
  if (fullMatch) return fullMatch;

  // Fall back to base language code (e.g. "en" from "en-US")
  const base = candidate.split("-")[0].split("_")[0].toLowerCase();
  return SUPPORTED_UI_LANGUAGES.includes(base) ? base : "en";
}

const i18nMain = i18next.createInstance();
const loadedResources = new Map();

function shouldLoadEnglishFallback(language) {
  return language !== "en" && language !== "zh-CN";
}

function loadLanguageResources(language) {
  const normalized = normalizeUiLanguage(language);
  const cached = loadedResources.get(normalized);
  if (cached) return cached;

  if (shouldLoadEnglishFallback(normalized) && !loadedResources.has("en")) {
    loadLanguageResources("en");
  }

  const loaded = localeLoaders[normalized]();
  const englishResources = loadedResources.get("en");
  const resources =
    shouldLoadEnglishFallback(normalized) && englishResources
      ? {
          translation: mergeEnglishFallback(englishResources.translation, loaded.translation),
          prompts: mergeEnglishFallback(englishResources.prompts, loaded.prompts),
        }
      : loaded;

  loadedResources.set(normalized, resources);
  if (i18nMain.isInitialized) {
    i18nMain.addResourceBundle(normalized, "translation", resources.translation, true, true);
    i18nMain.addResourceBundle(normalized, "prompts", resources.prompts, true, true);
  }

  return resources;
}

const initialLanguage = normalizeUiLanguage(process.env.UI_LANGUAGE);
const initialResources = loadLanguageResources(initialLanguage);

void i18nMain.init({
  initImmediate: false,
  resources: {
    [initialLanguage]: initialResources,
  },
  lng: initialLanguage,
  fallbackLng: "en",
  ns: ["translation", "prompts"],
  defaultNS: "translation",
  interpolation: {
    escapeValue: false,
  },
  returnEmptyString: false,
  returnNull: false,
});

function changeLanguage(language) {
  const normalized = normalizeUiLanguage(language);

  loadLanguageResources(normalized);
  if (i18nMain.language !== normalized) {
    void i18nMain.changeLanguage(normalized);
  }

  return normalized;
}

module.exports = {
  i18nMain,
  changeLanguage,
  normalizeUiLanguage,
  SUPPORTED_UI_LANGUAGES,
};
