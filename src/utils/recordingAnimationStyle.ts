export const RECORDING_ANIMATION_STYLE_VALUES = ["flow", "stardust", "nebula"] as const;

export type RecordingAnimationStyleValue = (typeof RECORDING_ANIMATION_STYLE_VALUES)[number];

export const DEFAULT_RECORDING_ANIMATION_STYLE: RecordingAnimationStyleValue = "nebula";

const LEGACY_RECORDING_ANIMATION_STYLE_MAP: Record<string, RecordingAnimationStyleValue> = {
  level: "flow",
  line: "flow",
  particles: "stardust",
  liquid: "flow",
  flow: "flow",
  stardust: "stardust",
  nebula: "nebula",
  planet: "nebula",
};

export function normalizeRecordingAnimationStyle(value: unknown): RecordingAnimationStyleValue {
  if (typeof value !== "string") {
    return DEFAULT_RECORDING_ANIMATION_STYLE;
  }

  return LEGACY_RECORDING_ANIMATION_STYLE_MAP[value] ?? DEFAULT_RECORDING_ANIMATION_STYLE;
}

export function isRecordingAnimationStyleValue(
  value: unknown
): value is RecordingAnimationStyleValue {
  return RECORDING_ANIMATION_STYLE_VALUES.includes(value as RecordingAnimationStyleValue);
}
