// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { playStartCue, resumeContextIfNeeded } from "./dictationCues";

const createdContexts: Array<{ state: string }> = [];
const storage = new Map<string, string>();

class MockAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {
    this.state = "running";
  });
  oscillators: Array<{ stop: ReturnType<typeof vi.fn> }> = [];

  constructor() {
    createdContexts.push(this);
  }

  createOscillator() {
    const oscillator = {
      type: "sine",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
  }
}

describe("dictation cue startup safety", () => {
  beforeEach(() => {
    createdContexts.forEach((context) => {
      context.state = "closed";
    });
    storage.clear();
    const localStorageMock = {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
    localStorage.setItem("audioCuesEnabled", "true");
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: MockAudioContext,
    });
    vi.useRealTimers();
  });

  it("returns after a bounded timeout when AudioContext.resume never settles", async () => {
    const context = new MockAudioContext();
    context.state = "suspended";
    context.resume = vi.fn(() => new Promise(() => {}));
    // The module creates its own context; make the next constructor return the
    // hanging instance so the test controls the exact resume promise.
    const OriginalAudioContext = window.AudioContext;
    class HangingAudioContext extends MockAudioContext {
      constructor() {
        super();
        this.state = context.state;
        this.resume = context.resume;
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: HangingAudioContext,
    });

    vi.useFakeTimers();
    const pending = resumeContextIfNeeded({ timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    expect(await pending).toBeNull();
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: OriginalAudioContext,
    });
  });

  it("aborts a cue immediately without blocking recording startup", async () => {
    const controller = new AbortController();
    const pending = playStartCue({ waitForEnd: true, signal: controller.signal });

    controller.abort();

    await expect(pending).resolves.toBe(false);
  });
});
