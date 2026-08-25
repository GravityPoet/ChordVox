import { describe, expect, it } from "vitest";
import { markDeletedModelUnavailable, type ModelDownloadState } from "./modelDeletionState";

describe("markDeletedModelUnavailable", () => {
  it("clears stale installed metadata for the deleted model", () => {
    const models: ModelDownloadState[] = [
      {
        model: "parakeet-tdt-0.6b-v2",
        downloaded: true,
        size_mb: 622,
        size_bytes: 652214272,
        path: "/models/parakeet-tdt-0.6b-v2",
      },
      { model: "parakeet-tdt-0.6b-v3", downloaded: false },
    ];

    const result = markDeletedModelUnavailable(models, "parakeet-tdt-0.6b-v2");

    expect(result[0]).toMatchObject({ model: "parakeet-tdt-0.6b-v2", downloaded: false });
    expect(result[0].size_mb).toBeUndefined();
    expect(result[0].size_bytes).toBeUndefined();
    expect(result[0].path).toBeUndefined();
    expect(result[1]).toBe(models[1]);
    expect(models[0].downloaded).toBe(true);
  });

  it("leaves the list unchanged when the deleted model is absent", () => {
    const models: ModelDownloadState[] = [{ model: "parakeet-tdt-0.6b-v3", downloaded: true }];

    const result = markDeletedModelUnavailable(models, "parakeet-tdt-0.6b-v2");

    expect(result).toEqual(models);
    expect(result[0]).toBe(models[0]);
  });
});
