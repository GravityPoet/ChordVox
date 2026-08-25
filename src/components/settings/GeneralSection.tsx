import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Download, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import type { AlertDialogState, ConfirmDialogState } from "../../hooks/useDialogs";
import type { DictationCueStyle, RecordingAnimationStyle } from "../../hooks/useSettings";
import { normalizeRecordingAnimationStyle } from "../../utils/recordingAnimationStyle";
import { FlowingLine } from "../capsule/FlowingLine";
import { NebulaCluster } from "../capsule/NebulaCluster";
import { Stardust } from "../capsule/Stardust";
import { getNebulaLightAmplitude } from "../capsule/useCapsuleAmplitude";
import MicrophoneSettings from "../ui/MicrophoneSettings";
import LanguageSelector, { type LanguageOption } from "../ui/LanguageSelector";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "../ui/SettingsSection";
import { cn } from "../lib/utils";
import { MetricCard, SectionCard } from "./shared";
import { buildLocalizedUpdateDescription } from "../../utils/updateReleaseNotes";

type ThemeValue = "light" | "dark" | "auto";

const SHOW_TAIL_COMMANDS_SETTING = false;
const SHOW_PASTE_CONFIRM_SETTING = false;

function NebulaOrbPreview() {
  return (
    <div className="nebula-orb-preview">
      <div className="nebula-orb-preview__stage">
        <NebulaCluster />
      </div>
    </div>
  );
}

const PREVIEW_WAVES: Record<
  RecordingAnimationStyle,
  ComponentType<{ level: number; state: "recording" }>
> = {
  flow: FlowingLine,
  stardust: Stardust,
  nebula: NebulaOrbPreview,
};

/** Mini live preview of the floating-bar recording animation.
    Drives the real wave components with a synthetic speech-like level. */
function RecordingAnimationPreview({ style }: { style: RecordingAnimationStyle }) {
  const [level, setLevel] = useState(0.35);
  const envelopeRef = useRef(0.35);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLevel(0.35);
      return;
    }
    let raf = 0;
    let last = 0;
    const start = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 33) return; // ~30fps is plenty for a preview
      last = now;
      const t = (now - start) / 1000;
      // Speech-like range: mostly mid-quiet with brief peaks. The live amp
      // rarely exceeds ~0.6, so don't let the demo pin brightness/scale at max.
      const v =
        0.34 +
        0.2 * Math.sin(t * 2.2) +
        0.13 * Math.sin(t * 5.1 + 1.2) +
        0.08 * Math.sin(t * 11 + 0.6);
      const target = Math.min(0.78, Math.max(0.06, v));
      // Attack/release envelope mirroring useCapsuleAmplitude, otherwise the
      // raw 30fps steps strobe the glow layers.
      const prev = envelopeRef.current;
      envelopeRef.current = prev + (target - prev) * (target > prev ? 0.5 : 0.2);
      setLevel(envelopeRef.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const Wave = PREVIEW_WAVES[style] ?? FlowingLine;
  // The live capsule drives --dv-amp via useCapsuleAmplitude; the preview has
  // no mic, so feed the synthetic level in directly or amp-reactive layers
  // (orbit rings, comets, core flare) stay frozen at their quiet state.
  const ampStyle = {
    "--dv-amp": level.toFixed(3),
    "--dv-amp-soft": (level * 0.6 + 0.4).toFixed(3),
    "--dv-nebula-light-amp": getNebulaLightAmplitude(level).toFixed(3),
  } as CSSProperties;
  return (
    <div
      className="recording-anim-preview mt-3"
      data-style={style}
      style={ampStyle}
      aria-hidden="true"
    >
      {style === "nebula" ? (
        <Wave level={level} state="recording" />
      ) : (
        <div className="recording-anim-preview__capsule">
          <Wave level={level} state="recording" />
        </div>
      )}
    </div>
  );
}

type UpdateStatusSummary = {
  isDevelopment: boolean;
  updateDownloaded: boolean;
};

type UpdateInfoSummary = {
  version?: string;
  releaseNotes?: string;
} | null;

type CheckForUpdatesResult = {
  updateAvailable?: boolean;
  manualOnly?: boolean;
  manualDownloadUrl?: string | null;
  version?: string;
  releaseNotes?: string | null;
  error?: string;
} | void;

export interface GeneralSectionProps {
  theme: ThemeValue;
  setTheme: (theme: ThemeValue) => void;
  uiLanguage: string;
  setUiLanguage: (language: string) => Promise<unknown> | void;
  uiLanguageOptions: LanguageOption[];
  preferredLanguage: string;
  updateTranscriptionSettings: (
    updates: Partial<{ preferredLanguage: string }>
  ) => Promise<unknown> | void;
  selectedCueStyleValue: DictationCueStyle;
  handleDictationCueStyleChange: (value: string) => void;
  recordingAnimationStyle: RecordingAnimationStyle;
  setRecordingAnimationStyle: (style: RecordingAnimationStyle) => void;
  autoStartEnabled: boolean;
  handleAutoStartChange: (checked: boolean) => Promise<unknown> | void;
  autoStartLoading: boolean;
  trayIconEnabled: boolean;
  handleTrayIconChange: (checked: boolean) => Promise<unknown> | void;
  trayIconLoading: boolean;
  autoCheckUpdateEnabled: boolean;
  handleAutoCheckUpdateChange: (checked: boolean) => Promise<unknown> | void;
  autoCheckUpdateLoading: boolean;
  currentVersion: string;
  isUpdateAvailable: boolean;
  checkingForUpdates: boolean;
  downloadingUpdate: boolean;
  installInitiated: boolean;
  updateInfo: UpdateInfoSummary;
  updateDownloadProgress: number;
  updateStatus: UpdateStatusSummary;
  manualUpdateUrl: string;
  isManualUpdate: boolean;
  formattedUpdateLastCheckedAt: string;
  checkForUpdates: () => Promise<CheckForUpdatesResult>;
  downloadUpdate: () => Promise<unknown>;
  installUpdateAction: () => Promise<unknown>;
  showConfirmDialog: (options: Omit<ConfirmDialogState, "open">) => void;
  showAlertDialog: (options: Omit<AlertDialogState, "open">) => void;
  platform: string;
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  setPreferBuiltInMic: (value: boolean) => void;
  setSelectedMicDeviceId: (value: string) => void;
  fileTranscriptionCompletionAlertEnabled: boolean;
  setFileTranscriptionCompletionAlertEnabled: (value: boolean) => void;
  pasteConfirmEnabled: boolean;
  setPasteConfirmEnabled: (value: boolean) => void;
  pasteConfirmThreshold: number;
  setPasteConfirmThreshold: (value: number) => void;
  tailCommandsEnabled: boolean;
  setTailCommandsEnabled: (value: boolean) => void;
}

export function GeneralSection({
  theme,
  setTheme,
  uiLanguage,
  setUiLanguage,
  uiLanguageOptions,
  preferredLanguage,
  updateTranscriptionSettings,
  selectedCueStyleValue,
  handleDictationCueStyleChange,
  recordingAnimationStyle,
  setRecordingAnimationStyle,
  autoStartEnabled,
  handleAutoStartChange,
  autoStartLoading,
  trayIconEnabled,
  handleTrayIconChange,
  trayIconLoading,
  autoCheckUpdateEnabled,
  handleAutoCheckUpdateChange,
  autoCheckUpdateLoading,
  currentVersion,
  isUpdateAvailable,
  checkingForUpdates,
  downloadingUpdate,
  installInitiated,
  updateInfo,
  updateDownloadProgress,
  updateStatus,
  manualUpdateUrl,
  isManualUpdate,
  checkForUpdates,
  downloadUpdate,
  installUpdateAction,
  showConfirmDialog,
  showAlertDialog,
  platform,
  preferBuiltInMic,
  selectedMicDeviceId,
  setPreferBuiltInMic,
  setSelectedMicDeviceId,
  fileTranscriptionCompletionAlertEnabled,
  setFileTranscriptionCompletionAlertEnabled,
  pasteConfirmEnabled,
  setPasteConfirmEnabled,
  pasteConfirmThreshold,
  setPasteConfirmThreshold,
  tailCommandsEnabled,
  setTailCommandsEnabled,
}: GeneralSectionProps) {
  const { i18n, t } = useTranslation();
  const languageSectionRef = useRef<HTMLDivElement | null>(null);
  const appearanceSectionRef = useRef<HTMLDivElement | null>(null);

  const themeOptions = [
    {
      value: "light",
      icon: Sun,
      label: t("settingsPage.general.appearance.light"),
    },
    {
      value: "dark",
      icon: Moon,
      label: t("settingsPage.general.appearance.dark"),
    },
    {
      value: "auto",
      icon: Monitor,
      label: t("settingsPage.general.appearance.auto"),
    },
  ] as const;

  const dictationCueStyleOptions = useMemo(
    () => [
      { value: "off" as const, label: t("settingsPage.general.soundEffects.cueStyles.off") },
      {
        value: "electronic" as const,
        label: t("settingsPage.general.soundEffects.cueStyles.electronic"),
      },
      {
        value: "droplet1" as const,
        label: t("settingsPage.general.soundEffects.cueStyles.droplet1"),
      },
      {
        value: "droplet2" as const,
        label: t("settingsPage.general.soundEffects.cueStyles.droplet2"),
      },
    ],
    [t]
  );

  const recordingAnimationOptions = useMemo(
    () => [
      {
        value: "flow" as const,
        label: t("settingsPage.general.floatingIcon.animationStyles.flow"),
      },
      {
        value: "stardust" as const,
        label: t("settingsPage.general.floatingIcon.animationStyles.stardust"),
      },
      {
        value: "nebula" as const,
        label: t("settingsPage.general.floatingIcon.animationStyles.nebula"),
      },
    ],
    [t]
  );

  const selectedThemeOption =
    themeOptions.find((option) => option.value === theme) ?? themeOptions[2];
  const updateSummary = updateStatus.isDevelopment
    ? t("settingsPage.general.updates.devMode")
    : isUpdateAvailable
      ? t("settingsPage.general.updates.newVersionAvailable")
      : t("settingsPage.general.updates.latestVersion");

  const scrollToSection = useCallback((sectionRef: RefObject<HTMLDivElement | null>) => {
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const handleCheckUpdates = useCallback(async () => {
    try {
      const result = await checkForUpdates();
      if (result && result.updateAvailable) {
        const updateDescription = buildLocalizedUpdateDescription({
          t,
          language: i18n.resolvedLanguage || i18n.language || uiLanguage,
          version: result.version || t("settingsPage.general.updates.newVersion"),
          releaseNotes: result.releaseNotes || updateInfo?.releaseNotes,
        });
        if (result.manualOnly && result.manualDownloadUrl) {
          const manualDownloadUrl = result.manualDownloadUrl;
          showConfirmDialog({
            title: t("settingsPage.general.updates.dialogs.manualUpdateAvailable.title"),
            description: updateDescription,
            confirmText: t(
              "settingsPage.general.updates.dialogs.manualUpdateAvailable.confirmText"
            ),
            onConfirm: async () => {
              try {
                const openResult = await window.electronAPI.openExternal(manualDownloadUrl);
                if (!openResult?.success) {
                  throw new Error(openResult?.error || "Could not open the update page");
                }
              } catch {
                showAlertDialog({
                  title: t("settingsPage.general.updates.dialogs.downloadFailed.title"),
                  description: t("settingsPage.general.updates.dialogs.downloadFailed.description"),
                });
              }
            },
          });
        } else {
          showConfirmDialog({
            title: t("settingsPage.general.updates.dialogs.updateAvailable.title"),
            description: updateDescription,
            confirmText: t("settingsPage.general.updates.downloadUpdate", {
              version: result.version || "",
            }),
            onConfirm: async () => {
              try {
                await downloadUpdate();
              } catch {
                showAlertDialog({
                  title: t("settingsPage.general.updates.dialogs.downloadFailed.title"),
                  description: t("settingsPage.general.updates.dialogs.downloadFailed.description"),
                });
              }
            },
          });
        }
      } else if (result && result.error) {
        showAlertDialog({
          title: t("settingsPage.general.updates.dialogs.checkFailed.title"),
          description: t("settingsPage.general.updates.dialogs.checkFailed.description"),
        });
      } else {
        showAlertDialog({
          title: t("settingsPage.general.updates.dialogs.noUpdates.title"),
          description: t("settingsPage.general.updates.dialogs.noUpdates.description"),
        });
      }
    } catch {
      showAlertDialog({
        title: t("settingsPage.general.updates.dialogs.noUpdates.title"),
        description: t("settingsPage.general.updates.dialogs.noUpdates.description"),
      });
    }
  }, [
    checkForUpdates,
    downloadUpdate,
    i18n.language,
    i18n.resolvedLanguage,
    showAlertDialog,
    showConfirmDialog,
    t,
    uiLanguage,
    updateInfo?.releaseNotes,
  ]);

  const handleUpdateDownload = useCallback(async () => {
    try {
      if (isManualUpdate && manualUpdateUrl) {
        const openResult = await window.electronAPI.openExternal(manualUpdateUrl);
        if (!openResult?.success) {
          throw new Error(openResult?.error || "Could not open the update page");
        }
      } else {
        await downloadUpdate();
      }
    } catch {
      showAlertDialog({
        title: t("settingsPage.general.updates.dialogs.downloadFailed.title"),
        description: t("settingsPage.general.updates.dialogs.downloadFailed.description"),
      });
    }
  }, [downloadUpdate, isManualUpdate, manualUpdateUrl, showAlertDialog, t]);

  return (
    <div className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_340px]">
        <section className="settings-overview-hero premium-panel premium-panel--hero flow-border shimmer-on-mount px-5 py-4 sm:px-6 sm:py-5">
          <span className="border-beam" aria-hidden />
          <div className="grid gap-3 md:grid-cols-2">
            <MetricCard
              icon={RefreshCw}
              eyebrow={t("settingsPage.general.updates.title")}
              value={currentVersion || t("settingsPage.general.updates.versionPlaceholder")}
              label={updateSummary}
              tone={isUpdateAvailable ? "accent" : "default"}
              onClick={updateStatus.isDevelopment ? undefined : () => void handleCheckUpdates()}
              ariaLabel={t("settingsPage.general.updates.checkForUpdates")}
              disabled={checkingForUpdates}
            />
            <MetricCard
              icon={selectedThemeOption.icon}
              eyebrow={t("settingsPage.general.appearance.theme")}
              value={selectedThemeOption.label}
              valueClassName="text-[20px] tracking-normal"
              label={t("settingsPage.general.appearance.themeDescription")}
              tone="accent"
              onClick={() => scrollToSection(appearanceSectionRef)}
              ariaLabel={t("settingsPage.general.appearance.title")}
            />
          </div>

          {/* Dev builds can't check or install updates — hide the action row
              instead of rendering permanently disabled (gray) controls. */}
          <div className={updateStatus.isDevelopment ? "hidden" : "mt-5 flex flex-wrap gap-3"}>
            <Button
              onClick={() => void handleCheckUpdates()}
              disabled={checkingForUpdates}
              variant="outline"
              size="lg"
              className="min-w-[11.5rem] rounded-[var(--radius-lg)] border-primary/35 bg-[var(--ui-glass-chip-accent-bg)] px-5 text-[14px] font-semibold text-primary shadow-[var(--ui-glass-panel-shadow-hover)] hover:border-primary/55 hover:bg-[var(--ui-glass-chip-selected-bg)]"
            >
              <RefreshCw size={17} className={checkingForUpdates ? "animate-spin" : ""} />
              {checkingForUpdates
                ? t("settingsPage.general.updates.checking")
                : t("settingsPage.general.updates.checkForUpdates")}
            </Button>

            {isUpdateAvailable && !updateStatus.updateDownloaded ? (
              <Button
                onClick={() => void handleUpdateDownload()}
                disabled={downloadingUpdate}
                variant="success"
                size="sm"
              >
                <Download
                  size={13}
                  className={`mr-1.5 ${downloadingUpdate ? "animate-pulse" : ""}`}
                />
                {isManualUpdate
                  ? t("settingsPage.general.updates.openReleasePage")
                  : downloadingUpdate
                    ? t("settingsPage.general.updates.downloading", {
                        progress: Math.round(updateDownloadProgress),
                      })
                    : t("settingsPage.general.updates.downloadUpdate", {
                        version: updateInfo?.version || "",
                      })}
              </Button>
            ) : null}

            {updateStatus.updateDownloaded ? (
              <Button
                onClick={() => {
                  showConfirmDialog({
                    title: t("settingsPage.general.updates.dialogs.installUpdate.title"),
                    description: t(
                      "settingsPage.general.updates.dialogs.installUpdate.description",
                      {
                        version: updateInfo?.version || "",
                      }
                    ),
                    confirmText: t(
                      "settingsPage.general.updates.dialogs.installUpdate.confirmText"
                    ),
                    onConfirm: async () => {
                      try {
                        await installUpdateAction();
                      } catch {
                        showAlertDialog({
                          title: t("settingsPage.general.updates.dialogs.installFailed.title"),
                          description: t(
                            "settingsPage.general.updates.dialogs.installFailed.description"
                          ),
                        });
                      }
                    },
                  });
                }}
                disabled={installInitiated}
                size="sm"
              >
                <RefreshCw
                  size={13}
                  className={`mr-1.5 ${installInitiated ? "animate-spin" : ""}`}
                />
                {installInitiated
                  ? t("settingsPage.general.updates.restarting")
                  : t("settingsPage.general.updates.installAndRestart")}
              </Button>
            ) : null}
          </div>
        </section>

        <div className="space-y-5">
          <SectionCard title={t("settingsPage.general.soundEffects.title")}>
            <div className="grid gap-3">
              <div className="premium-panel premium-panel--subtle rounded-[var(--radius-lg)] px-4 py-4">
                <SettingsRow
                  label={t("settingsPage.general.soundEffects.dictationSounds")}
                  description={t("settingsPage.general.soundEffects.dictationSoundsDescription")}
                >
                  <Select
                    value={selectedCueStyleValue}
                    onValueChange={handleDictationCueStyleChange}
                  >
                    <SelectTrigger className="w-[196px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {dictationCueStyleOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
              </div>

              <div className="premium-panel premium-panel--subtle rounded-[var(--radius-lg)] px-4 py-4">
                <SettingsRow
                  label={t("settingsPage.general.floatingIcon.recordingAnimation")}
                  description={t("settingsPage.general.floatingIcon.recordingAnimationDescription")}
                >
                  <Select
                    value={recordingAnimationStyle}
                    onValueChange={(value) =>
                      setRecordingAnimationStyle(normalizeRecordingAnimationStyle(value))
                    }
                  >
                    <SelectTrigger className="w-[196px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {recordingAnimationOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
                <RecordingAnimationPreview style={recordingAnimationStyle} />
              </div>

              <div className="premium-panel premium-panel--subtle rounded-[var(--radius-lg)] px-4 py-4">
                <SettingsRow
                  label={t("settingsPage.general.notifications.fileTranscriptionCompletion")}
                  description={t(
                    "settingsPage.general.notifications.fileTranscriptionCompletionDescription"
                  )}
                >
                  <Toggle
                    checked={fileTranscriptionCompletionAlertEnabled}
                    onChange={setFileTranscriptionCompletionAlertEnabled}
                    ariaLabel={t("settingsPage.general.notifications.fileTranscriptionCompletion")}
                  />
                </SettingsRow>
              </div>
              {SHOW_TAIL_COMMANDS_SETTING && (
                <div className="premium-panel premium-panel--subtle rounded-[var(--radius-lg)] px-4 py-4">
                  <SettingsRow
                    label={t("settingsPage.general.tailCommands.label")}
                    description={t("settingsPage.general.tailCommands.description")}
                  >
                    <Toggle
                      checked={tailCommandsEnabled}
                      onChange={setTailCommandsEnabled}
                      ariaLabel={t("settingsPage.general.tailCommands.label")}
                    />
                  </SettingsRow>
                </div>
              )}

              {SHOW_PASTE_CONFIRM_SETTING && (
                <div className="premium-panel premium-panel--subtle rounded-[var(--radius-lg)] px-4 py-4 flex flex-col gap-3">
                  <SettingsRow
                    label={t("settingsPage.general.pasteConfirm.label")}
                    description={t("settingsPage.general.pasteConfirm.description")}
                  >
                    <Toggle
                      checked={pasteConfirmEnabled}
                      onChange={setPasteConfirmEnabled}
                      ariaLabel={t("settingsPage.general.pasteConfirm.label")}
                    />
                  </SettingsRow>

                  {pasteConfirmEnabled && (
                    <div className="flex items-center justify-between border-t border-border/20 pt-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[13px] font-medium text-foreground">
                          {t("settingsPage.general.pasteConfirm.thresholdLabel")}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {t("settingsPage.general.pasteConfirm.thresholdDescription")}
                        </span>
                      </div>
                      <input
                        type="number"
                        name="pasteConfirmThreshold"
                        value={pasteConfirmThreshold}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          setPasteConfirmThreshold(Number.isNaN(val) ? 300 : Math.max(1, val));
                        }}
                        min={1}
                        aria-label={t("settingsPage.general.pasteConfirm.thresholdLabel")}
                        className="h-8 w-20 rounded-md border border-border/50 bg-background/60 px-2 text-[12px] text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </SectionCard>

          <div ref={languageSectionRef}>
            <SectionCard
              title={t("settings.language.sectionTitle")}
              description={t("settings.language.sectionDescription")}
            >
              <div className="grid gap-3">
                <div className="premium-panel premium-panel--subtle rounded-[var(--radius-lg)] px-4 py-4">
                  <SettingsRow
                    label={t("settings.language.uiLabel")}
                    description={t("settings.language.uiDescription")}
                  >
                    <LanguageSelector
                      value={uiLanguage}
                      onChange={(value) => {
                        void setUiLanguage(value);
                      }}
                      options={uiLanguageOptions}
                      className="min-w-36"
                    />
                  </SettingsRow>
                </div>
                <div className="premium-panel premium-panel--subtle rounded-[var(--radius-lg)] px-4 py-4">
                  <SettingsRow
                    label={t("settings.language.transcriptionLabel")}
                    description={t("settings.language.transcriptionDescription")}
                  >
                    <LanguageSelector
                      value={preferredLanguage}
                      onChange={(value) => {
                        void updateTranscriptionSettings({ preferredLanguage: value });
                      }}
                    />
                  </SettingsRow>
                </div>
              </div>
            </SectionCard>
          </div>

          <div ref={appearanceSectionRef}>
            <SectionCard
              title={t("settingsPage.general.appearance.title")}
              description={t("settingsPage.general.appearance.description")}
            >
              <div className="grid gap-3">
                {themeOptions.map((option) => {
                  const Icon = option.icon;
                  const isSelected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      onClick={() => setTheme(option.value)}
                      className={cn(
                        "premium-option-card flex w-full items-center gap-4 px-4 py-4 text-left",
                        isSelected && "premium-option-card--active"
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
                          isSelected
                            ? "glass-chip glass-chip--accent text-primary"
                            : "glass-chip glass-chip--muted text-muted-foreground"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-semibold text-foreground">{option.label}</p>
                        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground/75">
                          {t("settingsPage.general.appearance.themeDescription")}
                        </p>
                      </div>
                      {isSelected ? <Badge variant="success">{option.label}</Badge> : null}
                    </button>
                  );
                })}
              </div>
            </SectionCard>
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <SectionCard title={t("settingsPage.general.startup.title")}>
          <div className="divide-y divide-[color:var(--ui-glass-divider)]">
            {platform === "darwin" ? (
              <div className="py-1">
                <SettingsRow
                  label={t("settingsPage.general.startup.menuBarIcon")}
                  description={t("settingsPage.general.startup.menuBarIconDescription")}
                >
                  <Toggle
                    checked={trayIconEnabled}
                    onChange={(checked: boolean) => {
                      void handleTrayIconChange(checked);
                    }}
                    ariaLabel={t("settingsPage.general.startup.menuBarIcon")}
                    disabled={trayIconLoading}
                  />
                </SettingsRow>
              </div>
            ) : null}

            {platform !== "linux" ? (
              <div className="py-4">
                <SettingsRow
                  label={t("settingsPage.general.startup.launchAtLogin")}
                  description={t("settingsPage.general.startup.launchAtLoginDescription")}
                >
                  <Toggle
                    checked={autoStartEnabled}
                    onChange={(checked: boolean) => {
                      void handleAutoStartChange(checked);
                    }}
                    ariaLabel={t("settingsPage.general.startup.launchAtLogin")}
                    disabled={autoStartLoading}
                  />
                </SettingsRow>
              </div>
            ) : null}

            <div className="pt-4">
              <SettingsRow
                label={t("settingsPage.general.startup.autoCheckUpdate")}
                description={t("settingsPage.general.startup.autoCheckUpdateDescription")}
              >
                <Toggle
                  checked={autoCheckUpdateEnabled}
                  onChange={(checked: boolean) => {
                    void handleAutoCheckUpdateChange(checked);
                  }}
                  ariaLabel={t("settingsPage.general.startup.autoCheckUpdate")}
                  disabled={autoCheckUpdateLoading}
                />
              </SettingsRow>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title={t("settingsPage.general.microphone.title")}
          description={t("settingsPage.general.microphone.description")}
        >
          <MicrophoneSettings
            preferBuiltInMic={preferBuiltInMic}
            selectedMicDeviceId={selectedMicDeviceId}
            onPreferBuiltInChange={setPreferBuiltInMic}
            onDeviceSelect={setSelectedMicDeviceId}
          />
        </SectionCard>
      </div>
    </div>
  );
}
