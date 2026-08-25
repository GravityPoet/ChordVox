import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ParakeetWsServer = require("./parakeetWsServer");
const { getStartupTimeoutMs } = ParakeetWsServer;

describe("Parakeet WS startup timeout", () => {
  it("allows extra model-load time for x64 processes emulated on Windows ARM", () => {
    expect(
      getStartupTimeoutMs({
        platform: "win32",
        processorIdentifier: "ARMv8 (64-bit) Family 8 Model 0 Revision 0, QEMU",
      })
    ).toBe(120000);
  });

  it("keeps the existing timeout on native Windows x64", () => {
    expect(
      getStartupTimeoutMs({
        platform: "win32",
        processorIdentifier: "Intel64 Family 6 Model 154 Stepping 3, GenuineIntel",
      })
    ).toBe(60000);
  });

  it("does not change non-Windows startup behavior", () => {
    expect(
      getStartupTimeoutMs({
        platform: "darwin",
        processorIdentifier: "ARM",
      })
    ).toBe(60000);
  });

  it("aborts readiness waits without leaving a dangling promise", async () => {
    const server = new ParakeetWsServer();
    const controller = new AbortController();
    const wait = server._waitForReady(new Promise(() => {}), () => ({}), controller.signal);

    controller.abort();

    await expect(wait).rejects.toMatchObject({
      name: "AbortError",
      code: "ERR_LOCAL_TRANSCRIPTION_CANCELLED",
    });
  });

  it("does not swallow cancellation during warm-up", async () => {
    const server = new ParakeetWsServer();
    const controller = new AbortController();
    const error = Object.assign(new Error("cancelled"), { name: "AbortError" });
    server.transcribe = async () => {
      throw error;
    };

    await expect(server._warmUp(controller.signal)).rejects.toBe(error);
  });
});
