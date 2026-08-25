import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SerialTaskQueue } = require("./serialTaskQueue");

describe("SerialTaskQueue", () => {
  it("runs queued tasks in submission order", async () => {
    const queue = new SerialTaskQueue();
    const events = [];

    const first = queue.run(async () => {
      events.push("first:start");
      await Promise.resolve();
      events.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("continues after a failed task without hiding the failure", async () => {
    const queue = new SerialTaskQueue();
    const events = [];

    const failed = queue.run(async () => {
      events.push("failed");
      throw new Error("expected failure");
    });
    const recovered = queue.run(async () => {
      events.push("recovered");
      return "ok";
    });

    await expect(failed).rejects.toThrow("expected failure");
    await expect(recovered).resolves.toBe("ok");
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(events).toEqual(["failed", "recovered"]);
  });
});
