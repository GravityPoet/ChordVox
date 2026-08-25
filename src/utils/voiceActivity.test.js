import { describe, it, expect } from "vitest";
import {
  VOICE_ACTIVITY_RMS_THRESHOLD,
  MIN_VOICE_ACTIVITY_MS,
  BATCH_SPEECH_PEAK_RMS,
  BATCH_SPEECH_PEAK_MIN_ACTIVE_MS,
  hasMinVoiceActivity,
  hasClearBatchSpeechPeak,
  shouldSuppressSilentBatch,
} from "./voiceActivity";

// Build a voice-activity snapshot like AudioManager.getVoiceActivitySnapshot().
const snapshot = (overrides = {}) => ({
  sampleCount: 10,
  activeMs: 0,
  maxRms: 0,
  averageRms: 0,
  sumRms: 0,
  ...overrides,
});

describe("voiceActivity thresholds", () => {
  // Lock the tuned values so an accidental edit can't silently bring back the
  // cliff that discarded real speech.
  it("keeps the tuned threshold values", () => {
    expect(VOICE_ACTIVITY_RMS_THRESHOLD).toBe(0.012);
    expect(MIN_VOICE_ACTIVITY_MS).toBe(120);
    expect(BATCH_SPEECH_PEAK_RMS).toBe(0.03);
    expect(BATCH_SPEECH_PEAK_MIN_ACTIVE_MS).toBe(48);
  });
});

describe("hasMinVoiceActivity", () => {
  it("is true exactly at the floor (>=, not >)", () => {
    expect(hasMinVoiceActivity(snapshot({ activeMs: 120 }))).toBe(true);
  });

  it("is false just under the floor", () => {
    expect(hasMinVoiceActivity(snapshot({ activeMs: 119 }))).toBe(false);
  });

  it("treats missing/garbage activeMs as no activity", () => {
    expect(hasMinVoiceActivity(snapshot({ activeMs: undefined }))).toBe(false);
    expect(hasMinVoiceActivity(undefined)).toBe(false);
  });
});

describe("hasClearBatchSpeechPeak", () => {
  it("needs both a loud peak AND enough active time", () => {
    expect(hasClearBatchSpeechPeak(snapshot({ maxRms: 0.05, activeMs: 60 }))).toBe(true);
    // Loud but only a single-frame transient (pop/click) — not speech.
    expect(hasClearBatchSpeechPeak(snapshot({ maxRms: 0.05, activeMs: 30 }))).toBe(false);
    // Enough active time but quiet — not a clear peak.
    expect(hasClearBatchSpeechPeak(snapshot({ maxRms: 0.02, activeMs: 60 }))).toBe(false);
  });
});

describe("shouldSuppressSilentBatch", () => {
  // The regression that motivated this module: a real but short/quiet take whose
  // total voiced time lands under MIN_VOICE_ACTIVITY_MS used to be discarded as
  // silent, so the floating window flashed and nothing was pasted.
  it("keeps a short, clearly-voiced take that lands just under the voiced-time floor", () => {
    const realButBrief = snapshot({ maxRms: 0.0427, activeMs: 100 });
    expect(hasMinVoiceActivity(realButBrief)).toBe(false); // would have been dropped
    expect(shouldSuppressSilentBatch(realButBrief)).toBe(false); // now rescued by the peak
  });

  it("keeps a take with enough voiced time", () => {
    expect(shouldSuppressSilentBatch(snapshot({ activeMs: 176, maxRms: 0.0427 }))).toBe(false);
  });

  it("suppresses a genuinely silent take (quiet, almost no voiced time)", () => {
    expect(shouldSuppressSilentBatch(snapshot({ maxRms: 0.005, activeMs: 0 }))).toBe(true);
  });

  it("suppresses a lone transient pop (loud peak, too little active time)", () => {
    expect(shouldSuppressSilentBatch(snapshot({ maxRms: 0.08, activeMs: 30 }))).toBe(true);
  });

  it("does NOT suppress when there are no samples (no evidence of silence)", () => {
    expect(shouldSuppressSilentBatch(snapshot({ sampleCount: 0 }))).toBe(false);
    expect(shouldSuppressSilentBatch(null)).toBe(false);
  });

  it("never suppresses file imports regardless of levels", () => {
    const silentLevels = snapshot({ maxRms: 0, activeMs: 0 });
    expect(shouldSuppressSilentBatch(silentLevels, { sourceType: "file" })).toBe(false);
  });

  it("suppresses at the boundary just below the floor with no clear peak", () => {
    expect(shouldSuppressSilentBatch(snapshot({ activeMs: 119, maxRms: 0.02 }))).toBe(true);
  });
});
