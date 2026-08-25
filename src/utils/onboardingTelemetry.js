const ONBOARDING_FUNNEL_EVENT_NAMES = Object.freeze([
  "onboarding_started",
  "step_reached:permissions",
  "step_reached:activation",
  "onboarding_completed",
  "first_dictation_attempt",
  "first_successful_dictation",
]);

const ONBOARDING_FUNNEL_EVENTS = new Set(ONBOARDING_FUNNEL_EVENT_NAMES);

function normalizeOnboardingFunnelEventName(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return ONBOARDING_FUNNEL_EVENTS.has(normalized) ? normalized : null;
}

function buildOnboardingFunnelSentryEvent(value) {
  const eventName = normalizeOnboardingFunnelEventName(value);
  if (!eventName) return null;

  return {
    message: "ChordVox onboarding funnel milestone",
    level: "info",
    tags: {
      funnel_event: eventName,
      payload_class: "fixed_milestone_only",
    },
  };
}

module.exports = {
  ONBOARDING_FUNNEL_EVENT_NAMES,
  buildOnboardingFunnelSentryEvent,
  normalizeOnboardingFunnelEventName,
};
