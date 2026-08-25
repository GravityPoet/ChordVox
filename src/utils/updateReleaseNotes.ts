import type { TFunction } from "i18next";
import { normalizeUiLanguage } from "../i18n";

type ReleaseNotesLanguage = "en" | "zh-CN" | "zh-TW";

const MAX_NOTE_LINES = 5;

function getReleaseNotesLanguage(language: string | null | undefined): ReleaseNotesLanguage {
  const normalizedLanguage = normalizeUiLanguage(language);
  if (normalizedLanguage === "zh-TW") return "zh-TW";
  if (normalizedLanguage === "zh-CN") return "zh-CN";
  return "en";
}

function normalizeLine(line: string): string {
  return line
    .replace(/^\s{0,3}[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLanguageMarker(line: string, language: ReleaseNotesLanguage): boolean {
  const normalized = normalizeLine(line).toLowerCase();
  const markers: Record<ReleaseNotesLanguage, string[]> = {
    en: ["english", "en", "en-us"],
    "zh-CN": ["中文", "chinese", "zh-cn", "简体中文", "簡體中文", "简体", "simplified chinese"],
    "zh-TW": ["繁體中文", "繁体中文", "繁中", "zh-tw", "traditional chinese"],
  };
  return markers[language].includes(normalized);
}

function isOtherLanguageMarker(line: string, language: ReleaseNotesLanguage): boolean {
  return (["en", "zh-CN", "zh-TW"] as const).some(
    (candidate) => candidate !== language && isLanguageMarker(line, candidate)
  );
}

function isSectionHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim());
}

function isDownloadsOrInstallSection(line: string): boolean {
  const normalized = normalizeLine(line).toLowerCase();
  return (
    normalized.includes("downloads") ||
    normalized.includes("下载资源") ||
    normalized.includes("下載資源") ||
    normalized.includes("macos first launch") ||
    normalized.includes("首次启动") ||
    normalized.includes("首次啟動")
  );
}

function looksTraditionalChinese(line: string): boolean {
  return /[體臺後啟語錄優態穩裝線點據遷週期檢續應關開與這個為讓會過時]/.test(line);
}

function isRelevantReleaseLine(line: string, language: ReleaseNotesLanguage): boolean {
  const normalized = normalizeLine(line);
  if (!normalized || normalized.length < 8) return false;
  if (isLanguageMarker(normalized, language) || isOtherLanguageMarker(normalized, language)) {
    return false;
  }
  if (isSectionHeading(normalized) || /^```/.test(normalized)) return false;
  if (/^`?ChordVox-[\w.-]+`?$/.test(normalized)) return false;
  if (/^xattr\s|^open\s\/Applications/i.test(normalized)) return false;

  const lower = normalized.toLowerCase();
  if (
    lower.includes("latest-mac.yml") ||
    lower.includes("latest-linux.yml") ||
    lower.includes("blockmap") ||
    lower.includes("additional updater metadata") ||
    normalized.includes("自动更新元数据")
  ) {
    return false;
  }

  return true;
}

function extractLanguageBlock(notes: string, language: ReleaseNotesLanguage): string[] {
  const lines = notes.replace(/\r\n?/g, "\n").split("\n");
  const collected: string[] = [];
  let inRequestedLanguage = false;
  let inSkippedSection = false;

  for (const line of lines) {
    if (isSectionHeading(line)) {
      inSkippedSection = isDownloadsOrInstallSection(line);
      inRequestedLanguage = false;
      continue;
    }

    if (isLanguageMarker(line, language)) {
      inRequestedLanguage = !inSkippedSection;
      continue;
    }

    if (isOtherLanguageMarker(line, language)) {
      inRequestedLanguage = false;
      continue;
    }

    if (!inRequestedLanguage || inSkippedSection) {
      continue;
    }

    if (isRelevantReleaseLine(line, language)) {
      collected.push(normalizeLine(line));
    }
  }

  return collected;
}

function extractHeuristicLines(notes: string, language: ReleaseNotesLanguage): string[] {
  const lines = notes.replace(/\r\n?/g, "\n").split("\n");

  return lines.map(normalizeLine).filter((line) => {
    if (!isRelevantReleaseLine(line, language)) return false;
    const hasChinese = /[\u3400-\u9fff]/.test(line);
    if (language === "en") return !hasChinese;
    if (language === "zh-TW") return looksTraditionalChinese(line);
    return hasChinese && !looksTraditionalChinese(line);
  });
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }

  return result;
}

export function getLocalizedReleaseNoteItems(
  releaseNotes: string | null | undefined,
  language: string | null | undefined,
  fallbackItems: string[]
): string[] {
  const normalizedNotes = typeof releaseNotes === "string" ? releaseNotes.trim() : "";
  const releaseNotesLanguage = getReleaseNotesLanguage(language);

  const extracted = normalizedNotes
    ? [
        ...extractLanguageBlock(normalizedNotes, releaseNotesLanguage),
        ...extractHeuristicLines(normalizedNotes, releaseNotesLanguage),
      ]
    : [];

  const items = uniqueLines(extracted).slice(0, MAX_NOTE_LINES);
  return items.length > 0 ? items : fallbackItems;
}

export function buildLocalizedUpdateDescription({
  t,
  language,
  version,
  releaseNotes,
}: {
  t: TFunction;
  language: string | null | undefined;
  version?: string | null;
  releaseNotes?: string | null;
}): string {
  const fallbackItems = t("settingsPage.general.updates.dialogs.updateAvailable.fallbackItems", {
    returnObjects: true,
  });
  const fallbackList = Array.isArray(fallbackItems)
    ? fallbackItems.filter((item): item is string => typeof item === "string")
    : [];
  const items = getLocalizedReleaseNoteItems(releaseNotes, language, fallbackList);
  const bulletList = items.map((item) => `• ${item}`).join("\n");

  return [
    t("settingsPage.general.updates.dialogs.updateAvailable.description", {
      version: version || t("settingsPage.general.updates.newVersion"),
    }),
    t("settingsPage.general.updates.dialogs.updateAvailable.valueIntro"),
    bulletList,
  ]
    .filter(Boolean)
    .join("\n\n");
}
