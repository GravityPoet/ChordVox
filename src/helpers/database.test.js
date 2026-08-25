import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const DatabaseManager = require("./database");

function createManager(rows = []) {
  const manager = Object.create(DatabaseManager.prototype);
  manager.db = {
    prepare(sql) {
      if (/SELECT\s+COUNT\(\*\)\s+AS count/i.test(sql)) {
        return { get: () => ({ count: rows.length }) };
      }
      if (/SELECT \* FROM transcriptions/i.test(sql)) {
        return {
          all: (...params) => {
            if (/id < \?/i.test(sql)) {
              const cursorId = Number(params.at(-2));
              const limit = Number(params.at(-1));
              const result = rows.filter((row) => Number(row.id) < cursorId).slice(0, limit);
              return result;
            }
            const limit = Number(params.at(-2));
            const offset = Number(params.at(-1));
            return rows.slice(offset, offset + limit);
          },
        };
      }
      if (/estimated_typing_duration_ms/i.test(sql)) {
        return { all: () => rows };
      }
      throw new Error(`Unexpected SQL in database test: ${sql}`);
    },
  };
  return manager;
}

function createStatsManager(rows = []) {
  const manager = Object.create(DatabaseManager.prototype);
  const storedRows = rows.map((row) => ({ ...row }));
  manager.statsBackfillCancelled = false;
  manager.statsBackfillPending = false;
  manager.storedRows = storedRows;
  manager.db = {
    prepare(sql) {
      if (/FROM transcriptions\s+WHERE id > \?/s.test(sql)) {
        return {
          all: (lastId, limit) =>
            storedRows
              .filter(
                (row) =>
                  row.id > lastId &&
                  Number(row.exclude_from_stats) !== 1 &&
                  (!(Number(row.unit_count) > 0) || !(Number(row.estimated_typing_duration_ms) > 0))
              )
              .sort((left, right) => left.id - right.id)
              .slice(0, limit),
        };
      }
      if (/UPDATE transcriptions\s+SET unit_count = \?/s.test(sql)) {
        return {
          run: (unitCount, typingDurationMs, id) => {
            const row = storedRows.find((candidate) => candidate.id === id);
            row.unit_count = unitCount;
            row.estimated_typing_duration_ms = typingDurationMs;
          },
        };
      }
      if (/COUNT\(\*\) AS total_entries/s.test(sql)) {
        return {
          get: (todayStart) => {
            const eligibleRows = storedRows.filter((row) => Number(row.exclude_from_stats) !== 1);
            const todayStartMs = new Date(todayStart).getTime();
            const timestampMs = (row) => new Date(row.timestamp || row.created_at || 0).getTime();
            const units = (row) => Math.max(0, Number(row.unit_count) || 0);
            const recordingMs = (row) => Math.max(0, Number(row.recording_duration_ms) || 0);
            const typingMs = (row) => Math.max(0, Number(row.estimated_typing_duration_ms) || 0);
            const recordedRows = eligibleRows.filter((row) => recordingMs(row) > 0);
            const latest = eligibleRows
              .map((row) => row.timestamp || row.created_at)
              .filter(Boolean)
              .sort()
              .at(-1);
            return {
              total_entries: eligibleRows.length,
              total_units: eligibleRows.reduce((total, row) => total + units(row), 0),
              today_units: eligibleRows
                .filter((row) => timestampMs(row) >= todayStartMs)
                .reduce((total, row) => total + units(row), 0),
              today_entries: eligibleRows.filter((row) => timestampMs(row) >= todayStartMs).length,
              total_recording_duration_ms: recordedRows.reduce(
                (total, row) => total + recordingMs(row),
                0
              ),
              speed_units: recordedRows.reduce((total, row) => total + units(row), 0),
              estimated_typing_duration_ms: recordedRows.reduce(
                (total, row) => total + typingMs(row),
                0
              ),
              last_updated_at: latest || null,
            };
          },
        };
      }
      throw new Error(`Unexpected SQL in statistics test: ${sql}`);
    },
    transaction(callback) {
      return (...args) => callback(...args);
    },
  };
  return manager;
}

function makeRow(id, text, overrides = {}) {
  return {
    id,
    text,
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
    unit_count: 1,
    recording_duration_ms: null,
    favorite: 0,
    exclude_from_stats: 0,
    estimated_typing_duration_ms: null,
    ...overrides,
  };
}

describe("DatabaseManager history and statistics", () => {
  let manager;

  beforeEach(() => {
    manager = createManager();
  });

  it("excludes derived re-polish rows and uses language-aware typing estimates", async () => {
    const rows = [
      makeRow(4, "Hello ChordVox", {
        unit_count: 2,
        recording_duration_ms: 1_000,
        estimated_typing_duration_ms: manager.estimateTypingDurationMs("Hello ChordVox"),
      }),
      makeRow(3, "你好世界", {
        unit_count: 4,
        recording_duration_ms: 1_000,
        estimated_typing_duration_ms: manager.estimateTypingDurationMs("你好世界"),
      }),
      makeRow(2, "Derived Result", {
        unit_count: 0,
        recording_duration_ms: 0,
        exclude_from_stats: 1,
      }),
      makeRow(1, "LegacyBrand record", { unit_count: 0 }),
    ];
    manager = createStatsManager(rows);

    expect(manager.estimateTypingDurationMs("word ".repeat(40))).toBe(60_000);
    expect(manager.estimateTypingDurationMs("字".repeat(50))).toBe(60_000);

    await manager.backfillLegacyTranscriptionStatsInBackground();

    const stats = manager.getTranscriptionStats();
    expect(stats.totalEntries).toBe(3);
    expect(stats.totalUnits).toBe(8);
    expect(stats.totalRecordingDurationMs).toBe(2_000);
    expect(stats.averageDictationUnitsPerMinute).toBe(180);
    expect(stats.estimatedTimeSavedMs).toBe(5_800);
  });

  it("persists legacy estimates before aggregate reads instead of decrypting on every read", async () => {
    manager = createStatsManager([
      makeRow(1, "two words", {
        unit_count: 0,
        recording_duration_ms: 1_000,
        estimated_typing_duration_ms: null,
      }),
    ]);

    await manager.backfillLegacyTranscriptionStatsInBackground();

    const stored = manager.storedRows.find((row) => row.id === 1);
    expect(stored.unit_count).toBe(2);
    expect(stored.estimated_typing_duration_ms).toBe(3_000);
    expect(manager.getTranscriptionStats()).toMatchObject({
      totalUnits: 2,
      totalEntries: 1,
      estimatedTimeSavedMs: 2_000,
    });
  });

  it("pages the full corpus and finds matches older than the former 2,000-row cap", async () => {
    const rows = Array.from({ length: 2_101 }, (_, index) =>
      makeRow(2_101 - index, index === 2_100 ? "NeedleLegacyBrand" : `ordinary record ${index}`)
    );
    manager = createManager(rows);

    const lastPage = await manager.queryTranscriptionHistory({ limit: 50, offset: 2_100 });
    expect(lastPage.totalCount).toBe(2_101);
    expect(lastPage.items).toHaveLength(1);
    expect(lastPage.hasMore).toBe(false);

    const search = await manager.queryTranscriptionHistory({
      query: "needlelegacybrand",
      limit: 10,
    });
    expect(search.items).toHaveLength(1);
    expect(search.items[0].text).toBe("NeedleLegacyBrand");
    expect(search.totalCount).toBe(1);
    expect(search.truncated).toBe(false);
  });

  it("returns an opaque keyset cursor without exposing transcription text", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => makeRow(120 - index, `record ${index}`));
    manager = createManager(rows);

    const firstPage = await manager.queryTranscriptionHistory({ limit: 50 });
    const secondPage = await manager.queryTranscriptionHistory({
      limit: 50,
      cursor: firstPage.nextCursor,
    });

    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.nextCursor).not.toContain("record");
    expect(secondPage.items[0].id).toBeLessThan(firstPage.items.at(-1).id);
    expect(new Set(secondPage.items.map((item) => item.id)).size).toBe(secondPage.items.length);
  });

  it("cooperatively cancels a superseded encrypted-text scan", async () => {
    manager = createManager(
      Array.from({ length: 250 }, (_, index) => makeRow(250 - index, `record ${index}`))
    );

    let cancellationChecks = 0;
    const result = await manager.queryTranscriptionHistory({
      query: "missing",
      shouldCancel: () => {
        cancellationChecks += 1;
        return cancellationChecks > 1;
      },
    });

    expect(result.cancelled).toBe(true);
    expect(result.items).toEqual([]);
  });
});
