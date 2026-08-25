import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { loadPromptBundle } from "./locales/prompts";
import { loadTranslationBundle } from "./locales/translations";
import { applyDocumentDirection } from "./utils/textDirection";

export const SUPPORTED_UI_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "ru",
  "ja",
  "zh-CN",
  "zh-TW",
] as const;
export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

type LocaleTree = Record<string, unknown>;

export function normalizeUiLanguage(language: string | null | undefined): UiLanguage {
  const candidate = (language || "").trim();

  // Check full language-region code first (e.g. "zh-CN", "zh-TW")
  const normalized = candidate.replace("_", "-");
  const fullMatch = SUPPORTED_UI_LANGUAGES.find(
    (lang) => lang.toLowerCase() === normalized.toLowerCase()
  );
  if (fullMatch) return fullMatch;

  // Fall back to base language code (e.g. "en" from "en-US")
  const base = candidate.split("-")[0].split("_")[0].toLowerCase() as UiLanguage;
  if (SUPPORTED_UI_LANGUAGES.includes(base)) {
    return base;
  }

  return "en";
}

function isPlainObject(value: unknown): value is LocaleTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeEnglishFallback(base: LocaleTree, locale: LocaleTree): LocaleTree {
  const merged: LocaleTree = { ...base };

  for (const [key, localeValue] of Object.entries(locale)) {
    const baseValue = merged[key];
    merged[key] =
      isPlainObject(baseValue) && isPlainObject(localeValue)
        ? mergeEnglishFallback(baseValue, localeValue)
        : localeValue;
  }

  return merged;
}

const loadedResourceLanguages = new Set<UiLanguage>();
const pendingResourceLoads = new Map<UiLanguage, Promise<void>>();
const loadedResources = new Map<UiLanguage, { translation: LocaleTree; prompts: LocaleTree }>();

function shouldLoadEnglishFallback(language: UiLanguage): boolean {
  return language !== "en" && language !== "zh-CN";
}

function addLanguageResources(
  language: UiLanguage,
  translation: LocaleTree,
  prompts: LocaleTree
): void {
  const englishResources = loadedResources.get("en");
  const resources =
    shouldLoadEnglishFallback(language) && englishResources
      ? {
          translation: mergeEnglishFallback(englishResources.translation, translation),
          prompts: mergeEnglishFallback(englishResources.prompts, prompts),
        }
      : { translation, prompts };

  loadedResources.set(language, resources);
  if (i18n.isInitialized) {
    i18n.addResourceBundle(language, "translation", resources.translation, true, true);
    i18n.addResourceBundle(language, "prompts", resources.prompts, true, true);
  }
  loadedResourceLanguages.add(language);
}

export async function loadUiLanguageResources(languageInput: string): Promise<UiLanguage> {
  const language = normalizeUiLanguage(languageInput);
  if (loadedResourceLanguages.has(language)) {
    return language;
  }

  const pendingLoad = pendingResourceLoads.get(language);
  if (pendingLoad) {
    await pendingLoad;
    return language;
  }

  if (shouldLoadEnglishFallback(language) && !loadedResourceLanguages.has("en")) {
    await loadUiLanguageResources("en");
  }

  const load = Promise.all([loadTranslationBundle(language), loadPromptBundle(language)])
    .then(([translation, prompts]) => {
      addLanguageResources(language, translation as LocaleTree, prompts as unknown as LocaleTree);
    })
    .finally(() => {
      pendingResourceLoads.delete(language);
    });

  pendingResourceLoads.set(language, load);
  await load;
  return language;
}

const browserLanguage =
  typeof navigator !== "undefined" ? navigator.language || navigator.languages?.[0] : undefined;

const storageLanguage =
  typeof window !== "undefined" ? window.localStorage.getItem("uiLanguage") : undefined;

const mainProcessLanguage =
  typeof window !== "undefined" && typeof window.electronAPI?.getInitialUiLanguage === "function"
    ? window.electronAPI.getInitialUiLanguage()
    : undefined;

const initialLanguage = normalizeUiLanguage(
  mainProcessLanguage || storageLanguage || browserLanguage || "en"
);

applyDocumentDirection(initialLanguage);

async function loadInitialLanguage(): Promise<UiLanguage> {
  try {
    return await loadUiLanguageResources(initialLanguage);
  } catch (error) {
    if (initialLanguage === "en") {
      throw error;
    }
    console.error(`Failed to load UI locale "${initialLanguage}", falling back to English.`, error);
    return loadUiLanguageResources("en");
  }
}

const changeLanguage = i18n.changeLanguage.bind(i18n);

export const i18nReady = loadInitialLanguage().then(async (language) => {
  const resources = loadedResources.get(language);
  if (!resources) {
    throw new Error(`Missing loaded resources for UI locale "${language}".`);
  }

  await i18n.use(initReactI18next).init({
    resources: {
      [language]: resources,
    },
    lng: language,
    fallbackLng: "en",
    ns: ["translation", "prompts"],
    defaultNS: "translation",
    partialBundledLanguages: true,
    interpolation: {
      escapeValue: false,
    },
    returnEmptyString: false,
    returnNull: false,
  });

  i18n.changeLanguage = ((language?: string, callback?: Parameters<typeof changeLanguage>[1]) => {
    const normalized = normalizeUiLanguage(language || i18n.language || initialLanguage);
    return loadUiLanguageResources(normalized).then(() => changeLanguage(normalized, callback));
  }) as typeof i18n.changeLanguage;

  return i18n;
});

i18n.on("languageChanged", (lng) => {
  applyDocumentDirection(lng);
});

export default i18n;
