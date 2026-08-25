import { describe, it, expect } from "vitest";
import { canStartProTrial } from "./proTrial";
import type { LicenseStatusResult } from "../types/electron";

describe("canStartProTrial", () => {
  it("returns false if status is null or undefined", () => {
    expect(canStartProTrial(null)).toBe(false);
    expect(canStartProTrial(undefined)).toBe(false);
  });

  it("returns true when status satisfies all conditions for a new trial", () => {
    const status: LicenseStatusResult = {
      isActive: false,
      keyPresent: false,
      trialEnabled: true,
      trialStartedAt: null,
      trialExpiresAt: null,
      // Add other required properties of LicenseStatusResult as needed
    } as unknown as LicenseStatusResult;

    expect(canStartProTrial(status)).toBe(true);
  });

  it("returns true even if trialEnabled is omitted (not explicitly false)", () => {
    const status = {
      isActive: false,
      keyPresent: false,
      trialStartedAt: null,
      trialExpiresAt: null,
    } as unknown as LicenseStatusResult;

    expect(canStartProTrial(status)).toBe(true);
  });

  it("returns false if trialEnabled is explicitly false", () => {
    const status = {
      isActive: false,
      keyPresent: false,
      trialEnabled: false,
      trialStartedAt: null,
      trialExpiresAt: null,
    } as unknown as LicenseStatusResult;

    expect(canStartProTrial(status)).toBe(false);
  });

  it("returns false if license key is present", () => {
    const status = {
      isActive: false,
      keyPresent: true,
      trialEnabled: true,
      trialStartedAt: null,
      trialExpiresAt: null,
    } as unknown as LicenseStatusResult;

    expect(canStartProTrial(status)).toBe(false);
  });

  it("returns false if status is already active", () => {
    const status = {
      isActive: true,
      keyPresent: false,
      trialEnabled: true,
      trialStartedAt: null,
      trialExpiresAt: null,
    } as unknown as LicenseStatusResult;

    expect(canStartProTrial(status)).toBe(false);
  });

  it("returns false if trial has already started or expired", () => {
    const statusStarted = {
      isActive: false,
      keyPresent: false,
      trialEnabled: true,
      trialStartedAt: "2026-06-25T20:00:00Z",
      trialExpiresAt: null,
    } as unknown as LicenseStatusResult;

    const statusExpired = {
      isActive: false,
      keyPresent: false,
      trialEnabled: true,
      trialStartedAt: null,
      trialExpiresAt: "2026-06-25T20:00:00Z",
    } as unknown as LicenseStatusResult;

    expect(canStartProTrial(statusStarted)).toBe(false);
    expect(canStartProTrial(statusExpired)).toBe(false);
  });
});
