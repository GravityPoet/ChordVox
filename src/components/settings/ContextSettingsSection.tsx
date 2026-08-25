import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, CheckCircle, FileText, Loader2, Monitor, Plus, Shield, X } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Toggle } from "../ui/toggle";
import { Textarea } from "../ui/textarea";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "./shared";
import MacPrivacyPermissionCard from "../ui/MacPrivacyPermissionCard";
import type {
  ContextPermissions,
  ContextSettings,
  VisionCapabilityResult,
} from "../../types/electron";
import {
  getContextBaseUrlFromStorage,
  getContextVisionProviderFromStorage,
} from "../../utils/reasoningEndpointStorage";
import modelCapabilityResolver from "../../services/ModelCapabilityResolver";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ContextSettingsSectionProps {
  contextEnabled: boolean;
  setContextEnabled: (enabled: boolean) => void;
  onOpenDictionary?: () => void;
  reasoningModel: string;
  reasoningProvider: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  openrouterApiKey: string;
  customReasoningApiKey: string;
}

type ContextToggleKey = "textEnabled" | "visionEnabled";

const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  enabled: false,
  textEnabled: false,
  visionEnabled: false,
  sensitiveApps: { bundleIds: [], processNames: [], selectedApps: [] },
};

const PERMISSION_REFRESH_INTERVAL_MS = 10_000;

const normalizeContextSettings = (
  settings: Partial<ContextSettings> | null | undefined
): ContextSettings => {
  const textEnabled = settings?.textEnabled === true;
  const visionEnabled = settings?.visionEnabled === true;

  return {
    ...DEFAULT_CONTEXT_SETTINGS,
    ...settings,
    textEnabled,
    visionEnabled,
    enabled: textEnabled || visionEnabled,
    sensitiveApps: settings?.sensitiveApps || DEFAULT_CONTEXT_SETTINGS.sensitiveApps,
  };
};

const parseSensitiveAppList = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );

const getSensitiveAppGroups = (config: ContextSettings["sensitiveApps"]) => {
  const groups = new Map<string, { appName: string; bundleIds: string[] }>();
  const add = (appNameValue: string, bundleIdValue = "") => {
    const appName = appNameValue.trim();
    const bundleId = bundleIdValue.trim();
    if (!appName) return;
    const key = appName.toLowerCase();
    const group = groups.get(key) || { appName, bundleIds: [] };
    if (bundleId && !group.bundleIds.includes(bundleId)) {
      group.bundleIds.push(bundleId);
    }
    groups.set(key, group);
  };

  for (const selection of config.selectedApps || []) {
    add(selection.appName, selection.bundleId);
  }
  for (const processName of config.processNames) {
    add(processName);
  }
  for (const bundleId of config.bundleIds) {
    const alreadyLinked = Array.from(groups.values()).some((group) =>
      group.bundleIds.includes(bundleId)
    );
    if (!alreadyLinked) {
      add(bundleId.split(".").filter(Boolean).pop() || bundleId, bundleId);
    }
  }

  return Array.from(groups.values());
};

const pruneSensitiveAppSelections = (
  config: ContextSettings["sensitiveApps"]
): ContextSettings["sensitiveApps"] => {
  const processNames = new Set(config.processNames.map((name) => name.toLowerCase()));
  const bundleIds = new Set(config.bundleIds.map((bundleId) => bundleId.toLowerCase()));
  const selectedApps = (config.selectedApps || []).filter(
    (selection) =>
      processNames.has(selection.appName.toLowerCase()) ||
      Boolean(selection.bundleId && bundleIds.has(selection.bundleId.toLowerCase()))
  );
  return { ...config, selectedApps };
};

// ─── Component ─────────────────────────────────────────────────────────────────

export function ContextSettingsSection({
  contextEnabled: _contextEnabled, // Not used directly; IPC settings are the source of truth.
  setContextEnabled: _setContextEnabled, // Not used directly; kept for existing parent API.
  onOpenDictionary,
  reasoningModel,
  reasoningProvider,
  openaiApiKey,
  anthropicApiKey,
  geminiApiKey,
  openrouterApiKey,
  customReasoningApiKey,
}: ContextSettingsSectionProps) {
  const { t } = useTranslation();
  const isMacOS = typeof window !== "undefined" && window.electronAPI?.getPlatform?.() === "darwin";

  const [contextSettings, setContextSettingsLocal] =
    useState<ContextSettings>(DEFAULT_CONTEXT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  const [permissions, setPermissions] = useState<ContextPermissions>({
    accessibility: false,
    screenRecording: false,
    platform: "unknown",
  });

  const [visionCapability, setVisionCapability] = useState<VisionCapabilityResult | null>(null);
  const [isTestingVision, setIsTestingVision] = useState(false);
  const [sensitiveAppsDraft, setSensitiveAppsDraft] = useState(
    DEFAULT_CONTEXT_SETTINGS.sensitiveApps
  );
  const [sensitiveAppsSaveState, setSensitiveAppsSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");

  const textEnabled = contextSettings.textEnabled === true;
  const visionEnabled = contextSettings.visionEnabled === true;
  const contextEnabled = textEnabled || visionEnabled;

  // ─── Load Context Settings from IPC ──────────────────────────────────────

  const loadSettings = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI?.getContextSettings) {
      setContextSettingsLocal(DEFAULT_CONTEXT_SETTINGS);
      setIsLoading(false);
      return;
    }

    try {
      const settings = normalizeContextSettings(await window.electronAPI.getContextSettings());
      const platformSettings = isMacOS
        ? settings
        : normalizeContextSettings({ ...settings, textEnabled: false, visionEnabled: false });
      setContextSettingsLocal(platformSettings);
      setSensitiveAppsDraft(settings.sensitiveApps);
    } catch (error) {
      console.error("Failed to load context settings:", error);
      setContextSettingsLocal(DEFAULT_CONTEXT_SETTINGS);
    } finally {
      setIsLoading(false);
    }
  }, [isMacOS]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // ─── Permission Checks ───────────────────────────────────────────────────

  const checkPermissions = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI?.checkContextPermissions) {
      return;
    }

    try {
      const result = await window.electronAPI.checkContextPermissions();
      setPermissions(result);
    } catch (error) {
      console.error("Failed to check context permissions:", error);
    }
  }, []);

  useEffect(() => {
    void checkPermissions();
  }, [checkPermissions]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.onMacPrivacyPermissionGranted) {
      return undefined;
    }

    return window.electronAPI.onMacPrivacyPermissionGranted(() => {
      void checkPermissions();
    });
  }, [checkPermissions]);

  // Keep macOS privacy state fresh while an enabled context layer depends on TCC.
  useEffect(() => {
    if (!isMacOS || !contextEnabled) {
      return undefined;
    }

    let cancelled = false;
    let checking = false;

    const refresh = async () => {
      if (
        cancelled ||
        checking ||
        document.visibilityState !== "visible" ||
        (typeof document.hasFocus === "function" && !document.hasFocus())
      ) {
        return;
      }
      checking = true;
      try {
        await checkPermissions();
      } finally {
        checking = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    void refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const interval = window.setInterval(refresh, PERMISSION_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(interval);
    };
  }, [checkPermissions, contextEnabled, isMacOS]);

  // ─── Settings Handlers ───────────────────────────────────────────────────

  const handleToggleContextSetting = useCallback(
    async (key: ContextToggleKey, enabled: boolean) => {
      const previousSettings = contextSettings;
      const nextSettings = normalizeContextSettings({
        ...contextSettings,
        [key]: enabled,
      });

      setContextSettingsLocal(nextSettings);

      if (typeof window === "undefined" || !window.electronAPI?.setContextSettings) {
        setContextSettingsLocal(previousSettings);
        return;
      }

      const patch = key === "textEnabled" ? { textEnabled: enabled } : { visionEnabled: enabled };

      try {
        const result = await window.electronAPI.setContextSettings(patch);
        if (!result?.success) {
          setContextSettingsLocal(previousSettings);
          console.error("Failed to save context setting:", result?.error);
        }
      } catch (error) {
        setContextSettingsLocal(previousSettings);
        console.error("Failed to save context setting:", error);
      }
    },
    [contextSettings]
  );

  const persistSensitiveApps = useCallback(async (nextConfig: ContextSettings["sensitiveApps"]) => {
    if (!window.electronAPI?.setSensitiveApps) return;
    setSensitiveAppsSaveState("saving");
    try {
      const result = await window.electronAPI.setSensitiveApps(nextConfig);
      if (!result?.success) {
        console.error("Failed to save sensitive apps:", result?.error);
        setSensitiveAppsSaveState("error");
        return;
      }
      setContextSettingsLocal((current) => ({
        ...current,
        sensitiveApps: nextConfig,
      }));
      setSensitiveAppsSaveState("saved");
    } catch (error) {
      console.error("Failed to save sensitive apps:", error);
      setSensitiveAppsSaveState("error");
    }
  }, []);

  const saveSensitiveApps = useCallback(async () => {
    const nextConfig = pruneSensitiveAppSelections(sensitiveAppsDraft);
    setSensitiveAppsDraft(nextConfig);
    await persistSensitiveApps(nextConfig);
  }, [persistSensitiveApps, sensitiveAppsDraft]);

  const chooseSensitiveApps = useCallback(async () => {
    if (!window.electronAPI?.pickSensitiveApps) return;
    setSensitiveAppsSaveState("saving");
    try {
      const result = await window.electronAPI.pickSensitiveApps({
        title: t("settingsPage.context.sensitiveAppsChoose"),
      });
      if (!result?.success) {
        console.error("Failed to choose sensitive apps:", result?.error);
        setSensitiveAppsSaveState("error");
        return;
      }
      if (result.cancelled || !result.apps?.length) {
        setSensitiveAppsSaveState("idle");
        return;
      }

      const selectedApps = [...(sensitiveAppsDraft.selectedApps || [])];
      const bundleIds = [...sensitiveAppsDraft.bundleIds];
      const processNames = [...sensitiveAppsDraft.processNames];
      for (const appSelection of result.apps) {
        const hasSelection = selectedApps.some(
          (current) =>
            (appSelection.bundleId &&
              current.bundleId.toLowerCase() === appSelection.bundleId.toLowerCase()) ||
            (!appSelection.bundleId &&
              current.appName.toLowerCase() === appSelection.appName.toLowerCase())
        );
        if (!hasSelection) selectedApps.push(appSelection);
        if (
          appSelection.bundleId &&
          !bundleIds.some(
            (current) => current.toLowerCase() === appSelection.bundleId.toLowerCase()
          )
        ) {
          bundleIds.push(appSelection.bundleId);
        }
        if (
          !processNames.some(
            (current) => current.toLowerCase() === appSelection.appName.toLowerCase()
          )
        ) {
          processNames.push(appSelection.appName);
        }
      }

      const nextConfig = { bundleIds, processNames, selectedApps };
      setSensitiveAppsDraft(nextConfig);
      await persistSensitiveApps(nextConfig);
    } catch (error) {
      console.error("Failed to choose sensitive apps:", error);
      setSensitiveAppsSaveState("error");
    }
  }, [persistSensitiveApps, sensitiveAppsDraft, t]);

  const removeSensitiveApp = useCallback(
    async (appName: string, linkedBundleIds: string[]) => {
      const normalizedName = appName.toLowerCase();
      const normalizedBundleIds = new Set(
        linkedBundleIds.map((bundleId) => bundleId.toLowerCase())
      );
      const selectedApps = (sensitiveAppsDraft.selectedApps || []).filter(
        (selection) =>
          selection.appName.toLowerCase() !== normalizedName &&
          !normalizedBundleIds.has(selection.bundleId.toLowerCase())
      );
      const nextConfig = {
        processNames: sensitiveAppsDraft.processNames.filter(
          (processName) => processName.toLowerCase() !== normalizedName
        ),
        bundleIds: sensitiveAppsDraft.bundleIds.filter(
          (bundleId) => !normalizedBundleIds.has(bundleId.toLowerCase())
        ),
        selectedApps,
      };
      setSensitiveAppsDraft(nextConfig);
      await persistSensitiveApps(nextConfig);
    },
    [persistSensitiveApps, sensitiveAppsDraft]
  );

  const sensitiveAppGroups = getSensitiveAppGroups(sensitiveAppsDraft);

  const pollPermissionsUntil = useCallback(
    async (isGranted: (result: ContextPermissions) => boolean) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const result = await window.electronAPI?.checkContextPermissions?.();
        if (result) {
          setPermissions(result);
          if (isGranted(result)) {
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    },
    []
  );

  const openAccessibilitySettings = useCallback(async () => {
    if (typeof window === "undefined") return;

    await window.electronAPI?.requestAccessibilityPermission?.();
    if (window.electronAPI?.openAccessibilitySettings) {
      const result = await window.electronAPI.openAccessibilitySettings();
      if (result?.success !== false) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        await window.electronAPI?.showMacPrivacyDragHelper?.({
          title: t("settingsPage.permissions.macAccessibilityDrag.title"),
          description: t("settingsPage.permissions.macAccessibilityDrag.description"),
          dragLabel: t("settingsPage.permissions.macAccessibilityDrag.dragLabel"),
          dragHint: t("settingsPage.permissions.macAccessibilityDrag.dragCardHint"),
          revealLabel: t("settingsPage.permissions.macAccessibilityDrag.openAccessibility"),
          unavailableLabel: t("settingsPage.permissions.macAccessibilityDrag.packagedOnly"),
          grantedLabel: t("settingsPage.permissions.macAccessibilityDrag.grantedLabel"),
          closeLabel: t("common.close"),
        });
      }
    }

    await pollPermissionsUntil((result) => result.accessibility);
  }, [pollPermissionsUntil, t]);

  const openScreenRecordingSettings = useCallback(async () => {
    if (typeof window === "undefined") return;

    await window.electronAPI?.requestScreenRecordingPermission?.();
    if (window.electronAPI?.openScreenRecordingSettings) {
      const result = await window.electronAPI.openScreenRecordingSettings();
      if (result?.success !== false) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        await window.electronAPI?.showMacPrivacyDragHelper?.({
          title: t("settingsPage.permissions.macAccessibilityDrag.title"),
          description: t(
            "settingsPage.permissions.macAccessibilityDrag.screenRecordingDescription"
          ),
          dragLabel: t("settingsPage.permissions.macAccessibilityDrag.screenRecordingDragLabel"),
          dragHint: t("settingsPage.permissions.macAccessibilityDrag.dragCardHint"),
          watchPermission: "screenRecording",
          revealLabel: t("settingsPage.permissions.macAccessibilityDrag.openScreenRecording"),
          unavailableLabel: t("settingsPage.permissions.macAccessibilityDrag.packagedOnly"),
          grantedLabel: t("settingsPage.permissions.macAccessibilityDrag.grantedLabel"),
          closeLabel: t("common.close"),
        });
      }
    }
    await pollPermissionsUntil((result) => result.screenRecording);
  }, [pollPermissionsUntil, t]);

  // ─── Vision Capability Test ──────────────────────────────────────────────

  const testVisionCapability = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI?.testVisionCapability) {
      return;
    }

    setIsTestingVision(true);

    try {
      let apiKey = "";
      switch (reasoningProvider) {
        case "openai":
          apiKey = openaiApiKey;
          break;
        case "anthropic":
          apiKey = anthropicApiKey;
          break;
        case "gemini":
          apiKey = geminiApiKey;
          break;
        case "openrouter":
          apiKey = openrouterApiKey;
          break;
        case "custom":
          apiKey = customReasoningApiKey;
          break;
      }

      const contextProvider = getContextVisionProviderFromStorage(reasoningProvider);
      const baseUrl = getContextBaseUrlFromStorage(reasoningProvider) || undefined;
      const result = await window.electronAPI.testVisionCapability({
        provider: contextProvider,
        model: reasoningModel,
        baseUrl,
        apiKey,
      });

      if (result.supported) {
        modelCapabilityResolver.rememberVisionCapability({
          provider: contextProvider,
          model: reasoningModel,
          baseUrl,
        });
      }
      setVisionCapability(result);
    } catch (error) {
      console.error("Failed to test vision capability:", error);
      setVisionCapability({
        supported: false,
        provider: getContextVisionProviderFromStorage(reasoningProvider),
        model: reasoningModel,
        error: (error as Error).message,
      });
    } finally {
      setIsTestingVision(false);
    }
  }, [
    reasoningProvider,
    reasoningModel,
    openaiApiKey,
    anthropicApiKey,
    geminiApiKey,
    openrouterApiKey,
    customReasoningApiKey,
  ]);

  useEffect(() => {
    setVisionCapability(null);
  }, [reasoningModel, reasoningProvider]);

  // ─── Render Helpers ──────────────────────────────────────────────────────

  const renderPermissionBadge = (granted: boolean, label: string) => (
    <Badge variant={granted ? "success" : "warning"} className="text-[11px]">
      {label}
    </Badge>
  );

  const renderVisionStatus = () => {
    if (isTestingVision) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">{t("settingsPage.context.testingVision")}</span>
        </div>
      );
    }

    if (!visionCapability) {
      return (
        <Button variant="outline" size="sm" onClick={testVisionCapability}>
          {t("settingsPage.context.testVision")}
        </Button>
      );
    }

    if (visionCapability.supported) {
      return (
        <div className="flex items-center gap-2 text-green-600">
          <CheckCircle className="h-4 w-4" />
          <span className="text-sm">{t("settingsPage.context.visionSupported")}</span>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Monitor className="h-4 w-4" />
        <span className="text-sm">{t("settingsPage.context.visionNotSupported")}</span>
      </div>
    );
  };

  // ─── Main Render ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.9fr)] xl:items-start">
          <div className="space-y-4">
            <SectionHeader
              title={t("settingsPage.context.title")}
              description={t("settingsPage.context.description")}
            />
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="space-y-3">
                  <div className="h-5 w-48 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-full max-w-2xl animate-pulse rounded bg-muted/80" />
                  <div className="h-4 w-3/4 animate-pulse rounded bg-muted/70" />
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.9fr)] xl:items-start">
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <SectionHeader
              title={t("settingsPage.context.title")}
              description={t("settingsPage.context.description")}
            />
            {contextEnabled && (
              <div className="flex flex-wrap gap-2 sm:pt-0.5">
                {textEnabled &&
                  renderPermissionBadge(
                    permissions.accessibility,
                    t("settingsPage.context.accessibility")
                  )}
                {visionEnabled &&
                  renderPermissionBadge(
                    permissions.screenRecording,
                    t("settingsPage.context.screenRecording")
                  )}
              </div>
            )}
          </div>

          {!isMacOS && (
            <div className="glass-panel glass-panel--soft rounded-md p-3 text-sm text-muted-foreground">
              <p>{t("settingsPage.context.platformLimitation")}</p>
            </div>
          )}

          <SettingsPanel className="overflow-hidden">
            <SettingsPanelRow>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">
                      {t("settingsPage.context.enableTextContext")}
                    </span>
                  </div>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    {t("settingsPage.context.enableTextContextDescription")}
                  </p>
                </div>
                <Toggle
                  checked={textEnabled}
                  onChange={(enabled) => void handleToggleContextSetting("textEnabled", enabled)}
                  ariaLabel={t("settingsPage.context.enableTextContext")}
                  disabled={isLoading || !isMacOS}
                />
              </div>
            </SettingsPanelRow>

            <SettingsPanelRow>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">
                      {t("settingsPage.context.enableVisionContext")}
                    </span>
                  </div>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    {t("settingsPage.context.enableVisionContextDescription")}
                  </p>
                </div>
                <Toggle
                  checked={visionEnabled}
                  onChange={(enabled) => void handleToggleContextSetting("visionEnabled", enabled)}
                  ariaLabel={t("settingsPage.context.enableVisionContext")}
                  disabled={isLoading || !isMacOS}
                />
              </div>
            </SettingsPanelRow>

            {isMacOS && (
              <SettingsPanelRow>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <Shield className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="font-medium">{t("settingsPage.context.sensitiveAppsTitle")}</p>
                      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                        {t("settingsPage.context.sensitiveAppsDescription")}
                      </p>
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-center sm:w-auto"
                    disabled={sensitiveAppsSaveState === "saving"}
                    onClick={() => void chooseSensitiveApps()}
                  >
                    {sensitiveAppsSaveState === "saving" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    {t("settingsPage.context.sensitiveAppsChoose")}
                  </Button>

                  <div className="space-y-2">
                    <p className="text-[13px] font-medium text-foreground">
                      {t("settingsPage.context.sensitiveAppsSelected")}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {sensitiveAppGroups.map((appGroup) => (
                        <div
                          key={`${appGroup.appName}:${appGroup.bundleIds.join(",")}`}
                          className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2.5"
                        >
                          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                            {appGroup.appName}
                          </span>
                          <button
                            type="button"
                            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label={`${t("common.delete")} ${appGroup.appName}`}
                            onClick={() =>
                              void removeSensitiveApp(appGroup.appName, appGroup.bundleIds)
                            }
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <details className="rounded-md border border-border/45 bg-background/40 px-3 py-2.5">
                    <summary className="cursor-pointer text-[13px] font-medium text-muted-foreground">
                      {t("settingsPage.context.sensitiveAppsAdvanced")}
                    </summary>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <label className="space-y-1.5 text-[13px] font-medium">
                        <span>{t("settingsPage.context.sensitiveProcessNames")}</span>
                        <Textarea
                          value={sensitiveAppsDraft.processNames.join("\n")}
                          onChange={(event) => {
                            setSensitiveAppsSaveState("idle");
                            setSensitiveAppsDraft((current) => ({
                              ...current,
                              processNames: parseSensitiveAppList(event.target.value),
                            }));
                          }}
                          placeholder={t("settingsPage.context.sensitiveProcessNamesPlaceholder")}
                          className="min-h-24 font-mono text-xs"
                        />
                      </label>
                      <label className="space-y-1.5 text-[13px] font-medium">
                        <span>{t("settingsPage.context.sensitiveBundleIds")}</span>
                        <Textarea
                          value={sensitiveAppsDraft.bundleIds.join("\n")}
                          onChange={(event) => {
                            setSensitiveAppsSaveState("idle");
                            setSensitiveAppsDraft((current) => ({
                              ...current,
                              bundleIds: parseSensitiveAppList(event.target.value),
                            }));
                          }}
                          placeholder={t("settingsPage.context.sensitiveBundleIdsPlaceholder")}
                          className="min-h-24 font-mono text-xs"
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={sensitiveAppsSaveState === "saving"}
                        onClick={() => void saveSensitiveApps()}
                      >
                        {sensitiveAppsSaveState === "saving"
                          ? t("common.saving")
                          : t("common.save")}
                      </Button>
                    </div>
                  </details>

                  <div>
                    <p
                      className={`text-xs ${
                        sensitiveAppsSaveState === "error"
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {sensitiveAppsSaveState === "saved"
                        ? t("settingsPage.context.sensitiveAppsSaved")
                        : sensitiveAppsSaveState === "error"
                          ? t("settingsPage.context.sensitiveAppsSaveFailed")
                          : t("settingsPage.context.sensitiveAppsHint")}
                    </p>
                  </div>
                </div>
              </SettingsPanelRow>
            )}

            <SettingsPanelRow>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                    {t("settingsPage.context.dictionaryPointer")}
                  </p>
                </div>
                {onOpenDictionary && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onOpenDictionary}
                    className="w-full sm:w-auto"
                  >
                    <BookOpen className="h-3.5 w-3.5" />
                    {t("settingsPage.context.openDictionary")}
                  </Button>
                )}
              </div>
            </SettingsPanelRow>

            {isMacOS && contextEnabled && (
              <SettingsPanelRow>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{t("settingsPage.context.permissions")}</span>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    {textEnabled && (
                      <MacPrivacyPermissionCard
                        icon={Shield}
                        title={t("settingsPage.context.accessibilityPermission")}
                        description={t("settingsPage.context.accessibilityPermissionDescription")}
                        granted={permissions.accessibility}
                        openSettingsLabel={t(
                          "settingsPage.permissions.macAccessibilityDrag.openSettings"
                        )}
                        dragLabel={t("settingsPage.permissions.macAccessibilityDrag.dragLabel")}
                        dragDescription={t(
                          "settingsPage.permissions.macAccessibilityDrag.description"
                        )}
                        packagedOnlyDescription={t(
                          "settingsPage.permissions.macAccessibilityDrag.packagedOnly"
                        )}
                        onOpenSettings={openAccessibilitySettings}
                      />
                    )}

                    {visionEnabled && (
                      <MacPrivacyPermissionCard
                        icon={Monitor}
                        title={t("settingsPage.context.screenRecordingPermission")}
                        description={t("settingsPage.context.screenRecordingPermissionDescription")}
                        granted={permissions.screenRecording}
                        openSettingsLabel={t(
                          "settingsPage.permissions.macAccessibilityDrag.openScreenRecording"
                        )}
                        dragLabel={t(
                          "settingsPage.permissions.macAccessibilityDrag.screenRecordingDragLabel"
                        )}
                        dragDescription={t(
                          "settingsPage.permissions.macAccessibilityDrag.screenRecordingDescription"
                        )}
                        packagedOnlyDescription={t(
                          "settingsPage.permissions.macAccessibilityDrag.packagedOnly"
                        )}
                        onOpenSettings={openScreenRecordingSettings}
                      />
                    )}
                  </div>
                </div>
              </SettingsPanelRow>
            )}

            {visionEnabled && (
              <SettingsPanelRow>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">
                      {t("settingsPage.context.visionCapability")}
                    </span>
                  </div>

                  <div className="pl-6">
                    <div className="flex items-center justify-between gap-4">
                      <span className="min-w-0 text-sm">
                        {t("settingsPage.context.currentModel")}:{" "}
                        {reasoningModel || t("settingsPage.context.notSelected")}
                      </span>
                      {renderVisionStatus()}
                    </div>

                    {visionCapability && !visionCapability.supported && (
                      <p className="mt-2 text-[13px] text-muted-foreground">
                        {visionCapability.error
                          ? t("settingsPage.context.visionTestFailed", {
                              reason: visionCapability.error,
                            })
                          : t("settingsPage.context.visionNotSupportedHint")}
                      </p>
                    )}
                  </div>
                </div>
              </SettingsPanelRow>
            )}
          </SettingsPanel>
        </div>
      </div>
    </div>
  );
}

export default ContextSettingsSection;
