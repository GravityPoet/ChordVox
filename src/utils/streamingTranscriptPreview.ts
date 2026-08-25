import type { RecordingAnimationStyleValue } from "./recordingAnimationStyle";

type DictationStage =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "polishing"
  | "pasting"
  | "completed";

interface StreamingTranscriptPreviewState {
  animationStyle: RecordingAnimationStyleValue;
  dictationStage: DictationStage;
  isRecording: boolean;
  isStreaming: boolean;
}

export function shouldShowNebulaStreamingPreview({
  animationStyle,
  dictationStage,
  isRecording,
  isStreaming,
}: StreamingTranscriptPreviewState): boolean {
  return (
    animationStyle === "nebula" && dictationStage === "recording" && isRecording && isStreaming
  );
}
