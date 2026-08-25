// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("AudioManager transcription lease", () => {
  let owner = null;

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

  beforeEach(() => {
    owner = null;
    storage.clear();
    window.electronAPI = {
      acquireTranscriptionLease: vi.fn(async ({ leaseId }) => {
        if (owner && owner !== leaseId) {
          return { success: false, code: "TRANSCRIPTION_BUSY" };
        }
        const acquired = owner === null;
        owner = leaseId;
        return { success: true, leaseId, acquired };
      }),
      releaseTranscriptionLease: vi.fn(async (leaseId) => {
        if (owner !== leaseId) {
          return { success: false, code: "LEASE_NOT_OWNED" };
        }
        owner = null;
        return { success: true, released: true };
      }),
      assemblyAiStreamingStop: vi.fn(async () => ({ success: true })),
      deepgramStreamingStop: vi.fn(async () => ({ success: true })),
      sherpaStreamingStop: vi.fn(async () => ({ success: true })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  it("prevents independent managers from running transcription concurrently", async () => {
    const first = new AudioManager();
    const second = new AudioManager();

    await expect(first.acquireTranscriptionLease("file")).resolves.toBe(true);
    await expect(second.acquireTranscriptionLease("batch")).rejects.toMatchObject({
      code: "TRANSCRIPTION_BUSY",
    });

    await first.releaseTranscriptionLease();
    await expect(second.acquireTranscriptionLease("batch")).resolves.toBe(true);
    await second.releaseTranscriptionLease();
  });

  it("does not let a cancelled manager start a replacement before release finishes", async () => {
    const manager = new AudioManager();
    await manager.acquireTranscriptionLease("file");
    manager.markTranscriptionLeaseCancelling();

    await expect(manager.acquireTranscriptionLease("file")).rejects.toMatchObject({
      code: "TRANSCRIPTION_STOPPING",
    });

    await manager.releaseTranscriptionLease();
  });

  it("publishes recording readiness only after the transcription lease is released", async () => {
    let finishRelease;
    window.electronAPI.releaseTranscriptionLease = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRelease = resolve;
        })
    );
    const manager = new AudioManager();
    const states = [];
    manager.setCallbacks({ onStateChange: (state) => states.push(state) });
    await manager.acquireTranscriptionLease("batch");

    const releasePromise = manager.releaseTranscriptionLease();
    expect(manager.getState().isReadyForRecordingStart).toBe(false);
    expect(states).toHaveLength(0);

    finishRelease({ success: true, released: true });
    await releasePromise;

    expect(manager.getState().isReadyForRecordingStart).toBe(true);
    expect(states.at(-1)).toEqual(
      expect.objectContaining({
        isRecording: false,
        isProcessing: false,
        isReadyForRecordingStart: true,
        stage: "idle",
      })
    );
  });

  it("resets stale microphone, streaming, and lease state after system resume", async () => {
    const manager = new AudioManager();
    await manager.acquireTranscriptionLease("batch");
    const closeAudioContext = vi.fn(async () => undefined);
    manager.cachedMicDeviceId = "stale-device";
    manager.isRecording = true;
    manager.isStreaming = true;
    manager.persistentAudioContext = {
      state: "suspended",
      close: closeAudioContext,
    };

    const result = await manager.resetAfterSystemPowerChange();

    expect(result).toEqual({ interrupted: true });
    expect(manager.cachedMicDeviceId).toBeNull();
    expect(manager.isRecording).toBe(false);
    expect(manager.isStreaming).toBe(false);
    expect(closeAudioContext).toHaveBeenCalledOnce();
    expect(window.electronAPI.assemblyAiStreamingStop).toHaveBeenCalledOnce();
    expect(window.electronAPI.deepgramStreamingStop).toHaveBeenCalledOnce();
    expect(window.electronAPI.sherpaStreamingStop).toHaveBeenCalledOnce();
    expect(owner).toBeNull();
  });
});
