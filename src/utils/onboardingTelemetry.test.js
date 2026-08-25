import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  ONBOARDING_FUNNEL_EVENT_NAMES,
  buildOnboardingFunnelSentryEvent,
  normalizeOnboardingFunnelEventName,
} = require("./onboardingTelemetry");

describe("onboarding telemetry payload", () => {
  it("accepts only the fixed content-free milestone allowlist", () => {
    expect(ONBOARDING_FUNNEL_EVENT_NAMES).toHaveLength(6);
    expect(normalizeOnboardingFunnelEventName("first_dictation_attempt")).toBe(
      "first_dictation_attempt"
    );
    expect(normalizeOnboardingFunnelEventName(" onboarding_completed ")).toBe(
      "onboarding_completed"
    );
    expect(normalizeOnboardingFunnelEventName("transcript: private words")).toBeNull();
    expect(normalizeOnboardingFunnelEventName({ event: "onboarding_started" })).toBeNull();
  });

  it("builds a payload with no caller-controlled content or timestamp", () => {
    const payload = buildOnboardingFunnelSentryEvent("first_successful_dictation");

    expect(payload).toEqual({
      message: "ChordVox onboarding funnel milestone",
      level: "info",
      tags: {
        funnel_event: "first_successful_dictation",
        payload_class: "fixed_milestone_only",
      },
    });
    expect(payload).not.toHaveProperty("extra");
    expect(payload).not.toHaveProperty("timestamp");
  });
});
