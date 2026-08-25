// Voice-activity thresholds + the pure "is this batch take silent" decision,
// extracted from AudioManager so the silent-batch cliff has a regression test
// that does NOT need the full AudioManager (which pulls in Electron, sqlite,
// network and reasoning services and can't load under a plain test runner).
//
// Background: a real but short / quiet spoken take whose total voiced time
// landed a few ms under the voiced-time floor used to be discarded as "silent"
// — the floating window flashed and vanished with nothing pasted. The peak
// escape hatch below keeps those takes. Keep this logic and AudioManager's
// shouldSuppressSilentBatchRecording in lockstep: AudioManager delegates here.

// Per-frame RMS at/above which a frame counts as "voiced".
export const VOICE_ACTIVITY_RMS_THRESHOLD = 0.012;
// Total voiced time (ms) a batch take must reach to count as speech. Kept low so
// short / quiet utterances that land just under the threshold aren't discarded.
export const MIN_VOICE_ACTIVITY_MS = 120;
// A clear RMS peak this far above the per-frame voice threshold means the take
// holds real speech even when total voiced time is brief; never suppress those.
export const BATCH_SPEECH_PEAK_RMS = 0.03;
// Small active-time floor so a lone transient pop / click (high peak, almost no
// voiced time) is still treated as silence rather than a real utterance.
export const BATCH_SPEECH_PEAK_MIN_ACTIVE_MS = 48;

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// True when total voiced time clears the speech floor.
export function hasMinVoiceActivity(stats) {
  return toNumber(stats?.activeMs) >= MIN_VOICE_ACTIVITY_MS;
}

// True when a brief take still shows an unmistakable speech peak (loud enough,
// and not just a single-frame transient). Real-but-short utterances survive here.
export function hasClearBatchSpeechPeak(stats) {
  return (
    toNumber(stats?.maxRms) >= BATCH_SPEECH_PEAK_RMS &&
    toNumber(stats?.activeMs) >= BATCH_SPEECH_PEAK_MIN_ACTIVE_MS
  );
}

// Pure mirror of AudioManager.shouldSuppressSilentBatchRecording (minus logging).
// Returns true only when a microphone batch take carries no usable speech and
// should be dropped before transcription.
//   - file imports are never suppressed (no live VAD samples to judge them by)
//   - no samples at all → can't prove silence → don't suppress
//   - enough voiced time, or a clear speech peak → real speech → don't suppress
export function shouldSuppressSilentBatch(stats, metadata = {}) {
  if (metadata?.sourceType === "file") {
    return false;
  }
  if (!stats || toNumber(stats.sampleCount) === 0) {
    return false;
  }
  if (hasMinVoiceActivity(stats)) {
    return false;
  }
  if (hasClearBatchSpeechPeak(stats)) {
    return false;
  }
  return true;
}
