import { useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  Github,
  Key,
  Loader2,
  LogOut,
  Mail,
  Mic,
  Sparkles,
  UserCircle,
} from "lucide-react";
import type { LicenseStatusResult } from "../../types/electron";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Card } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { Progress } from "../ui/progress";
import EfficiencyOverview from "../EfficiencyOverview";
import { SettingsRow } from "../ui/SettingsSection";
import { cn } from "../lib/utils";
import { openExternalLink } from "../../utils/externalLinks";
import { useToast } from "../ui/toastContext";
import { getLicenseStatusLabel, getLocalizedLicenseErrorDescription } from "./utils";
import { MetricCard, SectionHeader, SettingsPanel, SettingsPanelRow } from "./shared";
import { HOSTED_CLOUD_FEATURES_ENABLED } from "../../utils/chordvoxCloud";

const GITHUB_REPOSITORY_URL = "https://github.com/GravityPoet/ChordVox";
const SUPPORT_EMAIL_ADDRESS = "gravitypoet@icloud.com";

type AccountUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

type UsageState = {
  hasLoaded: boolean;
  isPastDue: boolean;
  isTrial: boolean;
  trialDaysLeft: number | null;
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  currentPeriodEnd: string | null;
  isSubscribed: boolean;
  isOverLimit: boolean;
  isApproachingLimit: boolean;
  checkoutLoading: boolean;
  plan?: string;
  openCheckout: () => Promise<{ success: boolean; error?: string }>;
  openBillingPortal: () => Promise<{ success: boolean; error?: string }>;
} | null;

type LicenseValidationFeedback = {
  ok: boolean;
  title: string;
  description: string;
  at: number;
} | null;

type LicenseBusyAction = "activate" | "validate" | "clear" | null;

export interface AccountSectionProps {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AccountUser | null;
  usage: UsageState;
  licenseStatus: LicenseStatusResult | null;
  licenseKeyInput: string;
  setLicenseKeyInput: (value: string) => void;
  showLicenseKeyInput: boolean;
  setShowLicenseKeyInput: (value: boolean) => void;
  licenseBusyAction: LicenseBusyAction;
  licenseValidationFeedback: LicenseValidationFeedback;
  trialOfferAvailable: boolean;
  startProTrialFromAccount: () => Promise<void>;
  openLicensePurchasePage: (
    source: string,
    metadata?: Record<string, string>
  ) => Promise<void> | void;
  handleActivateLicense: () => Promise<void> | void;
  handleValidateLicense: () => Promise<void> | void;
  handleClearLicense: () => Promise<void> | void;
  handleSignOut: () => Promise<void> | void;
  isSigningOut: boolean;
  showAlertDialog: (dialog: { title: string; description?: string }) => void;
}

export function AccountSection({
  isLoaded,
  isSignedIn,
  user,
  usage,
  licenseStatus,
  licenseKeyInput,
  setLicenseKeyInput,
  showLicenseKeyInput,
  setShowLicenseKeyInput,
  licenseBusyAction,
  licenseValidationFeedback,
  trialOfferAvailable,
  startProTrialFromAccount,
  openLicensePurchasePage,
  handleActivateLicense,
  handleValidateLicense,
  handleClearLicense,
  handleSignOut,
  isSigningOut,
  showAlertDialog,
}: AccountSectionProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [isOpeningBilling, setIsOpeningBilling] = useState(false);

  const handleSupportExternalClick = async (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    const result = await openExternalLink(url, { showError: false });
    if (!result.success) {
      showAlertDialog({
        title: t("support.openFailed.title"),
        description: t("support.openFailed.description", { url }),
      });
    }
  };

  const handleSupportEmailCopy = async () => {
    const result = await window.electronAPI?.writeClipboard?.(SUPPORT_EMAIL_ADDRESS);
    if (result?.success) {
      toast({
        title: t("support.emailCopied.title"),
        description: t("support.emailCopied.description", { email: SUPPORT_EMAIL_ADDRESS }),
        variant: "success",
      });
      return;
    }

    showAlertDialog({
      title: t("support.copyFailed.title"),
      description: t("support.copyFailed.description", { email: SUPPORT_EMAIL_ADDRESS }),
    });
  };

  const renderSupportFooter = () => (
    <section
      className="border-t border-border/35 px-1 pt-4"
      data-testid="account-support-card"
      aria-labelledby="account-support-title"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h3
            id="account-support-title"
            className="text-[13px] font-semibold leading-5 tracking-[-0.01em] text-foreground"
          >
            {t("support.card.title")}
          </h3>
          <p className="text-pretty text-[12px] leading-5 text-muted-foreground/75">
            {t("support.card.description")}
          </p>
        </div>

        <nav
          className="grid gap-1.5 sm:grid-cols-2 lg:shrink-0"
          aria-label={t("support.card.title")}
        >
          <a
            href={GITHUB_REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => void handleSupportExternalClick(event, GITHUB_REPOSITORY_URL)}
            className="group flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl border border-border/45 bg-background/25 px-3 py-2 text-left !text-foreground transition-[background-color,border-color,color] duration-150 hover:border-border/75 hover:bg-muted/45 hover:!text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="account-support-github"
            aria-label={`${t("support.card.github")} — GravityPoet/ChordVox`}
          >
            <Github
              className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium leading-4">
                {t("support.card.github")}
              </span>
              <span
                className="block max-w-44 truncate text-[11px] leading-4 text-muted-foreground/70"
                translate="no"
              >
                GravityPoet/ChordVox
              </span>
            </span>
            <ExternalLink
              className="h-3 w-3 shrink-0 text-muted-foreground/55 transition-colors group-hover:text-foreground"
              aria-hidden="true"
            />
          </a>

          <button
            type="button"
            onClick={() => void handleSupportEmailCopy()}
            className="group flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl border border-border/45 bg-background/25 px-3 py-2 text-left !text-foreground transition-[background-color,border-color,color] duration-150 hover:border-border/75 hover:bg-muted/45 hover:!text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="account-support-email"
            aria-label={`${t("support.card.email")} — ${t("support.card.emailAddress")}`}
          >
            <Mail
              className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium leading-4">
                {t("support.card.email")}
              </span>
              <span
                className="block max-w-52 truncate text-[11px] leading-4 text-muted-foreground/70"
                translate="no"
              >
                {t("support.card.emailAddress")}
              </span>
            </span>
            <Copy
              className="h-3 w-3 shrink-0 text-muted-foreground/55 transition-colors group-hover:text-foreground"
              aria-hidden="true"
            />
          </button>
        </nav>
      </div>
    </section>
  );

  const renderLicensePanel = () => {
    const status = licenseStatus?.status;
    const isActive = Boolean(licenseStatus?.isActive);
    const keyPresent = Boolean(licenseStatus?.keyPresent);
    const isTrial =
      licenseStatus?.plan === "trial" &&
      !keyPresent &&
      isActive &&
      Boolean(licenseStatus?.trialActive);
    const isExpiredTrial =
      licenseStatus?.plan === "trial" &&
      !keyPresent &&
      !isActive &&
      Boolean(licenseStatus?.trialStartedAt || licenseStatus?.trialExpiresAt) &&
      (status === "expired" || licenseStatus?.trialActive === false);
    const shouldShowTrialReminder =
      isTrial && (licenseStatus?.trialDaysLeft === 7 || licenseStatus?.trialDaysLeft === 1);
    // Drive the monthly→yearly upsell off the Creem license-key system (licenseStatus),
    // NOT the cloud-subscription usage feed. The website funnels 100% through Creem, whose
    // license `plan` encodes the billing period ("monthly"); the cloud `usage.plan` only
    // ever reports "pro" and cannot tell month from year — using it mislabels yearly users.
    // `=== "monthly"` never false-positives on yearly/lifetime, so the card stays correct
    // even if some licenses come back with a generic plan.
    const isMonthlyPro = licenseStatus?.plan === "monthly";
    let daysUntilExpiry: number | null = null;
    if (isMonthlyPro && licenseStatus?.expiresAt) {
      const expiryDate = new Date(licenseStatus.expiresAt);
      const diffTime = expiryDate.getTime() - Date.now();
      daysUntilExpiry = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
    const shouldShowUpgradeReminder =
      isMonthlyPro && daysUntilExpiry !== null && daysUntilExpiry <= 7 && daysUntilExpiry >= 0;
    const showKeyInput = !isActive || !keyPresent || showLicenseKeyInput;
    const licenseBadgeVariant: "success" | "warning" | "destructive" | "outline" =
      isTrial || isExpiredTrial || status === "active"
        ? "success"
        : status === "offline_grace"
          ? "warning"
          : status === "expired" || status === "invalid"
            ? "destructive"
            : "outline";

    const currentStatusDescription =
      licenseStatus?.error === "LICENSE_SERVER_NOT_CONFIGURED"
        ? t("settingsPage.account.desktopLicense.currentStatusNotConfigured")
        : getLocalizedLicenseErrorDescription(licenseStatus?.error, t) ||
          (isTrial
            ? licenseStatus?.trialActive
              ? t("settingsPage.account.desktopLicense.currentStatusTrialDescription", {
                  days: licenseStatus?.trialDaysLeft ?? licenseStatus?.trialDays ?? 0,
                })
              : t("settingsPage.account.desktopLicense.currentStatusTrialExpiredDescription")
            : licenseStatus?.isActive
              ? t("settingsPage.account.desktopLicense.currentStatusActiveDescription")
              : t("settingsPage.account.desktopLicense.currentStatusDescription"));
    const currentStatusLabel = isExpiredTrial
      ? t("settingsPage.account.badges.freeForever")
      : isTrial
        ? t("settingsPage.account.badges.trial")
        : getLicenseStatusLabel(status, t);
    const condensedStatusDescription = shouldShowTrialReminder
      ? undefined
      : currentStatusDescription;

    return (
      <div className="space-y-5">
        {trialOfferAvailable && (
          <Alert className="glass-panel glass-panel--featured pro-upgrade-card flow-border hover-lift overflow-hidden py-4 shadow-sm backdrop-blur-md">
            <div className="flex items-start gap-3">
              <div className="glass-chip glass-chip--featured mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl shadow-sm">
                <Sparkles className="pro-sparkle-icon h-4 w-4 shrink-0 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <AlertTitle className="mb-1.5 text-[16px] leading-snug">
                  {t("settingsPage.account.trialCta.title")}
                </AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>{t("settingsPage.account.trialCta.description")}</p>
                  <Button
                    size="sm"
                    onClick={() => void startProTrialFromAccount()}
                    className="pro-cta-gradient"
                  >
                    {t("settingsPage.account.trialCta.button")}
                  </Button>
                </AlertDescription>
              </div>
            </div>
          </Alert>
        )}
        {shouldShowTrialReminder && (
          <Card
            variant="featured"
            className="pro-upgrade-card flow-border hover-lift overflow-hidden px-5 py-4 backdrop-blur-xl"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="glass-chip glass-chip--featured flex h-9 w-9 items-center justify-center rounded-[var(--radius-lg)] shadow-sm">
                    <Sparkles className="pro-sparkle-icon h-4 w-4 text-primary" />
                  </div>
                  <Badge
                    variant="outline"
                    className="glass-chip glass-chip--featured h-7 rounded-full px-3 text-[11px] font-semibold tracking-normal text-primary"
                  >
                    {t("settingsPage.account.planLabels.free")}
                  </Badge>
                  <Badge
                    variant="neutral"
                    className="glass-chip glass-chip--muted h-7 rounded-full px-3 text-[11px] font-medium tracking-normal text-foreground/75"
                  >
                    {t("settingsPage.account.trialReminder.title", {
                      days: licenseStatus?.trialDaysLeft,
                    })}
                  </Badge>
                </div>

                <div className="space-y-1">
                  <p className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-foreground">
                    {t("settingsPage.account.trialReminder.headline", {
                      days: licenseStatus?.trialDaysLeft,
                    })}
                  </p>
                  <p className="max-w-3xl text-[14px] leading-5 text-muted-foreground/88">
                    {t("settingsPage.account.trialReminder.description", {
                      days: licenseStatus?.trialDaysLeft,
                    })}
                  </p>
                </div>
              </div>

              <Button
                size="sm"
                className="pro-cta-btn h-10 shrink-0 px-4 sm:self-center"
                onClick={() =>
                  openLicensePurchasePage("pro-trial-reminder", {
                    days: String(licenseStatus?.trialDaysLeft || ""),
                  })
                }
              >
                {t("settingsPage.account.trialReminder.button")}
              </Button>
            </div>
          </Card>
        )}
        {shouldShowUpgradeReminder && (
          <Card
            variant="featured"
            className="pro-upgrade-card flow-border hover-lift overflow-hidden px-5 py-4 backdrop-blur-xl mb-5"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="glass-chip glass-chip--featured flex h-9 w-9 items-center justify-center rounded-[var(--radius-lg)] shadow-sm">
                    <Sparkles className="pro-sparkle-icon h-4 w-4 text-primary" />
                  </div>
                  <Badge
                    variant="outline"
                    className="glass-chip glass-chip--featured h-7 rounded-full px-3 text-[11px] font-semibold tracking-normal text-primary"
                  >
                    {t("settingsPage.account.planLabels.pro")}
                  </Badge>
                  <Badge
                    variant="neutral"
                    className="glass-chip glass-chip--muted h-7 rounded-full px-3 text-[11px] font-medium tracking-normal text-foreground/75"
                  >
                    {t("settingsPage.account.monthlyReminder.badge", {
                      days: daysUntilExpiry,
                    })}
                  </Badge>
                </div>

                <div className="space-y-1">
                  <p className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-foreground">
                    {t("settingsPage.account.monthlyReminder.headline")}
                  </p>
                  <p className="max-w-3xl text-[14px] leading-5 text-muted-foreground/88">
                    {t("settingsPage.account.monthlyReminder.description", {
                      days: daysUntilExpiry,
                    })}
                  </p>
                </div>
              </div>

              <Button
                size="sm"
                className="pro-cta-btn h-10 shrink-0 px-4 sm:self-center"
                onClick={() => {
                  // Monthly users hold a Creem license key (system ①), which has no Stripe
                  // billing portal — openBillingPortal is the cloud-subscription path (system ②)
                  // and would not resolve for them. Route the yearly upgrade through the same
                  // Creem checkout funnel the website uses so the link lands on a payable plan.
                  void openLicensePurchasePage("monthly-to-yearly-upgrade", {
                    intent: "upgrade",
                    plan: "yearly",
                  });
                }}
              >
                {t("settingsPage.account.monthlyReminder.button")}
              </Button>
            </div>
          </Card>
        )}
        <div className="account-status-card">
          <span className="border-beam" aria-hidden />
          <div className="account-status-card__header">
            <div className="min-w-0 space-y-1">
              <p className="text-[16px] font-semibold leading-snug text-foreground">
                {t("settingsPage.account.desktopLicense.currentStatusLabel")}
              </p>
              {condensedStatusDescription ? (
                <p className="max-w-3xl text-[14px] leading-5 text-muted-foreground/88">
                  {condensedStatusDescription}
                </p>
              ) : null}
            </div>
            <Badge className="account-status-card__badge" variant={licenseBadgeVariant}>
              {currentStatusLabel}
            </Badge>
          </div>

          <div className="account-status-card__body">
            <div className="space-y-3">
              {showKeyInput && (
                <Input
                  name="licenseKey"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-label={t("settingsPage.account.desktopLicense.inputPlaceholder")}
                  value={licenseKeyInput}
                  onChange={(event) => setLicenseKeyInput(event.target.value)}
                  placeholder={t("settingsPage.account.desktopLicense.inputPlaceholder")}
                  className="account-status-card__input h-10 text-sm"
                />
              )}

              <div className="flex flex-wrap items-center gap-2">
                {showKeyInput ? (
                  <Button
                    size="sm"
                    className="pro-cta-gradient h-9 px-4"
                    onClick={() => void handleActivateLicense()}
                    disabled={licenseBusyAction !== null}
                  >
                    {licenseBusyAction === "activate" ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        {t("settingsPage.account.desktopLicense.actions.activating")}
                      </>
                    ) : (
                      t("settingsPage.account.desktopLicense.actions.activate")
                    )}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 px-4"
                    onClick={() => setShowLicenseKeyInput(true)}
                    disabled={licenseBusyAction !== null}
                  >
                    {t("settingsPage.account.desktopLicense.actions.changeKey")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 px-4"
                  onClick={() => void handleValidateLicense()}
                  disabled={licenseBusyAction !== null || !keyPresent}
                >
                  {licenseBusyAction === "validate" ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      {t("settingsPage.account.desktopLicense.actions.checking")}
                    </>
                  ) : (
                    t("settingsPage.account.desktopLicense.actions.validate")
                  )}
                </Button>
                {keyPresent && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 px-4"
                    onClick={() => void handleClearLicense()}
                    disabled={licenseBusyAction !== null}
                  >
                    {t("settingsPage.account.desktopLicense.actions.clear")}
                  </Button>
                )}
              </div>
              {licenseBusyAction === "validate" && (
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Loader2 size={12} className="animate-spin shrink-0" />
                  <span>
                    {t("settingsPage.account.desktopLicense.toasts.validatingDescription")}
                  </span>
                </div>
              )}
              {licenseBusyAction !== "validate" && licenseValidationFeedback && (
                <Alert
                  variant={licenseValidationFeedback.ok ? "success" : "destructive"}
                  className="py-2"
                >
                  <AlertTitle className="text-[14px]">{licenseValidationFeedback.title}</AlertTitle>
                  <AlertDescription className="text-[13px]">
                    <div className="space-y-1">
                      <p>{licenseValidationFeedback.description}</p>
                      <p className="text-current/70">
                        {new Date(licenseValidationFeedback.at).toLocaleString(i18n.language)}
                      </p>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              <div className="account-status-card__meta">
                {licenseStatus?.plan && (
                  <p>
                    {t("settingsPage.account.desktopLicense.meta.plan", {
                      plan: licenseStatus.plan,
                    })}
                  </p>
                )}
                {licenseStatus?.expiresAt && (
                  <p>
                    {t("settingsPage.account.desktopLicense.meta.expires", {
                      date: new Date(licenseStatus.expiresAt).toLocaleString(i18n.language),
                    })}
                  </p>
                )}
                {!licenseStatus?.expiresAt && isActive && keyPresent && !isTrial && (
                  <p>{t("settingsPage.account.desktopLicense.meta.expiresPermanent")}</p>
                )}
                {licenseStatus?.lastValidatedAt && (
                  <p>
                    {t("settingsPage.account.desktopLicense.meta.lastCheck", {
                      date: new Date(licenseStatus.lastValidatedAt).toLocaleString(i18n.language),
                    })}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // The shipped desktop product is license-key based and has no account gate.
  // Retain the hosted-account implementation for future builds, but never
  // expose it unless the hosted cloud feature itself is explicitly enabled.
  const accountAuthEnabled = false;
  const showOuterLicensePanel = !accountAuthEnabled || !isLoaded || !isSignedIn || !user;

  return (
    <div className="space-y-5 pt-3">
      {showOuterLicensePanel && renderLicensePanel()}
      {accountAuthEnabled &&
        (isLoaded && isSignedIn && user ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_320px] xl:items-start">
            <div className="space-y-5">
              {renderLicensePanel()}

              {HOSTED_CLOUD_FEATURES_ENABLED && (
                <div className="space-y-3">
                  <SectionHeader title={t("settingsPage.account.planTitle")} />
                  {!usage || !usage.hasLoaded ? (
                    <SettingsPanel>
                      <SettingsPanelRow>
                        <div className="flex items-center justify-between">
                          <Skeleton className="h-4 w-24" />
                          <Skeleton className="h-5 w-16 rounded-full" />
                        </div>
                      </SettingsPanelRow>
                      <SettingsPanelRow>
                        <div className="space-y-2">
                          <Skeleton className="h-3 w-48" />
                          <Skeleton className="h-8 w-full rounded" />
                        </div>
                      </SettingsPanelRow>
                    </SettingsPanel>
                  ) : (
                    <div className="space-y-4">
                      <SettingsPanel>
                        {usage.isPastDue && (
                          <SettingsPanelRow>
                            <Alert variant="warning">
                              <AlertTriangle className="h-4 w-4" />
                              <AlertTitle>{t("settingsPage.account.pastDue.title")}</AlertTitle>
                              <AlertDescription>
                                {t("settingsPage.account.pastDue.description")}
                              </AlertDescription>
                            </Alert>
                          </SettingsPanelRow>
                        )}

                        <SettingsPanelRow>
                          <SettingsRow
                            label={
                              usage.isTrial
                                ? t("settingsPage.account.planLabels.trial")
                                : usage.isPastDue
                                  ? t("settingsPage.account.planLabels.free")
                                  : usage.isSubscribed
                                    ? t("settingsPage.account.planLabels.pro")
                                    : t("settingsPage.account.planLabels.free")
                            }
                            description={
                              usage.isTrial
                                ? t("settingsPage.account.planDescriptions.trial", {
                                    days: usage.trialDaysLeft,
                                  })
                                : usage.isPastDue
                                  ? t("settingsPage.account.planDescriptions.pastDue", {
                                      used: usage.wordsUsed.toLocaleString(i18n.language),
                                      limit: usage.limit.toLocaleString(i18n.language),
                                    })
                                  : usage.isSubscribed
                                    ? usage.currentPeriodEnd
                                      ? t("settingsPage.account.planDescriptions.nextBilling", {
                                          date: new Date(usage.currentPeriodEnd).toLocaleDateString(
                                            i18n.language,
                                            {
                                              month: "short",
                                              day: "numeric",
                                              year: "numeric",
                                            }
                                          ),
                                        })
                                      : t("settingsPage.account.planDescriptions.unlimited")
                                    : t("settingsPage.account.planDescriptions.freeUsage", {
                                        used: usage.wordsUsed.toLocaleString(i18n.language),
                                        limit: usage.limit.toLocaleString(i18n.language),
                                      })
                            }
                          >
                            {usage.isTrial ? (
                              <Badge variant="success">
                                {t("settingsPage.account.badges.freeForever")}
                              </Badge>
                            ) : usage.isPastDue ? (
                              <Badge variant="destructive">
                                {t("settingsPage.account.badges.pastDue")}
                              </Badge>
                            ) : usage.isSubscribed ? (
                              <Badge variant="success">
                                {t("settingsPage.account.badges.pro")}
                              </Badge>
                            ) : usage.isOverLimit ? (
                              <Badge variant="warning">
                                {t("settingsPage.account.badges.limitReached")}
                              </Badge>
                            ) : (
                              <Badge variant="outline">
                                {t("settingsPage.account.badges.free")}
                              </Badge>
                            )}
                          </SettingsRow>
                        </SettingsPanelRow>

                        {!usage.isSubscribed && !usage.isTrial && (
                          <SettingsPanelRow>
                            <div className="space-y-1.5">
                              <Progress
                                value={
                                  usage.limit > 0
                                    ? Math.min(100, (usage.wordsUsed / usage.limit) * 100)
                                    : 0
                                }
                                className={cn(
                                  "h-1.5",
                                  usage.isOverLimit
                                    ? "[&>div]:bg-destructive"
                                    : usage.isApproachingLimit
                                      ? "[&>div]:bg-warning"
                                      : "[&>div]:bg-primary"
                                )}
                              />
                              <div className="flex items-center justify-between text-[13px] text-muted-foreground">
                                <span className="tabular-nums">
                                  {usage.wordsUsed.toLocaleString(i18n.language)} /{" "}
                                  {usage.limit.toLocaleString(i18n.language)}
                                </span>
                                {usage.isApproachingLimit && (
                                  <span className="text-warning">
                                    {t("settingsPage.account.wordsRemaining", {
                                      remaining: usage.wordsRemaining.toLocaleString(i18n.language),
                                    })}
                                  </span>
                                )}
                                {!usage.isApproachingLimit && !usage.isOverLimit && (
                                  <span>{t("settingsPage.account.rollingWeeklyLimit")}</span>
                                )}
                              </div>
                            </div>
                          </SettingsPanelRow>
                        )}

                        <SettingsPanelRow>
                          {usage.isPastDue ? (
                            <Button
                              onClick={async () => {
                                setIsOpeningBilling(true);
                                try {
                                  const result = await usage.openBillingPortal();
                                  if (!result.success) {
                                    showAlertDialog({
                                      title: t("settingsPage.account.billing.couldNotOpenTitle"),
                                      description: t(
                                        "settingsPage.account.billing.couldNotOpenDescription"
                                      ),
                                    });
                                  }
                                } finally {
                                  setIsOpeningBilling(false);
                                }
                              }}
                              disabled={isOpeningBilling}
                              size="sm"
                              className="w-full"
                            >
                              {isOpeningBilling ? (
                                <>
                                  <Loader2 size={14} className="animate-spin" />
                                  {t("settingsPage.account.billing.opening")}
                                </>
                              ) : (
                                t("settingsPage.account.billing.updatePaymentMethod")
                              )}
                            </Button>
                          ) : usage.isSubscribed && !usage.isTrial ? (
                            <Button
                              onClick={async () => {
                                const result = await usage.openBillingPortal();
                                if (!result.success) {
                                  showAlertDialog({
                                    title: t("settingsPage.account.billing.couldNotOpenTitle"),
                                    description: t(
                                      "settingsPage.account.billing.couldNotOpenDescription"
                                    ),
                                  });
                                }
                              }}
                              variant="outline"
                              size="sm"
                              className="w-full"
                              disabled={usage.checkoutLoading}
                            >
                              {usage.checkoutLoading
                                ? t("settingsPage.account.billing.opening")
                                : t("settingsPage.account.billing.manageBilling")}
                            </Button>
                          ) : (
                            <Button
                              onClick={async () => {
                                const result = await usage.openCheckout();
                                if (!result.success) {
                                  showAlertDialog({
                                    title: t("settingsPage.account.checkout.couldNotOpenTitle"),
                                    description: t(
                                      "settingsPage.account.checkout.couldNotOpenDescription"
                                    ),
                                  });
                                }
                              }}
                              size="sm"
                              className="w-full"
                              disabled={usage.checkoutLoading}
                            >
                              {usage.checkoutLoading
                                ? t("settingsPage.account.checkout.opening")
                                : t("settingsPage.account.checkout.upgradeToPro")}
                            </Button>
                          )}
                        </SettingsPanelRow>
                      </SettingsPanel>

                      <div className="grid gap-3 md:grid-cols-3">
                        <MetricCard
                          icon={Sparkles}
                          eyebrow={t("settingsPage.account.planTitle")}
                          value={
                            usage.isTrial
                              ? t("settingsPage.account.badges.freeForever")
                              : usage.isSubscribed
                                ? t("settingsPage.account.badges.pro")
                                : t("settingsPage.account.badges.free")
                          }
                          label={
                            usage.isSubscribed && usage.currentPeriodEnd
                              ? new Date(usage.currentPeriodEnd).toLocaleDateString(i18n.language, {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                })
                              : t("settingsPage.account.rollingWeeklyLimit")
                          }
                          tone="accent"
                        />
                        <MetricCard
                          icon={Mic}
                          eyebrow={t("settingsPage.account.efficiencyOverview.cards.words.label")}
                          value={usage.wordsUsed.toLocaleString(i18n.language)}
                          label={
                            usage.limit > 0
                              ? `${usage.limit.toLocaleString(i18n.language)}`
                              : t("settingsPage.account.planDescriptions.unlimited")
                          }
                        />
                        <MetricCard
                          icon={Key}
                          eyebrow={t("settingsPage.account.desktopLicense.currentStatusLabel")}
                          value={
                            usage.isPastDue
                              ? t("settingsPage.account.badges.pastDue")
                              : usage.isOverLimit
                                ? t("settingsPage.account.badges.limitReached")
                                : t("common.active")
                          }
                          label={
                            usage.isApproachingLimit
                              ? t("settingsPage.account.wordsRemaining", {
                                  remaining: usage.wordsRemaining.toLocaleString(i18n.language),
                                })
                              : t("settingsPage.account.planDescriptions.unlimited")
                          }
                          tone={usage.isSubscribed || usage.isTrial ? "success" : "default"}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <EfficiencyOverview />
            </div>

            <div className="space-y-5">
              <section className="premium-panel premium-panel--hero flow-border shimmer-on-mount px-5 py-5">
                <span className="border-beam" aria-hidden />
                <div className="flex items-start gap-4">
                  <div className="glass-chip glass-chip--accent flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full">
                    {user.image ? (
                      <img
                        src={user.image}
                        alt={user.name || t("settingsPage.account.user")}
                        className="h-12 w-12 rounded-full object-cover"
                      />
                    ) : (
                      <UserCircle className="h-6 w-6 text-primary" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                      {t("settingsPage.account.title")}
                    </p>
                    <p className="mt-2 truncate text-[18px] font-semibold tracking-[-0.02em] text-foreground">
                      {user.name || t("settingsPage.account.user")}
                    </p>
                    <p className="mt-1 truncate text-[14px] text-muted-foreground/80">
                      {user.email}
                    </p>
                  </div>
                  <Badge variant="success">{t("settingsPage.account.signedIn")}</Badge>
                </div>

                <div className="glass-panel glass-panel--soft mt-5 rounded-[var(--radius-lg)] px-4 py-3">
                  <p className="text-[14px] font-medium text-foreground">
                    {t("settingsPage.account.planTitle")}
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground/80">
                    {usage?.isSubscribed
                      ? t("settingsPage.account.planDescriptions.unlimited")
                      : t("settingsPage.account.planDescriptions.freeUsage", {
                          used: usage?.wordsUsed?.toLocaleString(i18n.language) || "0",
                          limit: usage?.limit?.toLocaleString(i18n.language) || "0",
                        })}
                  </p>
                </div>

                <div className="mt-5">
                  <Button
                    onClick={() => void handleSignOut()}
                    variant="outline"
                    disabled={isSigningOut}
                    size="sm"
                    className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
                  >
                    <LogOut className="mr-1.5 h-3.5 w-3.5" />
                    {isSigningOut
                      ? t("settingsPage.account.signOut.signingOut")
                      : t("settingsPage.account.signOut.signOut")}
                  </Button>
                </div>
              </section>
            </div>
          </div>
        ) : isLoaded ? (
          <>
            <SectionHeader title={t("settingsPage.account.title")} />
            <SettingsPanel>
              <SettingsPanelRow>
                <SettingsRow
                  label={t("settingsPage.account.notSignedIn")}
                  description={t("settingsPage.account.notSignedInDescription")}
                >
                  <Badge variant="outline">{t("settingsPage.account.offline")}</Badge>
                </SettingsRow>
              </SettingsPanelRow>
            </SettingsPanel>

            <Card
              variant="featured"
              className="pro-upgrade-card flow-border hover-lift p-4 backdrop-blur-lg"
            >
              <div className="flex items-start gap-3">
                <div className="glass-chip glass-chip--featured mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl shadow-sm">
                  <Sparkles className="pro-sparkle-icon w-4 h-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1 space-y-2.5">
                  <div>
                    <p className="text-[14px] font-medium text-foreground">
                      {t("settingsPage.account.trialCta.title")}
                    </p>
                    <p className="text-[13px] text-muted-foreground leading-relaxed mt-0.5">
                      {t("settingsPage.account.trialCta.description")}
                    </p>
                  </div>
                  <Button
                    id="pro-upgrade-cta"
                    onClick={() => {
                      if (trialOfferAvailable) {
                        void startProTrialFromAccount();
                        return;
                      }
                      void openLicensePurchasePage("upgrade-pro");
                    }}
                    size="sm"
                    className="pro-cta-gradient w-full"
                  >
                    <Key className="mr-1.5 h-3.5 w-3.5" />
                    {trialOfferAvailable
                      ? t("settingsPage.account.trialCta.button")
                      : t("settingsPage.account.trialReminder.button")}
                  </Button>
                </div>
              </div>
            </Card>
          </>
        ) : (
          <>
            <SectionHeader title={t("settingsPage.account.title")} />
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="flex items-center justify-between">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          </>
        ))}

      {showOuterLicensePanel && (
        <div className="border-t border-border/40 pt-5">
          <EfficiencyOverview />
        </div>
      )}

      {renderSupportFooter()}
    </div>
  );
}
