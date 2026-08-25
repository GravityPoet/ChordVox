#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "src", "locales");
const FALLBACK_LANG = "en";
const REQUIRED_SOURCE_LANGS = ["en", "zh-CN"];
const NAMESPACES = ["translation", "prompts"];
const STRICT_LOCALES_ARG = "--strict-locales=";

function parseStrictLocales() {
  const rawArg = process.argv.slice(2).find((arg) => arg.startsWith(STRICT_LOCALES_ARG));
  const rawValue = rawArg
    ? rawArg.slice(STRICT_LOCALES_ARG.length)
    : process.env.CHORDVOX_I18N_STRICT_LOCALES || "";

  return new Set(
    rawValue
      .split(",")
      .map((lang) => lang.trim())
      .filter(Boolean)
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function flatten(obj, prefix = "") {
  const out = {};

  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value, next));
    } else {
      out[next] = value;
    }
  }

  return out;
}

function getPlaceholders(value) {
  if (typeof value !== "string") return [];
  const matches = value.match(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g) || [];
  return matches.map((match) => match.replace(/\{\{|\}\}/g, "").trim()).sort();
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const languages = fs
  .readdirSync(LOCALES_DIR)
  .filter((entry) => fs.statSync(path.join(LOCALES_DIR, entry)).isDirectory())
  .sort();
const strictLocales = parseStrictLocales();

let failed = false;
let missingWarnings = 0;
let extraWarnings = 0;

for (const lang of strictLocales) {
  if (REQUIRED_SOURCE_LANGS.includes(lang)) {
    continue;
  }
  if (!languages.includes(lang)) {
    console.error(`[i18n] Strict locale does not exist: ${lang}`);
    failed = true;
  }
}

for (const namespace of NAMESPACES) {
  const sourceFlats = {};

  for (const lang of REQUIRED_SOURCE_LANGS) {
    const sourceFile = path.join(LOCALES_DIR, lang, `${namespace}.json`);
    if (!fs.existsSync(sourceFile)) {
      console.error(`[i18n] Missing required source file: ${sourceFile}`);
      process.exit(1);
    }
    sourceFlats[lang] = flatten(readJson(sourceFile));
  }

  for (const lang of REQUIRED_SOURCE_LANGS) {
    const otherLang = REQUIRED_SOURCE_LANGS.find((candidate) => candidate !== lang);
    const currentFlat = sourceFlats[lang];
    const otherFlat = sourceFlats[otherLang];

    for (const key of Object.keys(currentFlat)) {
      if (!(key in otherFlat)) {
        console.error(
          `[i18n] Required source mismatch ${lang}/${namespace}: ${key} is missing in ${otherLang}/${namespace}`
        );
        failed = true;
        continue;
      }

      const currentPlaceholders = getPlaceholders(currentFlat[key]);
      const otherPlaceholders = getPlaceholders(otherFlat[key]);
      if (!arraysEqual(currentPlaceholders, otherPlaceholders)) {
        console.error(
          `[i18n] Placeholder mismatch ${lang}<->${otherLang}/${namespace}: ${key} (expected ${currentPlaceholders.join(", ")}, got ${otherPlaceholders.join(", ")})`
        );
        failed = true;
      }
    }
  }

  const fallbackFlat = sourceFlats[FALLBACK_LANG];

  for (const lang of languages) {
    if (REQUIRED_SOURCE_LANGS.includes(lang)) continue;

    const file = path.join(LOCALES_DIR, lang, `${namespace}.json`);
    if (!fs.existsSync(file)) {
      console.error(`[i18n] Missing file: ${file}`);
      failed = true;
      continue;
    }

    const flat = flatten(readJson(file));

    for (const key of Object.keys(fallbackFlat)) {
      if (!(key in flat)) {
        const message = `[i18n] Missing key ${lang}/${namespace}: ${key} (falls back to ${FALLBACK_LANG})`;
        if (strictLocales.has(lang)) {
          console.error(`${message} [strict locale]`);
          failed = true;
        } else {
          console.warn(message);
          missingWarnings += 1;
        }
        continue;
      }

      const basePlaceholders = getPlaceholders(fallbackFlat[key]);
      const langPlaceholders = getPlaceholders(flat[key]);
      if (!arraysEqual(basePlaceholders, langPlaceholders)) {
        console.error(
          `[i18n] Placeholder mismatch ${lang}/${namespace}: ${key} (expected ${basePlaceholders.join(", ")}, got ${langPlaceholders.join(", ")})`
        );
        failed = true;
      }
    }

    for (const key of Object.keys(flat)) {
      if (!(key in fallbackFlat)) {
        console.warn(
          `[i18n] Extra key ${lang}/${namespace}: ${key} (not present in ${FALLBACK_LANG})`
        );
        extraWarnings += 1;
      }
    }
  }
}

if (failed) {
  process.exit(1);
}

if (missingWarnings > 0 || extraWarnings > 0) {
  console.log(
    `[i18n] Required source locales are in sync. Placeholders are consistent. ${missingWarnings} missing locale entries will fall back to ${FALLBACK_LANG}. ${extraWarnings} extra locale entries should be cleaned up.`
  );
} else {
  console.log(
    "[i18n] Required source locales are in sync. Locale keys and placeholders are consistent."
  );
}
