import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const modelRegistryData = require("../models/modelRegistryData.json");
const { getModelExpectedSizeBytes, isModelFileSizeValid } = require("./modelManagerBridge.js");

describe("local model registry integrity metadata", () => {
  it("defines exact size and sha256 for every local GGUF model", () => {
    const models = (modelRegistryData.localProviders || []).flatMap((provider) =>
      (provider.models || []).map((model) => ({ providerId: provider.id, ...model }))
    );

    expect(models.length).toBeGreaterThan(0);

    for (const model of models) {
      expect(model.sizeBytes, model.id).toBeGreaterThan(0);
      expect(model.sha256, model.id).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe("isModelFileSizeValid", () => {
  it("requires exact size when model metadata provides sizeBytes", () => {
    const model = { sizeBytes: 1234 };

    expect(getModelExpectedSizeBytes(model)).toBe(1234);
    expect(isModelFileSizeValid({ size: 1234 }, model)).toBe(true);
    expect(isModelFileSizeValid({ size: 1233 }, model)).toBe(false);
    expect(isModelFileSizeValid({ size: 1235 }, model)).toBe(false);
  });

  it("falls back to the legacy minimum size check without exact metadata", () => {
    expect(isModelFileSizeValid({ size: 1_000_001 }, {})).toBe(true);
    expect(isModelFileSizeValid({ size: 1_000_000 }, {})).toBe(false);
  });
});
