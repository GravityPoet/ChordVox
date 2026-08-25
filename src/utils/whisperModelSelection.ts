import { WHISPER_MODEL_INFO } from "../models/ModelRegistry";

const REMOVED_WHISPER_MODEL_IDS = new Set(["tiny", "base", "small", "medium"]);

export const DEFAULT_WHISPER_MODEL_ID = WHISPER_MODEL_INFO.turbo
  ? "turbo"
  : Object.keys(WHISPER_MODEL_INFO)[0] || "large";

function isCustomWhisperModelPath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.endsWith(".bin");
}

export function normalizeWhisperModelId(modelId: string | null | undefined): string {
  const raw = String(modelId || "").trim();
  if (!raw) return DEFAULT_WHISPER_MODEL_ID;
  if (isCustomWhisperModelPath(raw)) return raw;
  if (WHISPER_MODEL_INFO[raw]) return raw;
  if (REMOVED_WHISPER_MODEL_IDS.has(raw)) return DEFAULT_WHISPER_MODEL_ID;
  return DEFAULT_WHISPER_MODEL_ID;
}
