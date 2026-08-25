import { describe, expect, it } from "vitest";
import { getNebulaLightAmplitude } from "./useCapsuleAmplitude";

describe("nebula light amplitude", () => {
  it("preserves quiet and medium feedback while gently compressing loud peaks", () => {
    expect(getNebulaLightAmplitude(-1)).toBe(0);
    expect(getNebulaLightAmplitude(0.35)).toBe(0.35);
    expect(getNebulaLightAmplitude(0.5)).toBe(0.5);
    expect(getNebulaLightAmplitude(0.75)).toBeCloseTo(0.66);
    expect(getNebulaLightAmplitude(1)).toBeCloseTo(0.82);
    expect(getNebulaLightAmplitude(2)).toBeCloseTo(0.82);
  });
});
