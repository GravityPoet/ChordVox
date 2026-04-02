import logger from "./logger";

const DEFAULT_NOTE_DURATION_SECONDS = 0.09;
const DEFAULT_NOTE_GAP_SECONDS = 0.025;
const DEFAULT_NOTE_ATTACK_SECONDS = 0.015;
const MIN_GAIN = 0.0001;

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

export const resumeContextIfNeeded = async () => {
  try {
    const context = getAudioContext();
    if (!context) {
      return null;
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    return context.state === "running" ? context : null;
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

  return "electronic";
};

const playCue = async (cueType) => {
  try {
    const style = getSelectedStyle();
    if (style === "off") return;

    const preset = CUE_PRESETS[style] || CUE_PRESETS.electronic;
    const notes = cueType === "start" ? preset.start : preset.stop;
    const context = await resumeContextIfNeeded();
    if (!context) {
      return;
    }

    const baseTime = context.currentTime + 0.005;
    notes.forEach((frequency, index) => {
      const noteStart = baseTime + index * (preset.durationSeconds + preset.gapSeconds);
      scheduleTone(context, frequency, noteStart, preset);
    });
  } catch (error) {
    logger.debug(
      "Failed to play dictation cue",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
  }
};

export const playStartCue = () => playCue("start");

export const playStopCue = () => playCue("stop");
