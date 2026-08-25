export const ONBOARDING_STEPS = ["welcome", "permissions", "activation"] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_WELCOME_STEP_INDEX = ONBOARDING_STEPS.indexOf("welcome");
export const ONBOARDING_PERMISSIONS_STEP_INDEX = ONBOARDING_STEPS.indexOf("permissions");
export const ONBOARDING_ACTIVATION_STEP_INDEX = ONBOARDING_STEPS.indexOf("activation");

export function normalizeOnboardingStep(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return ONBOARDING_WELCOME_STEP_INDEX;
  }

  return Math.min(Math.floor(parsed), ONBOARDING_STEPS.length - 1);
}
