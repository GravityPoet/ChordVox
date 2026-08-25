// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";

// Regression coverage for the stop -> onstop flush gap: a cancel that lands
// after mediaRecorder.stop() but before onstop must survive until onstop and
// prevent processAudio from resurrecting the cancelled session.

let AudioManager;

const storage = new (class {
  constructor() {
    this.data = new Map();
  }
  getItem(key) {
    return this.data.get(key) ?? null;
  }
  setItem(key, value) {
    this.data.set(key, String(value));
  }
  removeItem(key) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
})();

function enterFlushGap(manager, recorder) {
  // stopRecording() already ran: recorder is inactive, processing is flagged,
  // but processAudio has not created an abort controller or operation id yet.
  manager.mediaRecorder = recorder;
  manager.isProcessing = true;
  manager.isRecording = false;
  manager.processingAbortController = null;
  manager.activeTranscriptionOperationId = null;
}

describe("AudioManager batch cancel in the stop -> onstop gap", () => {
  beforeAll(async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    AudioManager = (await import("./audioManager")).default;
  });

  it("marks the recorder on a gap cancel and settles to idle when onstop consumes it", () => {
    const manager = new AudioManager();
    const recorder = { state: "inactive" };
    enterFlushGap(manager, recorder);

    expect(manager.cancelProcessing()).toBe(true);
    expect(manager.batchCancelBeforeFlushRecorder).toBe(recorder);

    // The mark survives until onstop consumes it exactly once.
    manager.audioChunks = [new Blob(["stale"])];
    expect(manager.consumeBatchCancelBeforeFlush(recorder)).toBe(true);
    expect(manager.batchCancelBeforeFlushRecorder).toBe(null);
    expect(manager.isProcessing).toBe(false);
    expect(manager.isRecording).toBe(false);
    expect(manager.audioChunks).toEqual([]);
    expect(manager.consumeBatchCancelBeforeFlush(recorder)).toBe(false);
  });

  it("does not mark the recorder when a live processing session is cancelled", () => {
    const manager = new AudioManager();
    const recorder = { state: "inactive" };
    enterFlushGap(manager, recorder);
    // processAudio is already running: it owns an abort controller.
    manager.processingAbortController = new AbortController();

    expect(manager.cancelProcessing()).toBe(true);
    expect(manager.batchCancelBeforeFlushRecorder).toBe(null);
    expect(manager.consumeBatchCancelBeforeFlush(recorder)).toBe(false);
  });

  it("ignores a consume from a recorder that was never marked", () => {
    const manager = new AudioManager();
    const markedRecorder = { state: "inactive" };
    enterFlushGap(manager, markedRecorder);
    manager.cancelProcessing();
    expect(manager.batchCancelBeforeFlushRecorder).toBe(markedRecorder);

    const otherRecorder = { state: "inactive" };
    expect(manager.consumeBatchCancelBeforeFlush(otherRecorder)).toBe(false);
    expect(manager.batchCancelBeforeFlushRecorder).toBe(markedRecorder);
  });
});
