import { describe, expect, it } from "vitest";

import {
  ONBOARDING_ACTIVATION_STEP_INDEX,
  ONBOARDING_STEPS,
  normalizeOnboardingStep,
} from "./onboardingSteps";

describe("onboarding step boundaries", () => {
  it("keeps the shared activation step aligned with the current flow", () => {
    expect(ONBOARDING_STEPS).toEqual(["welcome", "permissions", "activation"]);
    expect(ONBOARDING_ACTIVATION_STEP_INDEX).toBe(ONBOARDING_STEPS.length - 1);
  });

  it.each([
    [null, 0],
    ["not-a-step", 0],
    ["-1", 0],
    ["1", 1],
    ["2", 2],
    ["5", 2],
  ])("normalizes stored value %s to %s", (value, expected) => {
    expect(normalizeOnboardingStep(value)).toBe(expected);
  });
});
