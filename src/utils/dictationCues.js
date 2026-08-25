import logger from "./logger";

const DEFAULT_NOTE_DURATION_SECONDS = 0.09;
const DEFAULT_NOTE_GAP_SECONDS = 0.025;
const DEFAULT_NOTE_ATTACK_SECONDS = 0.015;
const MIN_GAIN = 0.0001;
// A cue is optional feedback, never a prerequisite for opening the
// microphone.  Electron/macOS can leave AudioContext.resume() pending when a
// hotkey starts a window that has no user gesture, so keep the wait bounded.
export const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 750;

const CUE_PRESETS = {
  electronic: {
    oscillatorType: "sine",
    start: [523.25, 659.25],
    stop: [587.33, 440],
    durationSeconds: DEFAULT_NOTE_DURATION_SECONDS,
    gapSeconds: DEFAULT_NOTE_GAP_SECONDS,
    attackSeconds: DEFAULT_NOTE_ATTACK_SECONDS,
    maxGain: 0.2,
  },
  droplet1: {
    oscillatorType: "triangle",
    start: [783.99, 1174.66],
    stop: [1174.66, 783.99],
    durationSeconds: 0.08,
    gapSeconds: 0.02,
    attackSeconds: 0.01,
    maxGain: 0.16,
  },
  droplet2: {
    oscillatorType: "sine",
    start: [659.25, 880, 1174.66],
    stop: [987.77, 739.99, 523.25],
    durationSeconds: 0.065,
    gapSeconds: 0.018,
    attackSeconds: 0.008,
    maxGain: 0.13,
  },
};

let audioContext = null;

const wait = (durationMs, signal) =>
  new Promise((resolve) => {
    let settled = false;
    let timerId = null;

    const finish = (completed) => {
      if (settled) return;
      settled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      signal?.removeEventListener?.("abort", handleAbort);
      resolve(completed);
    };

    const handleAbort = () => finish(false);
    if (signal?.aborted) {
      finish(false);
      return;
    }

    signal?.addEventListener?.("abort", handleAbort, { once: true });
    timerId = window.setTimeout(() => finish(true), durationMs);
  });

const settleWithTimeout = (promise, { timeoutMs, signal }) =>
  new Promise((resolve) => {
    let settled = false;
    let timerId = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      signal?.removeEventListener?.("abort", handleAbort);
      resolve(result);
    };

    const handleAbort = () => finish({ status: "aborted" });
    if (signal?.aborted) {
      finish({ status: "aborted" });
      return;
    }

    signal?.addEventListener?.("abort", handleAbort, { once: true });
    timerId = window.setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    Promise.resolve(promise).then(
      (value) => finish({ status: "resolved", value }),
      (error) => finish({ status: "rejected", error })
    );
  });

const getCueDurationMs = (notes, preset) => {
  const noteCount = Array.isArray(notes) ? notes.length : 0;
  if (noteCount <= 0) return 0;
  const noteDurationMs = noteCount * preset.durationSeconds * 1000;
  const gapDurationMs = Math.max(0, noteCount - 1) * preset.gapSeconds * 1000;
  return Math.ceil(noteDurationMs + gapDurationMs + 20);
};

const getAudioContext = () => {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContextCtor();
  }

  return audioContext;
};

export const resumeContextIfNeeded = async ({
  signal,
  timeoutMs = AUDIO_CONTEXT_RESUME_TIMEOUT_MS,
} = {}) => {
  try {
    if (signal?.aborted) {
      return null;
    }

    const context = getAudioContext();
    if (!context) {
      return null;
    }

    if (context.state === "suspended") {
      const result = await settleWithTimeout(context.resume(), { timeoutMs, signal });
      if (result.status === "aborted" || result.status === "timeout") {
        if (result.status === "timeout") {
          logger.debug(
            "Timed out while resuming dictation cue audio context",
            { timeoutMs },
            "audio"
          );
        }
        return null;
      }
      if (result.status === "rejected") {
        throw result.error;
      }
    }

    return !signal?.aborted && context.state === "running" ? context : null;
  } catch (error) {
    logger.debug(
      "Failed to initialize dictation cue audio context",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
    return null;
  }
};

const scheduleTone = (context, frequency, startTime, preset) => {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const stopTime = startTime + preset.durationSeconds;

  oscillator.type = preset.oscillatorType;
  oscillator.frequency.setValueAtTime(frequency, startTime);

  gainNode.gain.setValueAtTime(MIN_GAIN, startTime);
  gainNode.gain.linearRampToValueAtTime(preset.maxGain, startTime + preset.attackSeconds);
  gainNode.gain.exponentialRampToValueAtTime(MIN_GAIN, stopTime);

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);

  oscillator.start(startTime);
  oscillator.stop(stopTime + 0.01);
  return oscillator;
};

const isEnabled = () => localStorage.getItem("audioCuesEnabled") !== "false";

const getSelectedStyle = () => {
  if (!isEnabled()) {
    return "off";
  }

  const style = localStorage.getItem("dictationCueStyle");
  if (style === "droplet1" || style === "droplet2" || style === "electronic") {
    return style;
  }

  return "droplet1";
};

const playCue = async (cueType, options = {}) => {
  try {
    const signal = options?.signal;
    if (signal?.aborted) return false;

    const style = getSelectedStyle();
    if (style === "off") return false;

    const preset = CUE_PRESETS[style] || CUE_PRESETS.droplet1;
    const notes = cueType === "start" ? preset.start : preset.stop;
    const context = await resumeContextIfNeeded({ signal });
    if (!context) {
      return false;
    }

    const baseTime = context.currentTime + 0.005;
    const oscillators = notes.map((frequency, index) => {
      const noteStart = baseTime + index * (preset.durationSeconds + preset.gapSeconds);
      return scheduleTone(context, frequency, noteStart, preset);
    });

    if (options.waitForEnd) {
      const completed = await wait(getCueDurationMs(notes, preset), signal);
      if (!completed) {
        oscillators.forEach((oscillator) => {
          try {
            oscillator.stop(context.currentTime);
          } catch {
            // The oscillator may already have reached its scheduled stop.
          }
        });
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.debug(
      "Failed to play dictation cue",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
    return false;
  }
};

export const playStartCue = (options) => playCue("start", options);

export const playStopCue = () => playCue("stop");
