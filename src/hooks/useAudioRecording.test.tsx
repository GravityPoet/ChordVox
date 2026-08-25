// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useAudioRecording } from "./useAudioRecording";
import { playStartCue } from "../utils/dictationCues";

type AudioRecordingHook = ReturnType<typeof useAudioRecording>;
type MockAudioManagerCallbacks = {
  onStateChange: (state: unknown) => void;
  onError: (error: unknown) => void;
  onTranscriptionComplete: (result: unknown) => Promise<unknown>;
};
type MockAudioManager = {
  callbacks: MockAudioManagerCallbacks | null;
  setCallbacks: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  shouldUseLocalStreaming: ReturnType<typeof vi.fn>;
  shouldUseStreaming: ReturnType<typeof vi.fn>;
  setActiveHotkeyProfile: ReturnType<typeof vi.fn>;
  startLocalStreamingRecording: ReturnType<typeof vi.fn>;
  stopLocalStreamingRecording: ReturnType<typeof vi.fn>;
  startStreamingRecording: ReturnType<typeof vi.fn>;
  stopStreamingRecording: ReturnType<typeof vi.fn>;
  getLastLocalStreamingStartFailure: ReturnType<typeof vi.fn>;
  resolveLocalStreamingBatchFallbackRoute: ReturnType<typeof vi.fn>;
  setNextBatchFallbackRoute: ReturnType<typeof vi.fn>;
  clearNextBatchFallbackRoute: ReturnType<typeof vi.fn>;
  startRecording: ReturnType<typeof vi.fn>;
  stopRecording: ReturnType<typeof vi.fn>;
  cancelRecording: ReturnType<typeof vi.fn>;
  cancelProcessing: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  warmupStreamingConnection: ReturnType<typeof vi.fn>;
  safePaste: ReturnType<typeof vi.fn>;
  saveTranscription: ReturnType<typeof vi.fn>;
};

// Define mock instances to control AudioManager behavior in tests
let mockAudioManagerInstance: MockAudioManager | null = null;

function mockRequireAudioManager(): MockAudioManager {
  const instance = mockAudioManagerInstance;
  if (instance === null) {
    throw new Error("Expected AudioManager to be constructed before use");
  }
  return instance;
}

function mockRequireCallbacks(): MockAudioManagerCallbacks {
  const callbacks = mockRequireAudioManager().callbacks;
  if (callbacks === null) {
    throw new Error("Expected AudioManager callbacks to be registered before use");
  }
  return callbacks;
}
// Counts AudioManager constructions so a test can assert the mount-once effect
// builds it exactly once despite volatile prop/callback identity churn. Must be
// `mock`-prefixed to be referenceable from the hoisted vi.mock factory.
let mockAudioManagerConstructCount = 0;

vi.mock("../helpers/audioManager", () => {
  return {
    default: function () {
      mockAudioManagerConstructCount += 1;
      mockAudioManagerInstance = {
        callbacks: null,
        setCallbacks: vi.fn().mockImplementation((c: MockAudioManagerCallbacks) => {
          mockRequireAudioManager().callbacks = c;
        }),
        getState: vi.fn().mockReturnValue({
          isRecording: false,
          isProcessing: false,
          isReadyForRecordingStart: true,
        }),
        shouldUseLocalStreaming: vi.fn().mockReturnValue(false),
        shouldUseStreaming: vi.fn().mockReturnValue(false),
        setActiveHotkeyProfile: vi.fn(),
        startLocalStreamingRecording: vi.fn().mockResolvedValue(true),
        stopLocalStreamingRecording: vi.fn().mockResolvedValue(true),
        startStreamingRecording: vi.fn().mockResolvedValue(true),
        stopStreamingRecording: vi.fn().mockResolvedValue(true),
        getLastLocalStreamingStartFailure: vi.fn().mockReturnValue(null),
        resolveLocalStreamingBatchFallbackRoute: vi.fn().mockResolvedValue(null),
        setNextBatchFallbackRoute: vi.fn(),
        clearNextBatchFallbackRoute: vi.fn(),
        startRecording: vi.fn().mockResolvedValue(true),
        stopRecording: vi.fn().mockResolvedValue(true),
        cancelRecording: vi.fn().mockResolvedValue(true),
        cancelProcessing: vi.fn().mockResolvedValue(true),
        cleanup: vi.fn(),
        warmupStreamingConnection: vi.fn(),
        safePaste: vi.fn().mockResolvedValue(true),
        saveTranscription: vi.fn().mockResolvedValue(true),
      };
      return mockAudioManagerInstance;
    },
  };
});

// Mock i18next translation
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock logger
vi.mock("../utils/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock audio cues
vi.mock("../utils/dictationCues", () => ({
  playStartCue: vi.fn(),
  playStopCue: vi.fn(),
}));

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const mockStorage = new MemoryStorage();

// Test helper component to invoke hook
function TestComponent({
  onHookReady,
  toast,
  options,
}: {
  onHookReady: (value: AudioRecordingHook) => void;
  toast: ReturnType<typeof vi.fn>;
  options?: Record<string, unknown>;
}) {
  const hookVal = useAudioRecording(toast, options);
  onHookReady(hookVal);
  return null;
}

describe("useAudioRecording hook", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  let hookVal: AudioRecordingHook | null = null;
  let toggleCallback: ((payload?: { profileId?: string }) => Promise<unknown>) | null = null;
  let stopCallback: (() => void) | null = null;
  let noAudioCallback: (() => void) | null = null;

  const requireHook = (): AudioRecordingHook => {
    const hook = hookVal;
    if (hook === null) {
      throw new Error("Expected useAudioRecording to render before inspection");
    }
    return hook;
  };

  const mockElectronAPI = {
    getPlatform: vi.fn().mockReturnValue("darwin"),
    onToggleDictation: vi.fn().mockImplementation((cb) => {
      toggleCallback = cb;
      return vi.fn(); // dispose mock
    }),
    onStartDictation: vi.fn().mockReturnValue(vi.fn()),
    onStopDictation: vi.fn().mockImplementation((cb) => {
      stopCallback = cb;
      return vi.fn();
    }),
    onSecondaryHotkeyLocked: vi.fn().mockReturnValue(vi.fn()),
    onNoAudioDetected: vi.fn().mockImplementation((cb) => {
      noAudioCallback = cb;
      return vi.fn();
    }),
    openMicrophoneSettings: vi.fn().mockResolvedValue({ success: true }),
    openSoundInputSettings: vi.fn().mockResolvedValue({ success: true }),
    openAccessibilitySettings: vi.fn().mockResolvedValue({ success: true }),
    requestAccessibilityPermission: vi.fn().mockResolvedValue({ success: true }),
    trackOnboardingEvent: vi.fn().mockResolvedValue({ success: true, recorded: true }),
    licenseGetStatus: vi.fn().mockResolvedValue({
      success: true,
      status: "unlicensed",
      isActive: false,
    }),
    getTranscriptionStats: vi.fn().mockResolvedValue({ totalEntries: 0 }),
    openControlPanelSection: vi.fn().mockResolvedValue({ success: true }),
    hideWindow: vi.fn(),
  };

  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(window, "electronAPI", {
      value: mockElectronAPI,
      writable: true,
    });
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockStorage.clear();
    mockAudioManagerInstance = null;
    hookVal = null;
    toggleCallback = null;
    stopCallback = null;
    noAudioCallback = null;
    mockAudioManagerConstructCount = 0;

    mockElectronAPI.getPlatform.mockClear();
    mockElectronAPI.onToggleDictation.mockClear();
    mockElectronAPI.onStopDictation.mockClear();
    mockElectronAPI.onNoAudioDetected.mockClear();
    mockElectronAPI.openMicrophoneSettings.mockClear();
    mockElectronAPI.openSoundInputSettings.mockClear();
    mockElectronAPI.openAccessibilitySettings.mockClear();
    mockElectronAPI.trackOnboardingEvent.mockClear();
    mockElectronAPI.licenseGetStatus.mockClear();
    mockElectronAPI.licenseGetStatus.mockResolvedValue({
      success: true,
      status: "unlicensed",
      isActive: false,
    });
    mockElectronAPI.getTranscriptionStats.mockClear();
    mockElectronAPI.getTranscriptionStats.mockResolvedValue({ totalEntries: 0 });
    mockElectronAPI.openControlPanelSection.mockClear();
    mockElectronAPI.openControlPanelSection.mockResolvedValue({ success: true });
    mockElectronAPI.hideWindow.mockClear();
    vi.mocked(playStartCue).mockReset();
    vi.mocked(playStartCue).mockResolvedValue(true);
  });

  it("falls back to batch recording after a recoverable local streaming startup error", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    const manager = mockRequireAudioManager();
    manager.shouldUseLocalStreaming.mockReturnValue(true);
    manager.getLastLocalStreamingStartFailure.mockReturnValue({
      title: "Local Streaming Error",
      description: "model unavailable",
      error: "model unavailable",
    });
    manager.startLocalStreamingRecording.mockImplementation(async () => {
      mockRequireCallbacks().onError({
        code: "LOCAL_STREAMING_START_FAILED",
        description: "model unavailable",
        recoverable: true,
      });
      return false;
    });

    await act(async () => {
      await requireHook().startRecording();
    });

    expect(manager.startRecording).toHaveBeenCalledOnce();
    expect(manager.cancelRecording).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "controlPanel.streamingFallback.title" })
    );
  });

  it("does not start recording when push-to-talk is released during the start cue", async () => {
    let finishCue: ((value: boolean) => void) | null = null;
    vi.mocked(playStartCue).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishCue = resolve;
        })
    );

    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={vi.fn()}
        />
      );
    });

    let startPromise: Promise<unknown>;
    await act(async () => {
      startPromise = requireHook().startRecording();
      await Promise.resolve();
    });
    await act(async () => {
      await requireHook().stopRecording();
      finishCue?.(true);
      await startPromise!;
    });

    expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();
  });

  it("cancels startup even when the cue promise itself never settles", async () => {
    vi.mocked(playStartCue).mockImplementation(() => new Promise<boolean>(() => {}));

    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={vi.fn()}
        />
      );
    });

    let startPromise: Promise<unknown>;
    await act(async () => {
      startPromise = requireHook().startRecording();
      await Promise.resolve();
    });

    let cancelResult = false;
    await act(async () => {
      cancelResult = await requireHook().cancelRecording();
      await startPromise!;
    });

    expect(cancelResult).toBe(true);
    expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();
    expect(requireHook().isStarting).toBe(false);
  });

  it("treats a second hotkey during startup as cancellation", async () => {
    vi.useFakeTimers();
    vi.mocked(playStartCue).mockImplementation(() => new Promise<boolean>(() => {}));

    try {
      await act(async () => {
        root = createRoot(container!);
        root.render(
          <TestComponent
            onHookReady={(val) => {
              hookVal = val;
            }}
            toast={vi.fn()}
          />
        );
      });

      let firstToggle: Promise<unknown> | undefined;
      await act(async () => {
        firstToggle = toggleCallback?.({ profileId: "primary" });
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(121);
      });
      await act(async () => {
        await toggleCallback?.({ profileId: "primary" });
        await firstToggle;
      });

      expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();
      expect(requireHook().isStarting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stop-dictation while a transcription is processing", async () => {
    // A push-to-talk release must not kill the in-flight transcription of the
    // previous sentence; toggle-mode cancel goes through handleToggle instead.
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={vi.fn()}
        />
      );
    });

    mockRequireAudioManager().getState.mockReturnValue({
      isRecording: false,
      isProcessing: true,
    });
    await act(async () => {
      stopCallback?.();
      await Promise.resolve();
    });

    expect(mockRequireAudioManager().cancelProcessing).not.toHaveBeenCalled();
  });

  it("rejects a start while the previous dictation is processing and shows a wait toast", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    mockRequireAudioManager().getState.mockReturnValue({
      isRecording: false,
      isProcessing: true,
    });
    await act(async () => {
      await requireHook().startRecording();
    });

    expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "hooks.audioRecording.previousStillProcessing.title",
      })
    );
  });

  afterEach(async () => {
    // Unmount the React root (not just detach the DOM node) so each test starts
    // with a clean hook instance — otherwise a prior test's component stays
    // mounted and its refs/cleanup leak into the next test.
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    if (container) {
      document.body.removeChild(container);
      container = null;
    }
  });

  it("initializes with correct default states", async () => {
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={vi.fn()}
        />
      );
    });

    expect(requireHook().isRecording).toBe(false);
    expect(requireHook().isProcessing).toBe(false);
    expect(requireHook().dictationStage).toBe("idle");
    expect(requireHook().micFeedbackState).toBe("idle");
  });

  it("registers window.electronAPI listeners on mount", async () => {
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={vi.fn()}
        />
      );
    });

    expect(mockElectronAPI.onToggleDictation).toHaveBeenCalledTimes(1);
  });

  it("handles start and stop recording transitions via AudioManager callback", async () => {
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={vi.fn()}
        />
      );
    });

    // Simulate AudioManager state changing to recording: true
    await act(async () => {
      mockRequireCallbacks().onStateChange({
        isRecording: true,
        isProcessing: false,
      });
    });

    expect(requireHook().isRecording).toBe(true);
    expect(requireHook().isProcessing).toBe(false);

    // Simulate state changing to processing: true (user stopped speaking, transcribing)
    await act(async () => {
      mockRequireCallbacks().onStateChange({
        isRecording: false,
        isProcessing: true,
      });
    });

    expect(requireHook().isRecording).toBe(false);
    expect(requireHook().isProcessing).toBe(true);
  });

  it("exposes the transcribed text to the renderer on a successful result", async () => {
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={vi.fn()}
        />
      );
    });

    // A successful, non-empty result must surface the transcribed text on the
    // hook. The terminal paste→success transition runs through a real 180ms
    // cancellation window + paste IPC and is intentionally NOT asserted here:
    // it depends on main-process timing and is covered by the Electron smoke
    // E2E, not a jsdom unit test.
    let completion: Promise<unknown> | undefined;
    await act(async () => {
      completion = mockRequireCallbacks().onTranscriptionComplete({
        success: true,
        text: "hello world",
      });
    });

    expect(requireHook().transcript).toBe("hello world");

    // Drain the async paste chain so its timers don't leak into later tests.
    await act(async () => {
      await completion;
    });
  });

  it("keeps non-final free AI polish previews silent", async () => {
    const toast = vi.fn();
    const onLicenseRequired = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
          options={{ onLicenseRequired }}
        />
      );
    });

    await act(async () => {
      await mockRequireCallbacks().onTranscriptionComplete({
        success: true,
        text: "hello world",
        reasoningNotice: {
          code: "PRO_REASONING_PREVIEW_USED",
          previewRemaining: 3,
          previewLimit: 10,
          previewDateKey: "2026-07-02",
        },
      });
    });

    expect(requireHook().transcript).toBe("hello world");
    expect(onLicenseRequired).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("notifies once the final free AI polish preview is consumed", async () => {
    const toast = vi.fn();
    const onLicenseRequired = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
          options={{ onLicenseRequired }}
        />
      );
    });

    await act(async () => {
      await mockRequireCallbacks().onTranscriptionComplete({
        success: true,
        text: "hello world",
        reasoningNotice: {
          code: "PRO_REASONING_PREVIEW_USED",
          previewRemaining: 0,
          previewLimit: 10,
          previewDateKey: "2026-07-02",
        },
      });
    });

    expect(requireHook().transcript).toBe("hello world");
    expect(onLicenseRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "PRO_REASONING_PREVIEW_LIMIT_REACHED",
        previewDateKey: "2026-07-02",
      })
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("keeps the quota dialog window visible after the final free AI polish preview", async () => {
    vi.useFakeTimers();
    const toast = vi.fn();
    const onLicenseRequired = vi.fn();
    try {
      await act(async () => {
        root = createRoot(container!);
        root.render(
          <TestComponent
            onHookReady={(val) => {
              hookVal = val;
            }}
            toast={toast}
            options={{ onLicenseRequired }}
          />
        );
      });

      let completion: Promise<unknown> | undefined;
      await act(async () => {
        completion = mockRequireCallbacks().onTranscriptionComplete({
          success: true,
          text: "hello world",
          reasoningNotice: {
            code: "PRO_REASONING_PREVIEW_USED",
            previewRemaining: 0,
            previewLimit: 10,
            previewDateKey: "2026-07-02",
          },
        });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(180);
        await completion;
      });

      expect(onLicenseRequired).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "PRO_REASONING_PREVIEW_LIMIT_REACHED",
          previewDateKey: "2026-07-02",
        })
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(mockElectronAPI.hideWindow).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps paste pending separate from the longer success confirmation", async () => {
    vi.useFakeTimers();
    let resolvePaste: ((value: boolean) => void) | null = null;
    try {
      await act(async () => {
        root = createRoot(container!);
        root.render(
          <TestComponent
            onHookReady={(val) => {
              hookVal = val;
            }}
            toast={vi.fn()}
          />
        );
      });

      mockRequireAudioManager().safePaste.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolvePaste = resolve;
          })
      );

      let completion: Promise<unknown> | undefined;
      await act(async () => {
        completion = mockRequireCallbacks().onTranscriptionComplete({
          success: true,
          text: "paste state timing",
        });
        await Promise.resolve();
      });

      expect(requireHook().micFeedbackState).toBe("pasting");
      expect(requireHook().dictationStage).toBe("pasting");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(180);
      });
      expect(mockRequireAudioManager().safePaste).toHaveBeenCalledOnce();
      expect(requireHook().micFeedbackState).toBe("pasting");

      await act(async () => {
        resolvePaste?.(true);
        await completion;
      });
      expect(requireHook().micFeedbackState).toBe("success");
      expect(requireHook().dictationStage).toBe("completed");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(819);
      });
      expect(requireHook().micFeedbackState).toBe("success");
      expect(mockElectronAPI.hideWindow).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(requireHook().micFeedbackState).toBe("idle");
      expect(requireHook().dictationStage).toBe("idle");
      expect(mockElectronAPI.hideWindow).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never enters success when automatic paste does not succeed", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        root = createRoot(container!);
        root.render(
          <TestComponent
            onHookReady={(val) => {
              hookVal = val;
            }}
            toast={vi.fn()}
          />
        );
      });
      mockRequireAudioManager().safePaste.mockResolvedValue(false);

      let completion: Promise<unknown> | undefined;
      await act(async () => {
        completion = mockRequireCallbacks().onTranscriptionComplete({
          success: true,
          text: "paste failure",
        });
        await vi.advanceTimersByTimeAsync(180);
        await completion;
      });

      expect(requireHook().micFeedbackState).toBe("idle");
      expect(requireHook().dictationStage).toBe("idle");
      expect(mockElectronAPI.hideWindow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies when the free AI polish preview quota is already exhausted", async () => {
    const toast = vi.fn();
    const onLicenseRequired = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
          options={{ onLicenseRequired }}
        />
      );
    });

    await act(async () => {
      await mockRequireCallbacks().onTranscriptionComplete({
        success: true,
        text: "hello world",
        reasoningNotice: {
          code: "PRO_REASONING_PREVIEW_LIMIT_REACHED",
          previewRemaining: 0,
          previewLimit: 10,
          previewDateKey: "2026-07-02",
        },
      });
    });

    expect(requireHook().transcript).toBe("hello world");
    expect(onLicenseRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "PRO_REASONING_PREVIEW_LIMIT_REACHED",
        previewDateKey: "2026-07-02",
      })
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("ignores dictation hotkeys while an external notice is open", async () => {
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={vi.fn()}
          options={{ shouldSuppressDictationHotkey: () => true }}
        />
      );
    });

    await act(async () => {
      toggleCallback?.({ profileId: "primary" });
    });

    expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();
    expect(requireHook().dictationStage).toBe("idle");
  });

  it("discards an empty/silent transcription instead of pasting whitespace", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    await act(async () => {
      await mockRequireCallbacks().onTranscriptionComplete({
        success: true,
        text: "   ",
        emptyTranscript: true,
      });
    });

    // Nothing meaningful was said: no transcript is surfaced or pasted, and a
    // persistent, actionable explanation replaces the former silent dismissal.
    expect(requireHook().transcript).toBe("");
    expect(mockRequireAudioManager().safePaste).not.toHaveBeenCalled();
    expect(mockRequireAudioManager().saveTranscription).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "hooks.audioRecording.noAudio.title",
        description: "hooks.audioRecording.noAudio.description",
        action: expect.anything(),
      })
    );
    expect(mockElectronAPI.hideWindow).not.toHaveBeenCalled();
  });

  it("turns the no-audio IPC event into an actionable error instead of hiding silently", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    await act(async () => {
      noAudioCallback?.();
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "hooks.audioRecording.noAudio.title",
        description: "hooks.audioRecording.noAudio.description",
      })
    );
    expect(mockElectronAPI.hideWindow).not.toHaveBeenCalled();
  });

  it("queues a no-audio retry until processing and its lease are idle, then starts once", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    mockRequireAudioManager().getState.mockReturnValue({
      isRecording: false,
      isProcessing: true,
      isReadyForRecordingStart: false,
    });
    await act(async () => {
      mockRequireCallbacks().onStateChange({ isRecording: false, isProcessing: true });
    });

    await act(async () => {
      noAudioCallback?.();
    });

    const action = toast.mock.calls.at(-1)?.[0]?.action;
    expect(React.isValidElement(action)).toBe(true);

    await act(async () => {
      (action as React.ReactElement<{ onClick: () => void }>).props.onClick();
      (action as React.ReactElement<{ onClick: () => void }>).props.onClick();
      await Promise.resolve();
    });
    expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();

    // An early UI-idle edge is not sufficient: stop/cancel paths can publish it
    // while their main-process transcription lease is still being released.
    await act(async () => {
      mockRequireAudioManager().getState.mockReturnValue({
        isRecording: false,
        isProcessing: false,
        isReadyForRecordingStart: false,
      });
      mockRequireCallbacks().onStateChange({ isRecording: false, isProcessing: false });
      await Promise.resolve();
    });
    expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();

    await act(async () => {
      mockRequireAudioManager().getState.mockReturnValue({
        isRecording: false,
        isProcessing: false,
        isReadyForRecordingStart: true,
      });
      mockRequireCallbacks().onStateChange({ isRecording: false, isProcessing: false });
      await Promise.resolve();
    });

    expect(mockRequireAudioManager().startRecording).toHaveBeenCalledOnce();

    await act(async () => {
      mockRequireCallbacks().onStateChange({ isRecording: false, isProcessing: false });
      await Promise.resolve();
    });
    expect(mockRequireAudioManager().startRecording).toHaveBeenCalledOnce();
  });

  it("expires a queued no-audio retry instead of starting it later as a ghost operation", async () => {
    vi.useFakeTimers();
    try {
      const toast = vi.fn();
      await act(async () => {
        root = createRoot(container!);
        root.render(
          <TestComponent
            onHookReady={(val) => {
              hookVal = val;
            }}
            toast={toast}
          />
        );
      });

      mockRequireAudioManager().getState.mockReturnValue({
        isRecording: false,
        isProcessing: true,
        isReadyForRecordingStart: false,
      });
      await act(async () => {
        noAudioCallback?.();
      });
      const action = toast.mock.calls.at(-1)?.[0]?.action;

      await act(async () => {
        (action as React.ReactElement<{ onClick: () => void }>).props.onClick();
        await vi.advanceTimersByTimeAsync(6000);
      });

      await act(async () => {
        mockRequireAudioManager().getState.mockReturnValue({
          isRecording: false,
          isProcessing: false,
          isReadyForRecordingStart: true,
        });
        mockRequireCallbacks().onStateChange({ isRecording: false, isProcessing: false });
        await Promise.resolve();
      });

      expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();
      expect(toast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: "hooks.audioRecording.failures.recording.title",
          description: "hooks.audioRecording.failures.recording.description",
          variant: "destructive",
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a queued no-audio retry when a newer manual start takes ownership", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    mockRequireAudioManager().getState.mockReturnValue({
      isRecording: false,
      isProcessing: true,
      isReadyForRecordingStart: false,
    });
    await act(async () => {
      noAudioCallback?.();
    });
    const action = toast.mock.calls.at(-1)?.[0]?.action;
    await act(async () => {
      (action as React.ReactElement<{ onClick: () => void }>).props.onClick();
    });

    mockRequireAudioManager().getState.mockReturnValue({
      isRecording: false,
      isProcessing: false,
      isReadyForRecordingStart: true,
    });
    await act(async () => {
      await requireHook().startRecording();
    });
    expect(mockRequireAudioManager().startRecording).toHaveBeenCalledOnce();

    await act(async () => {
      mockRequireCallbacks().onStateChange({ isRecording: false, isProcessing: false });
      await Promise.resolve();
    });
    expect(mockRequireAudioManager().startRecording).toHaveBeenCalledOnce();
  });

  it("clears a queued no-audio retry timer when the hook unmounts", async () => {
    vi.useFakeTimers();
    try {
      const toast = vi.fn();
      await act(async () => {
        root = createRoot(container!);
        root.render(
          <TestComponent
            onHookReady={(val) => {
              hookVal = val;
            }}
            toast={toast}
          />
        );
      });

      mockRequireAudioManager().getState.mockReturnValue({
        isRecording: false,
        isProcessing: true,
        isReadyForRecordingStart: false,
      });
      await act(async () => {
        noAudioCallback?.();
      });
      const action = toast.mock.calls.at(-1)?.[0]?.action;
      await act(async () => {
        (action as React.ReactElement<{ onClick: () => void }>).props.onClick();
      });
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await act(async () => {
        root!.unmount();
      });
      root = null;
      expect(vi.getTimerCount()).toBe(0);
      expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains transcription failures and offers a new dictation retry", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    await act(async () => {
      mockRequireCallbacks().onError({
        title: "Transcription Error",
        description: "Network request failed",
      });
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "hooks.audioRecording.failures.transcription.title",
        description: "hooks.audioRecording.failures.transcription.description",
        action: expect.anything(),
        variant: "destructive",
      })
    );
  });

  it("uses the structured microphone permission code even when the message is localized", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    await act(async () => {
      mockRequireCallbacks().onError({
        code: "MICROPHONE_PERMISSION_DENIED",
        title: "需要麦克风权限",
        description: "权限已被拒绝，请在系统设置中允许 ChordVox。",
      });
    });

    const renderedToast = toast.mock.calls.at(-1)?.[0];
    expect(renderedToast).toEqual(
      expect.objectContaining({
        title: "hooks.permissions.titles.microphonePermissionRequired",
        description: "权限已被拒绝，请在系统设置中允许 ChordVox。",
        action: expect.anything(),
      })
    );
    await act(async () => {
      (renderedToast.action as React.ReactElement<{ onClick: () => void }>).props.onClick();
      await Promise.resolve();
    });
    expect(mockElectronAPI.openMicrophoneSettings).toHaveBeenCalledOnce();
    expect(mockElectronAPI.openSoundInputSettings).not.toHaveBeenCalled();
  });

  it("opens sound input settings for a localized unavailable-microphone error", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    await act(async () => {
      mockRequireCallbacks().onError({
        code: "MICROPHONE_NOT_FOUND",
        title: "麦克风不可用",
        description: "没有检测到可用的音频输入设备。",
      });
    });

    const action = toast.mock.calls.at(-1)?.[0]?.action;
    await act(async () => {
      (action as React.ReactElement<{ onClick: () => void }>).props.onClick();
      await Promise.resolve();
    });
    expect(mockElectronAPI.openSoundInputSettings).toHaveBeenCalledOnce();
    expect(mockElectronAPI.openMicrophoneSettings).not.toHaveBeenCalled();
  });

  it("states that paste failures leave text in the clipboard but not in history", async () => {
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    await act(async () => {
      mockRequireCallbacks().onError({
        code: "PASTE_FAILED",
        title: "PASTE_FAILED",
        description: "Automatic paste failed",
      });
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "hooks.permissions.titles.accessibilityNeeded",
        description: "hooks.clipboard.pasteFailed.macosDescription",
      })
    );
  });

  it("reports when pasted text could not be added to local history", async () => {
    const toast = vi.fn();
    mockAudioManagerInstance = null;
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });
    mockRequireAudioManager().saveTranscription.mockResolvedValue({ success: false });

    await act(async () => {
      await mockRequireCallbacks().onTranscriptionComplete({
        success: true,
        text: "saved in the target app",
      });
    });

    expect(mockRequireAudioManager().safePaste).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "hooks.audioRecording.failures.historySave.title",
        description: "hooks.audioRecording.failures.historySave.description",
      })
    );
  });

  it("waits for the nebula completion FX before showing the one-time Pro nudge", async () => {
    vi.useFakeTimers();
    try {
      const toast = vi.fn();
      mockElectronAPI.getTranscriptionStats.mockResolvedValue({ totalEntries: 20 });
      await act(async () => {
        root = createRoot(container!);
        root.render(
          <TestComponent
            onHookReady={(val) => {
              hookVal = val;
            }}
            toast={toast}
          />
        );
      });

      let completion: Promise<unknown> | undefined;
      await act(async () => {
        completion = mockRequireCallbacks().onTranscriptionComplete({
          success: true,
          text: "nudge timing",
        });
        await vi.advanceTimersByTimeAsync(180);
        await completion;
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(899);
      });
      expect(toast).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "hooks.audioRecording.proNudge.title" })
      );
      expect(mockElectronAPI.licenseGetStatus).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "hooks.audioRecording.proNudge.title" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not show a delayed Pro nudge while a new recording is active", async () => {
    vi.useFakeTimers();
    try {
      const toast = vi.fn();
      mockElectronAPI.getTranscriptionStats.mockResolvedValue({ totalEntries: 20 });
      await act(async () => {
        root = createRoot(container!);
        root.render(
          <TestComponent
            onHookReady={(val) => {
              hookVal = val;
            }}
            toast={toast}
          />
        );
      });

      let completion: Promise<unknown> | undefined;
      await act(async () => {
        completion = mockRequireCallbacks().onTranscriptionComplete({
          success: true,
          text: "nudge cancellation",
        });
        await vi.advanceTimersByTimeAsync(180);
        await completion;
        await Promise.resolve();
        await Promise.resolve();
      });

      mockRequireAudioManager().getState.mockReturnValue({
        isRecording: true,
        isProcessing: false,
        isStreaming: false,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockElectronAPI.licenseGetStatus).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "hooks.audioRecording.proNudge.title" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks first activation without saving transcription content when history is off", async () => {
    const toast = vi.fn();
    localStorage.setItem("transcriptionHistoryEnabled", "false");
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    await act(async () => {
      await mockRequireCallbacks().onTranscriptionComplete({
        success: true,
        text: "private content stays out of the funnel",
      });
    });

    expect(mockRequireAudioManager().safePaste).toHaveBeenCalled();
    expect(mockRequireAudioManager().saveTranscription).not.toHaveBeenCalled();
    expect(mockElectronAPI.trackOnboardingEvent).toHaveBeenCalledWith("first_successful_dictation");
    expect(mockElectronAPI.trackOnboardingEvent).toHaveBeenCalledTimes(1);
  });

  it("constructs AudioManager once per mount despite volatile prop/callback identity churn", async () => {
    // Locks the #4 latest-ref invariant: the AudioManager-owning effect is
    // mount-once ([] deps). Before that refactor it depended on ~21 identities
    // (t, toast, the option callbacks) and tore down + rebuilt AudioManager on
    // every language switch or parent re-render. Re-rendering with brand-new
    // toast/option-callback identities must NOT reconstruct AudioManager — a
    // regression here (e.g. re-adding deps to the effect) is otherwise invisible
    // to every other test, which all pass whether the effect runs once or many.
    const renderWithFreshIdentities = async () => {
      await act(async () => {
        root!.render(
          <TestComponent
            onHookReady={(val) => {
              hookVal = val;
            }}
            toast={vi.fn()}
            options={{
              onToggle: vi.fn(),
              onLicenseRequired: vi.fn(),
              onOverlayDismiss: vi.fn(),
            }}
          />
        );
      });
    };

    root = createRoot(container!);
    await renderWithFreshIdentities();
    expect(mockAudioManagerConstructCount).toBe(1);

    // Several re-renders, each handing the hook new function identities for the
    // volatile inputs that used to drive the effect's dependency array.
    for (let i = 0; i < 4; i += 1) {
      await renderWithFreshIdentities();
    }

    expect(mockAudioManagerConstructCount).toBe(1);
  });

  it("does not intercept tail cancel commands while the feature is disabled", async () => {
    localStorage.setItem("tailCommandsEnabled", "true");
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    let completion: Promise<unknown> | undefined;
    await act(async () => {
      completion = mockRequireCallbacks().onTranscriptionComplete({
        success: true,
        text: "这是一段测试文字，取消别输出。",
      });
    });

    expect(requireHook().transcript).toBe("这是一段测试文字，取消别输出。");

    await act(async () => {
      await completion;
    });

    expect(mockRequireAudioManager().safePaste).toHaveBeenCalledWith(
      "这是一段测试文字，取消别输出。",
      expect.objectContaining({})
    );
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        title: "app.toasts.dictationCancelled.title",
      })
    );
  });

  it("does not restart transcription on tail redo commands while the feature is disabled", async () => {
    localStorage.setItem("tailCommandsEnabled", "true");
    const toast = vi.fn();
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <TestComponent
          onHookReady={(val) => {
            hookVal = val;
          }}
          toast={toast}
        />
      );
    });

    let completion: Promise<unknown> | undefined;
    await act(async () => {
      completion = mockRequireCallbacks().onTranscriptionComplete({
        success: true,
        text: "这句话说错了。重来说！",
      });
    });

    expect(requireHook().transcript).toBe("这句话说错了。重来说！");

    await act(async () => {
      await completion;
    });

    expect(mockRequireAudioManager().safePaste).toHaveBeenCalledWith(
      "这句话说错了。重来说！",
      expect.objectContaining({})
    );
    expect(mockRequireAudioManager().startRecording).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        title: "app.toasts.dictationRestarted.title",
      })
    );
  });
});
