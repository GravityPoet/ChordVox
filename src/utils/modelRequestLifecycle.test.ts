import { describe, expect, it } from "vitest";
import { APP_SHUTTING_DOWN_CODE, isAppShuttingDownError } from "./modelRequestLifecycle";

describe("model request lifecycle errors", () => {
  it("recognizes the IPC shutdown sentinel by code", () => {
    expect(isAppShuttingDownError({ code: APP_SHUTTING_DOWN_CODE })).toBe(true);
  });

  it("recognizes the IPC shutdown sentinel by message", () => {
    expect(isAppShuttingDownError(new Error("Application is shutting down"))).toBe(true);
  });

  it("does not hide unrelated provider failures", () => {
    expect(isAppShuttingDownError({ code: "ERR_NETWORK", message: "Connection refused" })).toBe(
      false
    );
  });
});
