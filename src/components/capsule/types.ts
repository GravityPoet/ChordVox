import type { RecordingAnimationStyleValue } from "../../utils/recordingAnimationStyle";

export type CapsuleState = "idle" | "starting" | "recording" | "processing" | "success" | "error";

export type AnimationStyle = RecordingAnimationStyleValue;

export type CapsuleTextMode = "batch-placeholder" | "streaming-placeholder" | "live";
