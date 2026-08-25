import { describe, expect, it } from "vitest";
const { decodeHistoryCursor, encodeHistoryCursor } = require("./historyCursor");

describe("history keyset cursor", () => {
  it("round-trips only the stable timestamp/id boundary", () => {
    const cursor = encodeHistoryCursor({
      id: 42,
      timestamp: "2026-08-24T00:00:00.000Z",
      text: "must never be encoded",
    });
    expect(cursor).toBeTruthy();
    expect(decodeHistoryCursor(cursor)).toEqual({
      id: 42,
      timestamp: "2026-08-24T00:00:00.000Z",
    });
  });

  it("rejects malformed or oversized cursors", () => {
    expect(decodeHistoryCursor("not-a-cursor")).toBeNull();
    expect(decodeHistoryCursor("x".repeat(513))).toBeNull();
    expect(encodeHistoryCursor({ id: 0, timestamp: "2026-08-24" })).toBeNull();
  });
});
