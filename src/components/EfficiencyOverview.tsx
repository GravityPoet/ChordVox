import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { RefreshCw, Mic, Clock3, Hourglass, Zap } from "lucide-react";
import { useToast } from "./ui/Toast";
import type { TranscriptionStats } from "../types/electron";

const EMPTY_STATS: TranscriptionStats = {
  todayUnits: 0,
  totalUnits: 0,
  todayEntries: 0,
  totalEntries: 0,
  totalRecordingDurationMs: 0,
  estimatedTimeSavedMs: 0,
  averageDictationUnitsPerMinute: 0,
  lastUpdatedAt: null,
};

export default function EfficiencyOverview() {
  const { i18n } = useTranslation();
  const { toast } = useToast();
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [stats, setStats] = useState<TranscriptionStats>(EMPTY_STATS);

  const isChineseUi = i18n.language?.startsWith("zh");
  const unitLabel = isChineseUi ? "字" : "words";
  const statsTitle = isChineseUi ? "效率概览" : "Efficiency Overview";
  const statsDescription = isChineseUi
    ? "基于已保存的转录历史自动统计。"
    : "Automatically calculated from saved transcription history.";

  const formatDuration = useCallback(
    (durationMs: number, { allowSubMinute = false }: { allowSubMinute?: boolean } = {}) => {
      const safeDurationMs = Math.max(0, Math.round(Number(durationMs) || 0));
      const totalMinutes = safeDurationMs / 60000;

      if (allowSubMinute && totalMinutes > 0 && totalMinutes < 1) {
        return isChineseUi ? "< 1 分钟" : "< 1 min";
      }

      const roundedMinutes = Math.max(0, Math.round(totalMinutes));
      const hours = Math.floor(roundedMinutes / 60);
      const minutes = roundedMinutes % 60;

      if (hours > 0) {
        return isChineseUi ? `${hours} 小时 ${minutes} 分钟` : `${hours} hr ${minutes} min`;
      }
      return isChineseUi ? `${minutes} 分钟` : `${minutes} min`;
    },
    [isChineseUi]
  );

  const formatSpeed = useCallback(
    (speed: number) => {
      const safeSpeed = Math.max(0, Math.round(Number(speed) || 0));
      return isChineseUi ? `${safeSpeed} ${unitLabel}/分钟` : `${safeSpeed} ${unitLabel}/min`;
    },
    [isChineseUi, unitLabel]
  );

  const loadTranscriptionStats = useCallback(
    async (silent = false) => {
      try {
        if (!silent) {
          setIsLoadingStats(true);
        }

        const result = await window.electronAPI.getTranscriptionStats();
        setStats(result || EMPTY_STATS);
      } catch (error) {
        if (!silent) {
          toast({
            title: isChineseUi ? "无法加载字数统计" : "Couldn't load word stats",
            description: isChineseUi ? "请稍后重试。" : "Please try again in a moment.",
            variant: "destructive",
          });
        }
      } finally {
        if (!silent) {
          setIsLoadingStats(false);
        }
      }
    },
    [isChineseUi, toast]
  );

  useEffect(() => {
    void loadTranscriptionStats();
  }, [loadTranscriptionStats]);

  useEffect(() => {
    const removers = [
      window.electronAPI.onTranscriptionAdded?.(() => {
        void loadTranscriptionStats(true);
      }),
      window.electronAPI.onTranscriptionDeleted?.(() => {
        void loadTranscriptionStats(true);
      }),
      window.electronAPI.onTranscriptionsCleared?.(() => {
        void loadTranscriptionStats(true);
      }),
    ].filter(Boolean) as Array<() => void>;

    return () => {
      for (const remove of removers) {
        remove();
      }
    };
  }, [loadTranscriptionStats]);

  const statsCards = [
    {
      key: "duration",
      icon: Clock3,
      value: formatDuration(stats.totalRecordingDurationMs),
      label: isChineseUi ? "总听写时长" : "Total Dictation Time",
      helper: isChineseUi
        ? `累计已保存 ${stats.totalEntries.toLocaleString(i18n.language)} 条记录`
        : `${stats.totalEntries.toLocaleString(i18n.language)} saved in total`,
    },
    {
      key: "words",
      icon: Mic,
      value: `${stats.totalUnits.toLocaleString(i18n.language)} ${unitLabel}`,
      label: isChineseUi ? "总字数" : "Total Words",
      helper: isChineseUi
        ? `今天新增 ${stats.todayUnits.toLocaleString(i18n.language)} ${unitLabel}`
        : `${stats.todayUnits.toLocaleString(i18n.language)} ${unitLabel} today`,
    },
    {
      key: "saved",
      icon: Hourglass,
      value: formatDuration(stats.estimatedTimeSavedMs, { allowSubMinute: true }),
      label: isChineseUi ? "预计节省时间" : "Estimated Time Saved",
      helper: isChineseUi
        ? "按手动输入基准速度估算"
        : "Estimated against baseline manual typing speed",
    },
    {
      key: "speed",
      icon: Zap,
      value: formatSpeed(stats.averageDictationUnitsPerMinute),
      label: isChineseUi ? "平均听写速度" : "Average Dictation Speed",
      helper: isChineseUi ? "按累计听写时长计算" : "Calculated from total dictation time",
    },
  ];

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold tracking-tight text-foreground">{statsTitle}</h3>
          <p className="mt-0.5 text-[9px] leading-relaxed text-muted-foreground">
            {statsDescription}
          </p>
        </div>
        <Button
          onClick={() => {
            void loadTranscriptionStats();
          }}
          variant="outline"
          size="sm"
          disabled={isLoadingStats}
          className="h-7 shrink-0 px-2.5 text-[10px]"
        >
          <RefreshCw className={`mr-1 h-3 w-3 ${isLoadingStats ? "animate-spin" : ""}`} />
          {isChineseUi ? "刷新" : "Refresh"}
        </Button>
      </div>

      <div className="grid gap-1.5 md:grid-cols-2">
        {statsCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.key}
              className="rounded-lg border border-border/60 bg-card px-2.5 py-2 dark:border-border-subtle dark:bg-surface-2"
            >
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/30 text-muted-foreground">
                  <Icon className="h-[14px] w-[14px]" />
                </div>
                <div className="min-w-0">
                  <div className="text-[18px] font-semibold leading-none tracking-tight text-foreground md:text-[20px]">
                    {card.value}
                  </div>
                  <p className="mt-0.5 text-[9px] font-medium text-muted-foreground">
                    {card.label}
                  </p>
                  <p className="mt-0.5 text-[8px] leading-snug text-muted-foreground/70">
                    {card.helper}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
