export type DictationOverlayPrimaryAction =
  | "stop-recording"
  | "cancel-start"
  | "cancel-paste"
  | "cancel-processing"
  | "toggle-listening";

interface DictationOverlayPrimaryActionState {
  readonly isRecording: boolean;
  readonly isStreaming: boolean;
  readonly isStarting: boolean;
  readonly isProcessing: boolean;
  readonly isPastePending: boolean;
}

export function getDictationOverlayPrimaryAction({
  isRecording,
  isStreaming,
  isStarting,
  isProcessing,
  isPastePending,
}: DictationOverlayPrimaryActionState): DictationOverlayPrimaryAction {
  if (isRecording || isStreaming) {
    return "stop-recording";
  }
  if (isStarting) {
    return "cancel-start";
  }
  if (isPastePending) {
    return "cancel-paste";
  }
  if (isProcessing) {
    return "cancel-processing";
  }
  return "toggle-listening";
}
