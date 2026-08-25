function isE2eMode(app, env = process.env) {
  return env.CHORDVOX_E2E === "1" && !app.isPackaged;
}

function getE2eStubTranscriptionText(env = process.env) {
  return env.CHORDVOX_E2E_TRANSCRIPTION_TEXT || "ChordVox E2E stub transcription.";
}

function createE2eEventRecorder(enabled, target = globalThis) {
  return function recordE2eEvent(type, payload = {}) {
    if (!enabled) return;
    if (!Array.isArray(target.__CHORDVOX_E2E_EVENTS)) {
      target.__CHORDVOX_E2E_EVENTS = [];
    }
    target.__CHORDVOX_E2E_EVENTS.push({
      type,
      payload,
      at: Date.now(),
    });
  };
}

module.exports = {
  createE2eEventRecorder,
  getE2eStubTranscriptionText,
  isE2eMode,
};
