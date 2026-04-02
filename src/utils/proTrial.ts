import type { LicenseStatusResult } from "../types/electron";

export function canStartProTrial(status?: LicenseStatusResult | null): boolean {
  if (!status) return false;

  const hasStartedTrial = Boolean(status.trialStartedAt || status.trialExpiresAt);

  return (
    status.trialEnabled !== false &&
    !status.keyPresent &&
    !status.isActive &&
    !hasStartedTrial
  );
}
