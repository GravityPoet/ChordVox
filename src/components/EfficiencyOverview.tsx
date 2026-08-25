import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { RefreshCw, Mic, CircleCheckBig, Hourglass, Zap } from "lucide-react";
import { useToast } from "./ui/toastContext";
import type { TranscriptionStats } from "../types/electron";

const SHOW_ONBOARDING_FUNNEL = false;

const EMPTY_STATS: TranscriptionStats = {
  todayUnits: 0,
  totalUnits: 0,
  todayEntries: 0,
  totalEntries: 0,
  totalRecordingDurationMs: 0,
  estimatedTimeSavedMs: 0,
  averageDictationUnitsPerMinute: 0,
  lastUpdatedAt: null,
  statsBackfillPending: false,
};

const ONBOARDING_EVENT_LABEL_KEYS: Record<string, string> = {
  onboarding_started:
    "settingsPage.account.efficiencyOverview.onboardingFunnel.events.onboarding_started",
  "step_reached:permissions":
    "settingsPage.account.efficiencyOverview.onboardingFunnel.events.step_permissions",
  "step_reached:activation":
    "settingsPage.account.efficiencyOverview.onboardingFunnel.events.step_activation",
  onboarding_completed:
    "settingsPage.account.efficiencyOverview.onboardingFunnel.events.onboarding_completed",
  first_successful_dictation:
    "settingsPage.account.efficiencyOverview.onboardingFunnel.events.first_successful_dictation",
};

/** Onboarding event timestamps are UTC. New rows are ISO-8601 with a Z suffix;
    rows written before that used SQLite's "YYYY-MM-DD HH:MM:SS" format, which
    `new Date()` would misparse as local time — normalize before display. */
function parseOnboardingEventTimestamp(timestamp: string): Date | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
    ? `${timestamp.replace(" ", "T")}Z`
    : timestamp;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatOnboardingEventTimestamp(timestamp: string): string {
  const parsed = parseOnboardingEventTimestamp(timestamp);
  return parsed ? parsed.toLocaleString() : timestamp;
}

/** The first database result renders at its real value immediately. Later
    refreshes animate from the previous value and honor reduced motion. */
function useCountUp(target: number, animate: boolean, durationMs = 700): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);

  useLayoutEffect(() => {
    if (
      !animate ||
      durationMs <= 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      fromRef.current === target
    ) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }

    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (target - from) * eased);
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      fromRef.current = target;
    };
  }, [animate, target, durationMs]);

  return animate ? display : target;
}

export default function EfficiencyOverview() {
  const { i18n, t } = useTranslation();
  const { toast } = useToast();
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [stats, setStats] = useState<TranscriptionStats>(EMPTY_STATS);
  const [statsRefreshCount, setStatsRefreshCount] = useState(0);
  const hasLoadedStatsRef = useRef(false);
  const [onboardingEvents, setOnboardingEvents] = useState<
    Array<{ id: number; event_name: string; timestamp: string }>
  >([]);

  const unitLabel = t("settingsPage.account.efficiencyOverview.units.mixed");

  const formatDuration = useCallback(
    (durationMs: number, { allowSubMinute = false }: { allowSubMinute?: boolean } = {}) => {
      const safeDurationMs = Math.max(0, Math.round(Number(durationMs) || 0));
      const totalMinutes = safeDurationMs / 60000;

      if (allowSubMinute && totalMinutes > 0 && totalMinutes < 1) {
        return t("settingsPage.account.efficiencyOverview.duration.subMinute");
      }

      const roundedMinutes = Math.max(0, Math.round(totalMinutes));
      const hours = Math.floor(roundedMinutes / 60);
      const minutes = roundedMinutes % 60;

      if (hours > 0) {
        return t("settingsPage.account.efficiencyOverview.duration.hoursAndMinutes", {
          hours,
          minutes,
        });
      }
      return t("settingsPage.account.efficiencyOverview.duration.minutesOnly", {
        minutes,
      });
    },
    [t]
  );

  const formatSpeed = useCallback(
    (speed: number) => {
      const safeSpeed = Math.max(0, Math.round(Number(speed) || 0));
      return t("settingsPage.account.efficiencyOverview.speed.perMinute", {
        speed: safeSpeed,
        unit: unitLabel,
      });
    },
    [t, unitLabel]
  );

  const loadOnboardingEvents = useCallback(async () => {
    if (!SHOW_ONBOARDING_FUNNEL) {
      setOnboardingEvents([]);
      return;
    }

    try {
      const result = await window.electronAPI?.getOnboardingEvents?.();
      setOnboardingEvents(result || []);
    } catch (error) {
      console.error("Failed to load onboarding events:", error);
    }
  }, []);

  const funnelSummary = useMemo(() => {
    const eventTime = (name: string): Date | null => {
      const event = onboardingEvents.find((item) => item.event_name === name);
      return event ? parseOnboardingEventTimestamp(event.timestamp) : null;
    };

    const formatDuration = (ms: number): string => {
      const seconds = Math.max(1, Math.round(ms / 1000));
      if (seconds < 90) {
        return t(
          "settingsPage.account.efficiencyOverview.onboardingFunnel.summary.durationSeconds",
          {
            value: seconds,
          }
        );
      }
      const minutes = Math.round(seconds / 60);
      if (minutes < 90) {
        return t(
          "settingsPage.account.efficiencyOverview.onboardingFunnel.summary.durationMinutes",
          {
            value: minutes,
          }
        );
      }
      return t("settingsPage.account.efficiencyOverview.onboardingFunnel.summary.durationHours", {
        value: Math.round(minutes / 60),
      });
    };

    const started = eventTime("onboarding_started");
    const completed = eventTime("onboarding_completed");
    const firstDictation = eventTime("first_successful_dictation");

    const furthestEvent = [
      "step_reached:activation",
      "step_reached:permissions",
      "onboarding_started",
    ].find((name) => onboardingEvents.some((item) => item.event_name === name));
    const furthestLabel = furthestEvent
      ? t(ONBOARDING_EVENT_LABEL_KEYS[furthestEvent] || "", { defaultValue: furthestEvent })
      : "—";

    const completionLine =
      completed && started
        ? t("settingsPage.account.efficiencyOverview.onboardingFunnel.summary.completedIn", {
            duration: formatDuration(completed.getTime() - started.getTime()),
          })
        : t("settingsPage.account.efficiencyOverview.onboardingFunnel.summary.notCompleted", {
            step: furthestLabel,
          });

    const activationLine =
      firstDictation && completed
        ? t("settingsPage.account.efficiencyOverview.onboardingFunnel.summary.activatedIn", {
            duration: formatDuration(firstDictation.getTime() - completed.getTime()),
          })
        : t("settingsPage.account.efficiencyOverview.onboardingFunnel.summary.notActivated");

    return { completionLine, activationLine };
  }, [onboardingEvents, t]);

  const loadTranscriptionStats = useCallback(
    async (silent = false) => {
      try {
        if (!silent) {
          setIsLoadingStats(true);
        }

        const result = await window.electronAPI.getTranscriptionStats();
        if (hasLoadedStatsRef.current) {
          setStatsRefreshCount((count) => count + 1);
        } else {
          hasLoadedStatsRef.current = true;
        }
        setStats(result || EMPTY_STATS);
      } catch (error) {
        console.error("Failed to load transcription stats:", error);
        setStats(EMPTY_STATS);
        if (!silent) {
          toast({
            title: t("settingsPage.account.efficiencyOverview.loadErrorTitle"),
            description: t("settingsPage.account.efficiencyOverview.loadErrorDescription"),
            variant: "destructive",
          });
        }
      } finally {
        if (!silent) {
          setIsLoadingStats(false);
        }
      }
    },
    [t, toast]
  );

  useEffect(() => {
    void loadTranscriptionStats();
    if (SHOW_ONBOARDING_FUNNEL) {
      void loadOnboardingEvents();
    }
  }, [loadTranscriptionStats, loadOnboardingEvents]);

  useEffect(() => {
    if (stats.statsBackfillPending !== true) {
      return;
    }
    const refreshTimer = window.setTimeout(() => {
      void loadTranscriptionStats(true);
    }, 500);
    return () => window.clearTimeout(refreshTimer);
  }, [loadTranscriptionStats, stats.statsBackfillPending]);

  useEffect(() => {
    const electronAPI = window.electronAPI;
    const removers = [
      electronAPI?.onTranscriptionAdded?.(() => {
        void loadTranscriptionStats(true);
      }),
      electronAPI?.onTranscriptionDeleted?.(() => {
        void loadTranscriptionStats(true);
      }),
      electronAPI?.onTranscriptionsCleared?.(() => {
        void loadTranscriptionStats(true);
      }),
    ].filter(Boolean) as Array<() => void>;

    return () => {
      for (const remove of removers) {
        remove();
      }
    };
  }, [loadTranscriptionStats]);

  const shouldAnimateStats = statsRefreshCount > 0;
  const animatedDurationMs = useCountUp(stats.totalRecordingDurationMs, shouldAnimateStats);
  const animatedUnits = useCountUp(stats.totalUnits, shouldAnimateStats);
  const animatedTotalEntries = useCountUp(stats.totalEntries, shouldAnimateStats);
  const animatedTodayUnits = useCountUp(stats.todayUnits, shouldAnimateStats);
  const animatedSavedMs = useCountUp(stats.estimatedTimeSavedMs, shouldAnimateStats);
  const animatedSpeed = useCountUp(stats.averageDictationUnitsPerMinute, shouldAnimateStats);
  const completedCount = Math.max(0, Math.round(animatedTotalEntries));

  const statsCards = [
    {
      key: "completed",
      icon: CircleCheckBig,
      value: t("settingsPage.account.efficiencyOverview.cards.completed.value", {
        count: completedCount,
        formattedCount: completedCount.toLocaleString(i18n.language),
      }),
      label: t("settingsPage.account.efficiencyOverview.cards.completed.label"),
      helper: t("settingsPage.account.efficiencyOverview.cards.completed.helper", {
        duration: formatDuration(animatedDurationMs),
      }),
    },
    {
      key: "words",
      icon: Mic,
      value: `${Math.round(animatedUnits).toLocaleString(i18n.language)} ${unitLabel}`,
      label: t("settingsPage.account.efficiencyOverview.cards.words.label"),
      helper: t("settingsPage.account.efficiencyOverview.cards.words.helper", {
        total: Math.round(animatedTodayUnits).toLocaleString(i18n.language),
        unit: unitLabel,
      }),
    },
    {
      key: "saved",
      icon: Hourglass,
      value: formatDuration(animatedSavedMs, { allowSubMinute: true }),
      label: t("settingsPage.account.efficiencyOverview.cards.saved.label"),
      helper: null,
    },
    {
      key: "speed",
      icon: Zap,
      value: formatSpeed(animatedSpeed),
      label: t("settingsPage.account.efficiencyOverview.cards.speed.label"),
      helper: null,
    },
  ];

  return (
    <div className="premium-panel premium-panel--subtle space-y-4 rounded-[var(--radius-xl)] p-4">
      <div className="flex items-start justify-between gap-3 border-b border-[color:var(--ui-glass-divider)] pb-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
            {t("settingsPage.account.efficiencyOverview.title")}
          </h3>
        </div>
        <Button
          onClick={() => {
            void loadTranscriptionStats();
            if (SHOW_ONBOARDING_FUNNEL) {
              void loadOnboardingEvents();
            }
          }}
          variant="outline"
          size="sm"
          disabled={isLoadingStats}
          className="h-8 shrink-0 px-3 text-[11px]"
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isLoadingStats ? "animate-spin" : ""}`} />
          {t("common.refresh")}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {statsCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.key} className="premium-stat-card min-h-[96px] px-4 py-3">
              <div className="flex h-full items-center gap-3">
                <div className="glass-chip glass-chip--muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-[22px] font-medium leading-none tracking-tight text-foreground md:text-[24px]">
                    {card.value}
                  </div>
                  <p
                    className={`text-[11px] font-medium text-muted-foreground ${
                      card.helper ? "mt-1" : "mt-1.5"
                    }`}
                  >
                    {card.label}
                  </p>
                  {card.helper ? (
                    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/70">
                      {card.helper}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {SHOW_ONBOARDING_FUNNEL && onboardingEvents.length > 0 && (
        <div className="premium-panel premium-panel--subtle space-y-2 rounded-[var(--radius-xl)] p-4 mt-4 border border-[color:var(--ui-glass-divider)]">
          <div className="flex items-center justify-between border-b border-[color:var(--ui-glass-divider)] pb-2 mb-2">
            <h4 className="text-[13px] font-semibold text-foreground/80 tracking-tight flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              {t("settingsPage.account.efficiencyOverview.onboardingFunnel.title")}
            </h4>
            <span className="text-[10px] text-muted-foreground/70">
              {t("settingsPage.account.efficiencyOverview.onboardingFunnel.localOnly")}
            </span>
          </div>
          <div className="space-y-0.5 pb-2 text-[11px] text-foreground/75">
            <div>{funnelSummary.completionLine}</div>
            <div>{funnelSummary.activationLine}</div>
          </div>
          <div className="space-y-1.5 max-h-[150px] overflow-y-auto pr-1 select-text">
            {onboardingEvents.map((event) => (
              <div
                key={event.id}
                className="flex justify-between items-center text-[11px] py-1 border-b border-[color:var(--ui-glass-divider)]/40 last:border-b-0"
              >
                <span className="text-muted-foreground">
                  {ONBOARDING_EVENT_LABEL_KEYS[event.event_name]
                    ? t(ONBOARDING_EVENT_LABEL_KEYS[event.event_name])
                    : event.event_name}
                </span>
                <span className="text-muted-foreground/60 font-mono text-[10px]">
                  {formatOnboardingEventTimestamp(event.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
