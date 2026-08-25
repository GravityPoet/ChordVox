// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { TranscriptionStats } from "../types/electron";
import EfficiencyOverview from "./EfficiencyOverview";

const { mockToast, mockTranslate, mockI18n } = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockI18n: { language: "en" },
  mockTranslate: (key: string, options: Record<string, unknown> = {}) => {
    if (key.endsWith("units.mixed")) return "units";
    if (key.endsWith("cards.words.helper")) return `today:${options.total}`;
    if (key.endsWith("cards.completed.label")) return "completed";
    if (key.endsWith("cards.completed.value")) return `${options.formattedCount} dictations`;
    if (key.endsWith("cards.completed.helper")) return `recorded:${options.duration}`;
    if (key.endsWith("duration.minutesOnly")) return `${options.minutes}m`;
    if (key.endsWith("duration.hoursAndMinutes")) {
      return `${options.hours}h ${options.minutes}m`;
    }
    if (key.endsWith("duration.subMinute")) return "<1m";
    if (key.endsWith("speed.perMinute")) return `${options.speed}/m`;
    return key;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: mockI18n,
    t: mockTranslate,
  }),
}));

vi.mock("./ui/toastContext", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const INITIAL_STATS: TranscriptionStats = {
  todayUnits: 53,
  totalUnits: 53,
  todayEntries: 2,
  totalEntries: 2,
  totalRecordingDurationMs: 60_000,
  estimatedTimeSavedMs: 30_000,
  averageDictationUnitsPerMinute: 53,
  lastUpdatedAt: "2026-07-10T00:00:00.000Z",
};

describe("EfficiencyOverview statistics", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onTranscriptionAdded: (() => void) | null;
  let getTranscriptionStats: ReturnType<typeof vi.fn>;
  let animationFrames: Map<number, FrameRequestCallback>;
  let nextAnimationFrameId: number;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onTranscriptionAdded = null;
    animationFrames = new Map();
    nextAnimationFrameId = 1;
    getTranscriptionStats = vi.fn().mockResolvedValue(INITIAL_STATS);

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        const id = nextAnimationFrameId++;
        animationFrames.set(id, callback);
        return id;
      }),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: vi.fn((id: number) => animationFrames.delete(id)),
    });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getTranscriptionStats,
        onTranscriptionAdded: vi.fn((callback: () => void) => {
          onTranscriptionAdded = callback;
          return vi.fn();
        }),
        onTranscriptionDeleted: vi.fn(() => vi.fn()),
        onTranscriptionsCleared: vi.fn(() => vi.fn()),
      },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows the first real total and today values together, then animates later refreshes", async () => {
    await act(async () => {
      root.render(<EfficiencyOverview />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("53 units");
    expect(container.textContent).toContain("today:53");
    const completedLabel = Array.from(container.querySelectorAll("p")).find(
      (element) => element.textContent === "completed"
    );
    const completedCard = completedLabel?.closest(".premium-stat-card");
    expect(completedCard?.textContent).toContain("2 dictations");
    expect(completedCard?.textContent).toContain("recorded:1m");
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();

    getTranscriptionStats.mockResolvedValueOnce({
      ...INITIAL_STATS,
      todayUnits: 54,
      totalUnits: 54,
      totalEntries: 3,
    });
    await act(async () => {
      onTranscriptionAdded?.();
      await Promise.resolve();
    });

    expect(window.requestAnimationFrame).toHaveBeenCalled();
    expect(container.textContent).toContain("53 units");
    expect(container.textContent).toContain("today:53");

    const finishAt = performance.now() + 1_000;
    await act(async () => {
      for (const callback of Array.from(animationFrames.values())) {
        callback(finishAt);
      }
    });

    expect(container.textContent).toContain("54 units");
    expect(container.textContent).toContain("today:54");
    expect(completedCard?.textContent).toContain("3 dictations");
    expect(completedCard?.textContent).toContain("recorded:1m");
  });
});
