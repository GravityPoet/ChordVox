import { useState } from "react";

const AGENT_NAME_KEY = "agentName";
const DICTIONARY_KEY = "customDictionary";
const DEFAULT_AGENT_NAME = "Chord";
const LEGACY_BRAND_BASE = ["open", "whispr"].join("");
const LEGACY_BRAND_SPACED = ["open", "whispr"].join(" ");
const LEGACY_AGENT_NAMES = new Set([
  "chordvox",
  "chord vox",
  "ariakey",
  "whispr",
  LEGACY_BRAND_BASE,
  LEGACY_BRAND_SPACED,
  "moonlitvoice",
  "moonlit voice",
]);

function isLegacyAgentName(name: string): boolean {
  return LEGACY_AGENT_NAMES.has(name.trim().toLowerCase());
}

function normalizeAgentName(name: string | null): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return DEFAULT_AGENT_NAME;
  if (isLegacyAgentName(trimmed)) return DEFAULT_AGENT_NAME;
  return trimmed;
}

export const getAgentName = (): string => {
  const stored = localStorage.getItem(AGENT_NAME_KEY);
  const normalized = normalizeAgentName(stored);
  if ((stored || "").trim() !== normalized) {
    localStorage.setItem(AGENT_NAME_KEY, normalized);
  }
  return normalized;
};

function syncAgentNameToDictionary(newName: string, oldName?: string): void {
  let dictionary: string[] = [];
  try {
    const raw = localStorage.getItem(DICTIONARY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) dictionary = parsed;
    }
  } catch {
    // ignore
  }

  // Remove old agent name if it changed
  if (oldName && oldName !== newName) {
    dictionary = dictionary.filter((w) => w !== oldName);
  }
  dictionary = dictionary.filter((w) => !isLegacyAgentName(w));

  // Add new name at the front if not already present
  const trimmed = newName.trim();
  if (trimmed && !dictionary.includes(trimmed)) {
    dictionary = [trimmed, ...dictionary];
  }

  localStorage.setItem(DICTIONARY_KEY, JSON.stringify(dictionary));

  // Best-effort sync to SQLite
  window.electronAPI?.setDictionary?.(dictionary).catch(() => {});
}

export const setAgentName = (name: string): void => {
  const oldName = localStorage.getItem(AGENT_NAME_KEY) || "";
  const trimmed = normalizeAgentName(name);
  localStorage.setItem(AGENT_NAME_KEY, trimmed);
  syncAgentNameToDictionary(trimmed, oldName);
};

export const ensureAgentNameInDictionary = (): void => {
  const name = getAgentName();
  if (name) syncAgentNameToDictionary(name);
};

export const useAgentName = () => {
  const [agentName, setAgentNameState] = useState<string>(getAgentName());

  const updateAgentName = (name: string) => {
    const normalized = normalizeAgentName(name);
    setAgentName(normalized);
    setAgentNameState(normalized);
  };

  return { agentName, setAgentName: updateAgentName };
};
