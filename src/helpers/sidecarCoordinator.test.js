import { describe, expect, it, vi } from "vitest";
import SidecarCoordinator from "./sidecarCoordinator";

describe("SidecarCoordinator", () => {
  it("does not let an older owner stop a newer sidecar generation", async () => {
    const stopServer = vi.fn(async () => ({ success: true }));
    const coordinator = new SidecarCoordinator();
    coordinator.register("paraformer", { stopServer });
    const first = coordinator.begin("paraformer", "prewarm:1");
    const second = coordinator.begin("paraformer", "prewarm:2");

    expect((await coordinator.stopOwned(first)).skipped).toBe(true);
    expect(coordinator.isCurrent(second)).toBe(true);
    expect(stopServer).not.toHaveBeenCalled();
  });

  it("force-stops every registered sidecar during shutdown", async () => {
    const first = vi.fn(async () => ({ success: true }));
    const second = vi.fn(async () => ({ success: true }));
    const coordinator = new SidecarCoordinator();
    coordinator.register("whisper", { stopServer: first });
    coordinator.register("parakeet", { stopServer: second });

    await coordinator.stopAll("app_quit");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(coordinator.begin("whisper", "late")).toBeNull();
  });
});
