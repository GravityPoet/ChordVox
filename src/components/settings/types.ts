import type { LicenseStatusResult } from "../../types/electron";

export type ProAccessResult = {
  allowed: boolean;
  declinedTrial: boolean;
  status: LicenseStatusResult | null;
};
