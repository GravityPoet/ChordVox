// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { calculateMicrophoneLevel } from "../../utils/microphoneLevel";
import MicrophoneInputTest from "./MicrophoneInputTest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("MicrophoneInputTest", () => {
  let container: HTMLDivElement;
  let root: Root;
  let animationFrameCallback: FrameRequestCallback | null;
  let stopTrack: ReturnType<typeof vi.fn>;
  let closeAudioContext: ReturnType<typeof vi.fn>;
  let getByteTimeDomainData: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    animationFrameCallback = null;
    stopTrack = vi.fn();
    closeAudioContext = vi.fn().mockResolvedValue(undefined);
    getByteTimeDomainData = vi.fn((samples: Uint8Array) => {
      samples.fill(128);
      samples[0] = 255;
    });

    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        animationFrameCallback = callback;
        return 17;
      }),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: stopTrack }],
        }),
      },
    });

    class MockAudioContext {
      state: AudioContextState = "running";
      close = closeAudioContext;
      resume = vi.fn().mockResolvedValue(undefined);
      createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      createAnalyser = vi.fn(() => ({
        fftSize: 256,
        smoothingTimeConstant: 0,
        getByteTimeDomainData,
        disconnect: vi.fn(),
      }));
    }

    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: MockAudioContext,
    });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        requestMicrophoneAccess: vi.fn().mockResolvedValue(true),
      },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("normalizes silent and audible time-domain samples", () => {
    expect(calculateMicrophoneLevel(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(calculateMicrophoneLevel(new Uint8Array([0, 255]))).toBe(1);
  });

  it("shows live input and releases the microphone after the eight-second test", async () => {
    const onPermissionGranted = vi.fn();

    await act(async () => {
      root.render(
        <MicrophoneInputTest
          preferBuiltInMic={false}
          selectedMicDeviceId=""
          onPermissionGranted={onPermissionGranted}
          onOpenPrivacySettings={vi.fn()}
          onOpenSoundSettings={vi.fn()}
        />
      );
    });

    const startButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("settingsPage.permissions.microphoneTest.start")
    );
    expect(startButton).toBeTruthy();

    await act(async () => {
      startButton?.click();
      await Promise.resolve();
    });
    expect(onPermissionGranted).toHaveBeenCalledTimes(1);

    await act(async () => {
      animationFrameCallback?.(performance.now());
    });
    expect(container.textContent).toContain("settingsPage.permissions.microphoneTest.heardLive");
    expect(
      Number(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow"))
    ).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(container.textContent).toContain("settingsPage.permissions.microphoneTest.success");
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(closeAudioContext).toHaveBeenCalledTimes(1);
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(17);
  });
});
