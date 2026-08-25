import { describe, expect, it, vi } from "vitest";
import {
  getReasoningPreviewQuota,
  restoreReasoningModelAfterPreviewReset,
  writeReasoningPreviewUsage,
  consumeReasoningPreviewQuota,
  disableReasoningModelForPreviewLimit,
  hasSeenReasoningLimitDialog,
  isReasoningModelAutoDisabledForPreviewLimit,
  markReasoningLimitDialogSeen,
} from "./reasoningPreviewQuota";

const AUTO_DISABLED_KEY = "proReasoningPreviewAutoDisabled";
const JUNE_24_LOCAL = new Date(2026, 5, 24, 23, 59, 0);
const JUNE_25_LOCAL = new Date(2026, 5, 25, 0, 0, 2);

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

describe("reasoning preview quota reset", () => {
  it("treats a new local date as a fresh 10-use quota", () => {
    const storage = new MemoryStorage();
    writeReasoningPreviewUsage({ dateKey: "2026-06-24", used: 10 }, storage);

    expect(getReasoningPreviewQuota(storage, JUNE_24_LOCAL)).toMatchObject({
      dateKey: "2026-06-24",
      used: 10,
      remaining: 0,
    });
    expect(getReasoningPreviewQuota(storage, JUNE_25_LOCAL)).toMatchObject({
      dateKey: "2026-06-25",
      used: 0,
      remaining: 10,
    });
  });

  it("restores AI refinement after an auto-disable once the local day changes", () => {
    const storage = new MemoryStorage();
    writeReasoningPreviewUsage({ dateKey: "2026-06-24", used: 10 }, storage);
    storage.setItem(
      AUTO_DISABLED_KEY,
      JSON.stringify({ dateKey: "2026-06-24", disabledAt: "2026-06-24T15:00:00.000Z" })
    );
    storage.setItem("useReasoningModel", "false");

    expect(restoreReasoningModelAfterPreviewReset(storage, JUNE_24_LOCAL)).toBe(false);
    expect(storage.getItem("useReasoningModel")).toBe("false");

    expect(restoreReasoningModelAfterPreviewReset(storage, JUNE_25_LOCAL)).toBe(true);
    expect(storage.getItem("useReasoningModel")).toBe("true");
    expect(storage.getItem(AUTO_DISABLED_KEY)).toBeNull();
  });

  it("does not turn on AI refinement when there is no auto-disable marker", () => {
    const storage = new MemoryStorage();
    storage.setItem("useReasoningModel", "false");

    expect(restoreReasoningModelAfterPreviewReset(storage, JUNE_25_LOCAL)).toBe(false);
    expect(storage.getItem("useReasoningModel")).toBe("false");
  });

  it("handles storage exceptions and invalid JSON gracefully", () => {
    const storage = new MemoryStorage();
    storage.setItem("proReasoningPreviewDailyUsage", "{invalid-json}");
    const quota = getReasoningPreviewQuota(storage, JUNE_24_LOCAL);
    expect(quota.used).toBe(0);
  });

  it("clamps and parses used value correctly", () => {
    const storage = new MemoryStorage();
    writeReasoningPreviewUsage({ dateKey: "2026-06-24", used: -5 }, storage);
    expect(getReasoningPreviewQuota(storage, JUNE_24_LOCAL).used).toBe(0);

    writeReasoningPreviewUsage({ dateKey: "2026-06-24", used: 15 }, storage);
    expect(getReasoningPreviewQuota(storage, JUNE_24_LOCAL).used).toBe(10);

    writeReasoningPreviewUsage({ dateKey: "2026-06-24", used: 3.6 }, storage);
    expect(getReasoningPreviewQuota(storage, JUNE_24_LOCAL).used).toBe(3);

    writeReasoningPreviewUsage({ dateKey: "2026-06-24", used: NaN }, storage);
    expect(getReasoningPreviewQuota(storage, JUNE_24_LOCAL).used).toBe(0);
  });

  it("consumes reasoning preview quota deterministically under a fixed clock", () => {
    // consumeReasoningPreviewQuota reads the current Date internally (no date
    // param), so pin the system clock to keep the local date key stable across
    // runs and across midnight — otherwise this test is time-of-day flaky.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 24, 12, 0, 0));
    try {
      const storage = new MemoryStorage();
      expect(getReasoningPreviewQuota(storage).used).toBe(0);

      const first = consumeReasoningPreviewQuota(storage);
      expect(first.used).toBe(1);
      expect(first.remaining).toBe(9);

      const second = consumeReasoningPreviewQuota(storage);
      expect(second.used).toBe(2);
      expect(second.remaining).toBe(8);

      // Persisted under today's local date key and readable back at the same clock.
      expect(getReasoningPreviewQuota(storage)).toMatchObject({
        dateKey: "2026-06-24",
        used: 2,
        remaining: 8,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables reasoning model for preview limit", () => {
    const storage = new MemoryStorage();
    storage.setItem("useReasoningModel", "true");
    disableReasoningModelForPreviewLimit(storage);

    expect(storage.getItem("useReasoningModel")).toBe("false");
    expect(storage.getItem(AUTO_DISABLED_KEY)).toBeDefined();
  });

  it("recognizes only the current exhausted day as preview auto-disabled", () => {
    const storage = new MemoryStorage();
    writeReasoningPreviewUsage({ dateKey: "2026-06-24", used: 10 }, storage);
    storage.setItem(AUTO_DISABLED_KEY, JSON.stringify({ dateKey: "2026-06-24" }));

    expect(isReasoningModelAutoDisabledForPreviewLimit(storage, JUNE_24_LOCAL)).toBe(true);
    expect(isReasoningModelAutoDisabledForPreviewLimit(storage, JUNE_25_LOCAL)).toBe(false);
  });

  it("does not restore if useReasoningModel is already true", () => {
    const storage = new MemoryStorage();
    storage.setItem("useReasoningModel", "true");
    storage.setItem(AUTO_DISABLED_KEY, JSON.stringify({ dateKey: "2026-06-24" }));

    expect(restoreReasoningModelAfterPreviewReset(storage, JUNE_25_LOCAL)).toBe(false);
    expect(storage.getItem(AUTO_DISABLED_KEY)).toBeNull();
  });

  it("removes invalid auto-disable state and returns false", () => {
    const storage = new MemoryStorage();
    storage.setItem(AUTO_DISABLED_KEY, "{invalid-json}");
    expect(restoreReasoningModelAfterPreviewReset(storage, JUNE_25_LOCAL)).toBe(false);
    expect(storage.getItem(AUTO_DISABLED_KEY)).toBeNull();
  });
});

describe("reasoning limit dialog seen tracking", () => {
  it("shows the dialog once per day: unseen before mark, silent after", () => {
    const storage = new MemoryStorage();

    expect(hasSeenReasoningLimitDialog("2026-06-24", storage)).toBe(false);
    markReasoningLimitDialogSeen("2026-06-24", storage);
    expect(hasSeenReasoningLimitDialog("2026-06-24", storage)).toBe(true);
  });

  it("allows the dialog again on the next local day", () => {
    const storage = new MemoryStorage();
    markReasoningLimitDialogSeen("2026-06-24", storage);

    expect(hasSeenReasoningLimitDialog("2026-06-24", storage)).toBe(true);
    expect(hasSeenReasoningLimitDialog("2026-06-25", storage)).toBe(false);
  });

  it("marking is idempotent", () => {
    const storage = new MemoryStorage();
    markReasoningLimitDialogSeen("2026-06-24", storage);
    markReasoningLimitDialogSeen("2026-06-24", storage);

    expect(hasSeenReasoningLimitDialog("2026-06-24", storage)).toBe(true);
    expect(storage.length).toBe(1);
  });

  it("falls back to today's quota date key when dateKey is empty", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 24, 12, 0, 0));
    try {
      const storage = new MemoryStorage();
      markReasoningLimitDialogSeen("", storage);

      expect(hasSeenReasoningLimitDialog("", storage)).toBe(true);
      expect(hasSeenReasoningLimitDialog("2026-06-24", storage)).toBe(true);
      expect(hasSeenReasoningLimitDialog("2026-06-25", storage)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("full daily flow: limit dialog fires once, stays silent, resets next day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 24, 12, 0, 0));
    try {
      const storage = new MemoryStorage();

      // Uses 1-9 stay silent (remaining > 0 → no limit notice at all).
      for (let i = 0; i < 9; i += 1) {
        expect(consumeReasoningPreviewQuota(storage).remaining).toBeGreaterThan(0);
      }

      // 10th use exhausts the quota → dialog is shown and marked immediately.
      const final = consumeReasoningPreviewQuota(storage);
      expect(final.remaining).toBe(0);
      disableReasoningModelForPreviewLimit(storage);
      expect(storage.getItem("useReasoningModel")).toBe("false");
      expect(hasSeenReasoningLimitDialog(final.dateKey, storage)).toBe(false);
      markReasoningLimitDialogSeen(final.dateKey, storage);

      // Any later limit notice the same day is a no-op.
      expect(hasSeenReasoningLimitDialog(final.dateKey, storage)).toBe(true);

      // Next local day: quota resets, reasoning restores, dialog can fire again.
      vi.setSystemTime(new Date(2026, 5, 25, 0, 0, 2));
      expect(restoreReasoningModelAfterPreviewReset(storage)).toBe(true);
      expect(storage.getItem("useReasoningModel")).toBe("true");
      const nextDay = getReasoningPreviewQuota(storage);
      expect(nextDay).toMatchObject({ dateKey: "2026-06-25", used: 0, remaining: 10 });
      expect(hasSeenReasoningLimitDialog(nextDay.dateKey, storage)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
