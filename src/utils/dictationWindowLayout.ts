import dictationWindowLayout from "../config/dictationWindowLayout.json";
import {
  normalizeRecordingAnimationStyle,
  type RecordingAnimationStyleValue,
} from "./recordingAnimationStyle";

export interface DictationWindowSize {
  readonly width: number;
  readonly height: number;
}

const styleSizes = dictationWindowLayout.styles as Record<
  RecordingAnimationStyleValue,
  DictationWindowSize
>;

export function getDictationWindowSize(animationStyle: unknown): DictationWindowSize {
  const normalizedStyle = normalizeRecordingAnimationStyle(animationStyle);
  return styleSizes[normalizedStyle];
}
